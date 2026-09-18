/**
 * The template's minimal trust root.
 *
 * The operator's workflow always runs `vendor/scripts/byo-updater/
 * customer-cli.mjs`, and nothing ever refreshes `vendor/` — the update
 * checkpoint stages only `.jotnow/deployment/**`. So whatever the vendored
 * bootstrap validates before it can delegate is frozen for every operator who
 * has already enrolled, and control cannot authenticate itself.
 *
 * That made the *whole* manifest schema and the *whole* durable state shape a
 * permanent floor, which is far more than the hand-off needs. This module is
 * the replacement: readers that authenticate the installed control and then
 * read only the fields the hand-off itself consumes, ignoring everything else.
 *
 * What is still enforced here, unchanged:
 *
 * - both minisign signatures, against the effective trust list taken from
 *   durable state (never from the release, never fetched);
 * - the canonical re-encoding binding — `stableJson` is generic, so a
 *   tolerantly-parsed object re-encodes to the exact signed bytes, and the
 *   equality check in `verifySignedManifest` is what proves the object in hand
 *   *is* the signed message rather than one reinterpretation of it;
 * - the trust list's own exact schema, because it is the trust anchor;
 * - the path, symlink and realpath guards, the inventory comparison and the
 *   per-file digests in `authenticateInstalledControl`.
 *
 * What is relaxed: unknown keys, top-level and nested, on both the manifest and
 * the durable state. Every field the hand-off actually reads is still
 * type-checked. Relaxing the shape gate costs no authenticity —
 * `verifySignedManifest` runs it only after both signatures have passed, on
 * bytes that are already trusted.
 *
 * `schemaVersion` is deliberately one-sided. The **manifest** is pinned to
 * `HANDOFF_MANIFEST_SCHEMA_VERSION` below and any other value — including a
 * missing one — is the loud refusal `bootstrap_manifest_schema`. That is the
 * bootstrap's only escape: it cannot be handed a tolerated range later, so a
 * meaning-changing manifest revision must strand enrolled copies by design
 * rather than have v1 semantics applied to a v2 document. The **durable
 * state's** `schemaVersion` stays tolerated, because that file is written by
 * our newer installed control on every run and a pin there would fail on every
 * update after a bump rather than once; the rule in its place is that the state
 * fields the hand-off reads never change meaning, they only gain neighbours.
 *
 * `FUNCTION_SLUG` deliberately does not appear here. A slug reaches a
 * `supabase functions deploy` argv and a package path inside the *installed
 * control*, which validates the full manifest with `validateManifest`. Nothing
 * in the hand-off touches a slug.
 */
import { Buffer } from 'node:buffer';
import { lstat } from 'node:fs/promises';
import { join } from 'node:path';
import { assertPackagePath, stableJson } from '../byo-release/manifest.mjs';
import { parseTrustList } from '../byo-release/trust-list.mjs';
import { UpdaterRefusal } from './refusal.mjs';
import {
  assertOwnedDirectory,
  authenticateInstalledControl,
  MAX_STATE_BYTES,
  readBoundedRegular,
} from './state.mjs';

/**
 * The bootstrap's own copy of the manifest schema version, deliberately not
 * imported from `manifest.mjs`: that constant belongs to whatever release is
 * being authored, this one belongs to the frozen vendored copy, and the whole
 * point is that the two can disagree.
 */
const HANDOFF_MANIFEST_SCHEMA_VERSION = 1;
const SHA256 = /^[a-f0-9]{64}$/;
const MAX_HANDOFF_TEXT = 512;
/**
 * `stableJson` recurses once per level. Both inputs here are size-bounded, but
 * bytes buy depth cheaply, and the frozen readers no longer reject an unknown
 * key before the re-encode reaches it. An explicit, iterative depth bound keeps
 * a deep document a refusal instead of a stack overflow. 64 is far past any
 * shape either document has ever had; the signed manifest reaches this only
 * after its signature has been verified, so the bound matters most for the
 * unsigned local state file.
 */
const MAX_HANDOFF_DEPTH = 64;
/**
 * Effectively the manifest byte bound restated: `verifySignedManifest` caps the
 * message at 16 MiB and the smallest possible file entry is far larger than
 * 80 bytes, so no release can approach this. It exists so the walk below is
 * bounded by a number rather than by an assumption.
 */
const MAX_HANDOFF_FILES = 200_000;

function handoffObject(value, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  return value;
}

function handoffText(value, label) {
  if (typeof value !== 'string' || value.length === 0 || value.length > MAX_HANDOFF_TEXT) {
    throw new Error(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function handoffPositiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${label} must be a positive integer`);
  }
  return value;
}

function handoffSize(value, label) {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error(`${label} must be a non-negative integer`);
  }
  return value;
}

function handoffDigest(value, label) {
  if (typeof value !== 'string' || !SHA256.test(value)) {
    throw new Error(`${label} must be a sha-256 digest`);
  }
  return value;
}

/**
 * `deepFreeze` in `signature.mjs` short-circuits on an already-frozen value, and
 * the readers here return frozen objects, so anything they pass through by
 * reference would escape it. `minimumPreviousRelease` is the only such value —
 * it is carried as the raw parse — so it is frozen here instead, keeping "the
 * authenticated manifest is deeply frozen" true on this path too. The walk is
 * bounded: `assertBoundedNesting` runs before it.
 */
function deepFreezeJson(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreezeJson(child);
    Object.freeze(value);
  }
  return value;
}

function assertBoundedNesting(value, label) {
  const pending = [[value, 0]];
  while (pending.length) {
    const [node, depth] = pending.pop();
    if (depth > MAX_HANDOFF_DEPTH) throw new Error(`${label} exceeds its nesting bound`);
    if (node === null || typeof node !== 'object') continue;
    if (Array.isArray(node)) {
      for (const child of node) pending.push([child, depth + 1]);
      continue;
    }
    for (const key of Object.keys(node)) pending.push([node[key], depth + 1]);
  }
}

/**
 * The manifest fields the hand-off consumes, and nothing else.
 *
 * `authenticateInstalledControl` needs `components.updater`, the `updater`
 * entries of `files` and `release.sequence` (through `sameControlRelease`,
 * which also compares `version`, `sourceCommit` and `clientCompatibilityEpoch`
 * against durable state). `trustedCommentForManifest` needs `version`,
 * `sequence` and `signingKeyId`. `selectInstalledControl` reads
 * `release.minimumPreviousRelease` for one null test.
 *
 * The result is narrowed, not merely accepted: the bootstrap cannot reach a
 * manifest field it never type-checked. The bytes it was parsed from remain the
 * signed ones, which is what the caller's re-encoding check establishes.
 */
export function readHandoffManifest(untrusted) {
  const manifest = handoffObject(untrusted, 'manifest');
  assertBoundedNesting(manifest, 'manifest');
  // Before anything is read out of the document, and before any control file is
  // touched. A manifest this bootstrap cannot read is refused, never
  // reinterpreted.
  if (manifest.schemaVersion !== HANDOFF_MANIFEST_SCHEMA_VERSION) {
    throw new UpdaterRefusal('bootstrap_manifest_schema');
  }
  const release = handoffObject(manifest.release, 'manifest.release');
  const components = handoffObject(manifest.components, 'manifest.components');
  if (!Array.isArray(manifest.files)) throw new Error('manifest.files must be an array');
  if (manifest.files.length > MAX_HANDOFF_FILES) {
    throw new Error('manifest.files exceeds its bound');
  }
  const updater =
    components.updater === null
      ? null
      : assertPackagePath(components.updater, 'manifest.components.updater');
  const files = [];
  for (let index = 0; index < manifest.files.length; index += 1) {
    const entry = handoffObject(manifest.files[index], `manifest.files[${index}]`);
    // Only the updater component crosses the hand-off. Every other component is
    // the installed control's business, and it validates the full manifest.
    if (entry.component !== 'updater') continue;
    files.push(
      Object.freeze({
        path: assertPackagePath(entry.path, `manifest.files[${index}].path`),
        sha256: handoffDigest(entry.sha256, `manifest.files[${index}].sha256`),
        size: handoffSize(entry.size, `manifest.files[${index}].size`),
        component: 'updater',
      }),
    );
  }
  if (updater !== null && files.length === 0) {
    throw new Error('manifest.components.updater has no files');
  }
  return Object.freeze({
    release: Object.freeze({
      version: handoffText(release.version, 'manifest.release.version'),
      sequence: handoffPositiveInteger(release.sequence, 'manifest.release.sequence'),
      sourceCommit: handoffText(release.sourceCommit, 'manifest.release.sourceCommit'),
      clientCompatibilityEpoch: handoffPositiveInteger(
        release.clientCompatibilityEpoch,
        'manifest.release.clientCompatibilityEpoch',
      ),
      signingKeyId: handoffText(release.signingKeyId, 'manifest.release.signingKeyId'),
      // Only its null-ness is read, by the initial-recovery test in
      // `selectInstalledControl`. Its contents govern release ordering, which
      // is the installed control's decision, so reading its fields here would
      // freeze a shape the bootstrap has no use for.
      minimumPreviousRelease:
        release.minimumPreviousRelease === null
          ? null
          : deepFreezeJson(
              handoffObject(
                release.minimumPreviousRelease,
                'manifest.release.minimumPreviousRelease',
              ),
            ),
    }),
    components: Object.freeze({ updater }),
    files: Object.freeze(files),
  });
}

/**
 * Paired with `readHandoffManifest`: a generic re-encode that reproduces the
 * signed bytes for anything the reader accepts. It serializes the value the
 * parse produced, never the narrowed view — the view is what the bootstrap
 * reads, the raw parse is what the signature covers.
 *
 * `adoptable` is absent, so `verifySignedManifest` will not register a result
 * read this way for trust-list adoption. Adoption needs `components.trustList`
 * and the full file list, neither of which this reader validates.
 */
export const HANDOFF_MANIFEST_READER = Object.freeze({
  validate: readHandoffManifest,
  encode: (value) => `${stableJson(value)}\n`,
});

function readHandoffReleaseRecord(value, label) {
  const record = handoffObject(value, label);
  return Object.freeze({
    version: handoffText(record.version, `${label}.version`),
    sequence: handoffPositiveInteger(record.sequence, `${label}.sequence`),
    sourceCommit: handoffText(record.sourceCommit, `${label}.sourceCommit`),
    clientCompatibilityEpoch: handoffPositiveInteger(
      record.clientCompatibilityEpoch,
      `${label}.clientCompatibilityEpoch`,
    ),
    manifestSha256: handoffDigest(record.manifestSha256, `${label}.manifestSha256`),
  });
}

/**
 * The durable state fields the hand-off consumes.
 *
 * `effectiveTrustList` keeps its exact schema: it is the trust anchor, and
 * `parseTrustList` is what makes it one. `updaterControl.directory` keeps its
 * equality with `control/<sequence>` because that is a containment check, not a
 * shape check. `mode` and `attempt.phase` become bounded strings rather than
 * closed sets — a release that adds a mode or an attempt phase must not strand
 * every operator whose vendored copy predates it.
 *
 * The keys it reads must be present. Tolerance is about keys this reader has
 * never heard of, not about inventing a default for one it needs: a missing
 * `installedRelease` read as `null` would silently change which hand-off branch
 * a stuck deployment takes.
 */
export function readHandoffState(value) {
  const state = handoffObject(value, 'updater state');
  for (const key of ['mode', 'installedRelease', 'effectiveTrustList', 'updaterControl', 'attempt'])
    if (!Object.hasOwn(state, key)) throw new Error(`updater state is missing ${key}`);
  const updaterControl =
    state.updaterControl === null
      ? null
      : (() => {
          const control = handoffObject(state.updaterControl, 'updaterControl');
          const sequence = handoffPositiveInteger(control.sequence, 'updaterControl.sequence');
          if (control.directory !== `control/${sequence}`) {
            throw new Error('updaterControl.directory must be its immutable sequence directory');
          }
          return Object.freeze({ sequence, directory: control.directory });
        })();
  const attempt =
    state.attempt === null
      ? null
      : (() => {
          const pending = handoffObject(state.attempt, 'attempt');
          return Object.freeze({
            target: readHandoffReleaseRecord(pending.target, 'attempt.target'),
            phase: handoffText(pending.phase, 'attempt.phase'),
          });
        })();
  return Object.freeze({
    mode: handoffText(state.mode, 'updater state mode'),
    installedRelease:
      state.installedRelease === null
        ? null
        : readHandoffReleaseRecord(state.installedRelease, 'installedRelease'),
    effectiveTrustList: parseTrustList(state.effectiveTrustList),
    updaterControl,
    attempt,
  });
}

/**
 * The canonical-encoding check survives the tolerant reader for the same reason
 * the manifest binding does: it re-encodes the *parsed* value, so a key this
 * reader ignored still round-trips. Dropping it would have let a state file
 * that reads one way and re-encodes another pass the bootstrap.
 */
export function parseHandoffState(input) {
  const original = Buffer.isBuffer(input)
    ? input
    : ArrayBuffer.isView(input)
      ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
      : Buffer.from(input, 'utf8');
  if (original.byteLength > MAX_STATE_BYTES) {
    throw new Error('updater state exceeds its size bound');
  }
  let parsed;
  try {
    parsed = JSON.parse(original.toString('utf8'));
  } catch {
    throw new Error('updater state must be valid JSON');
  }
  assertBoundedNesting(parsed, 'updater state');
  const view = readHandoffState(parsed);
  if (!original.equals(Buffer.from(`${stableJson(parsed)}\n`, 'utf8'))) {
    throw new Error('updater state must use canonical encoding');
  }
  return view;
}

/**
 * `FileStateStore.read` with the tolerant reader in place of `parseState`. The
 * directory guard is the same one the store applies, so an absent state file
 * still means "nothing installed" and an unsafe state directory is still a
 * refusal rather than a read.
 */
export async function readHandoffStateFile(stateDirectory) {
  const root = await assertOwnedDirectory(stateDirectory);
  const path = join(root, 'deployment-state.json');
  const stat = await lstat(path).catch(() => null);
  if (!stat) return null;
  return parseHandoffState(await readBoundedRegular(path, MAX_STATE_BYTES, 'updater state'));
}

export const HANDOFF_CONTROL_READER = Object.freeze({
  state: readHandoffState,
  manifest: HANDOFF_MANIFEST_READER,
});

export function authenticateHandoffControl({ stateDirectory, state }) {
  return authenticateInstalledControl({
    stateDirectory,
    state,
    reader: HANDOFF_CONTROL_READER,
  });
}
