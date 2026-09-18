import { createHash } from 'node:crypto';
import { lstat, readFile, readdir } from 'node:fs/promises';
import { posix, resolve, sep } from 'node:path';

export const MANIFEST_SCHEMA_VERSION = 1;

export const RELEASE_FUNCTIONS = Object.freeze([
  'delete-account',
  'recall',
  'recall-history-search',
  'embed-notes',
  'tidy-notes',
  'usage-limits',
  'mcp-api',
]);

const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
// SemVer 2.0.0 grammar, including the no-leading-zero rule for numeric core
// and prerelease identifiers and independent prerelease/build sections.
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;
const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

/**
 * A deployable Edge Function slug.
 *
 * This became security-relevant the moment `manifest.functions` stopped being
 * a frozen constant. The slug is interpolated into a `supabase functions
 * deploy <slug>` argv and into `supabase/functions/<slug>/index.ts` package
 * paths, so a name out of a signed-but-hostile manifest reaching either
 * unvalidated is an argument-injection and a traversal at once. Anchored,
 * lowercase alphanumerics with internal single hyphens only: no leading `-`
 * (so it can never be read as a flag), no `.`, `/`, `\`, whitespace, control
 * characters or Unicode, and a length bound. Deliberately narrower than what
 * Supabase would accept — the manifest boundary is the wrong place to be
 * generous.
 */
export const FUNCTION_SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_FUNCTION_SLUG_LENGTH = 64;
const MAX_FUNCTIONS = 128;

/**
 * Bounds on the reserved `extensions` region below. These are authoring-time
 * and maintainer-tooling guards; the update path verifies both signatures
 * before validation. Its only pre-signature exposure here is the bounded
 * `JSON.parse` that predates this region. Depth and node count bound the walk.
 * The final `stableJson` cost is not node-bounded because strings may be long,
 * but parsed manifest/state paths cap input bytes before parsing. The last
 * limit measures UTF-16 code units, not encoded bytes.
 */
const MAX_EXTENSIONS_DEPTH = 8;
const MAX_EXTENSIONS_NODES = 2048;
const MAX_EXTENSIONS_CODE_UNITS = 64 * 1024;

function isPlainObject(value) {
  return (
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.getPrototypeOf(value) === Object.prototype
  );
}

/**
 * The reserved must-ignore region: purely additive information that every
 * release which accepts it carries through untouched.
 *
 * The permanent compatibility gate is the operator's frozen vendored copy.
 * Before it can delegate, that copy parses durable state and authenticates the
 * installed control manifest with its own validators; control cannot
 * authenticate itself. Updates checkpoint only state/control and never refresh
 * `vendor/`.
 *
 * **Acceptance widens; emission does not move.** Nothing we build emits
 * `extensions` yet. Emission becomes safe only after every enrolled operator's
 * `vendor/` contains this validator. That is a permanent floor;
 * `minimumPreviousRelease` governs control hand-off and cannot relax it.
 *
 * The evolution rule: purely additive information goes in `extensions`, where
 * every compatible validator ignores it. Anything that changes the meaning of
 * an existing key bumps `MANIFEST_SCHEMA_VERSION` instead, because there is no
 * way for an older validator to ignore *that* safely. `extensions` is inside
 * the minisign signature like every other byte of manifest.json, so this is a
 * widening of the accepted shape, never a weakening of the signature.
 *
 * This is an authoring-time JSON-value guard. It rejects JavaScript-only
 * `undefined` and non-finite numbers, neither of which can come from
 * `JSON.parse`. `verifyPackage`'s canonical-bytes check is the authority for
 * byte identity, including accepted values such as `-0` and non-canonical
 * numeric literals or string escapes.
 */
export function assertJsonSafeExtensions(value, label = 'extensions') {
  if (!isPlainObject(value)) throw new Error(`${label} must be a plain object`);
  let nodes = 0;
  const walk = (node, depth, path) => {
    if (depth > MAX_EXTENSIONS_DEPTH) throw new Error(`${label} exceeds its nesting bound`);
    if ((nodes += 1) > MAX_EXTENSIONS_NODES) throw new Error(`${label} exceeds its size bound`);
    if (node === null || typeof node === 'string' || typeof node === 'boolean') return;
    if (typeof node === 'number') {
      if (!Number.isFinite(node)) throw new Error(`${path} must be a finite number`);
      return;
    }
    if (Array.isArray(node)) {
      for (let index = 0; index < node.length; index += 1) {
        walk(node[index], depth + 1, `${path}[${index}]`);
      }
      return;
    }
    if (!isPlainObject(node)) throw new Error(`${path} is not JSON-safe`);
    for (const key of Object.keys(node)) {
      // `__proto__` is an ordinary own key on a JSON.parse result and would
      // round-trip fine, but it stops being ordinary the moment anything
      // spreads or assigns this region. Refuse it at the boundary.
      if (key === '__proto__') throw new Error(`${path} must not carry a __proto__ key`);
      walk(node[key], depth + 1, `${path}.${key}`);
    }
  };
  walk(value, 0, label);
  if (stableJson(value).length > MAX_EXTENSIONS_CODE_UNITS) {
    throw new Error(`${label} exceeds its size bound`);
  }
  return value;
}

/**
 * `exactKeys`, plus a named set of optional keys that are permitted but never
 * required. Every optional key an older release does not know about must be a
 * must-ignore region, or this would not be safe.
 */
function exactKeysWithOptional(value, keys, optional, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const permitted = new Set(optional);
  const actual = Object.keys(value)
    .filter((key) => !permitted.has(key))
    .sort();
  const expected = [...keys].sort();
  if (actual.join('\0') !== expected.join('\0')) {
    throw new Error(`${label} keys must be exactly: ${expected.join(', ')}`);
  }
}

export function assertPackagePath(value, label = 'path') {
  const hasControlCharacter =
    typeof value === 'string' && [...value].some((character) => {
      const code = character.codePointAt(0);
      return code <= 0x1f || code === 0x7f;
    });
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.includes('\\') ||
    hasControlCharacter ||
    value.startsWith('/') ||
    value.split('/').some((part) => part === '' || part === '.' || part === '..') ||
    posix.normalize(value) !== value
  ) {
    throw new Error(`${label} is not a safe package-relative path: ${JSON.stringify(value)}`);
  }
  return value;
}

export function resolvePackagePath(root, relativePath) {
  assertPackagePath(relativePath);
  const absoluteRoot = resolve(root);
  const target = resolve(absoluteRoot, ...relativePath.split('/'));
  if (target !== absoluteRoot && !target.startsWith(`${absoluteRoot}${sep}`)) {
    throw new Error(`package path escapes root: ${relativePath}`);
  }
  return target;
}

export function stableJson(value) {
  if (Array.isArray(value)) return `[${value.map(stableJson).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value);
}

export function manifestBytes(manifest) {
  validateManifest(manifest);
  return `${stableJson(manifest)}\n`;
}

function positiveInteger(value, label) {
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`);
}

function exactKeys(value, keys, label) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const actual = Object.keys(value).sort();
  const expected = [...keys].sort();
  if (actual.join('\0') !== expected.join('\0')) {
    throw new Error(`${label} keys must be exactly: ${expected.join(', ')}`);
  }
}

export function validateManifest(manifest) {
  exactKeysWithOptional(
    manifest,
    ['schemaVersion', 'release', 'signature', 'components', 'migrations', 'functions', 'files'],
    ['extensions'],
    'manifest',
  );
  // Accepted and left exactly as found — never normalized, never stripped.
  // A validator that dropped it would change the bytes `manifestBytes` emits
  // and break the signature it was meant to preserve.
  // Unlike parsed JSON, an in-process author can supply an own undefined key.
  if (Object.hasOwn(manifest, 'extensions')) assertJsonSafeExtensions(manifest.extensions);
  if (manifest.schemaVersion !== MANIFEST_SCHEMA_VERSION) throw new Error('unsupported manifest schema');

  if (manifest.signature !== null) {
    exactKeys(manifest.signature, ['algorithm', 'path'], 'signature');
    if (manifest.signature.algorithm !== 'minisign') throw new Error('unsupported manifest signature algorithm');
    assertPackagePath(manifest.signature.path, 'signature.path');
    if (manifest.signature.path === 'manifest.json') throw new Error('signature must be detached from manifest.json');
  }

  exactKeys(
    manifest.release,
    [
      'version',
      'sequence',
      'sourceCommit',
      'clientCompatibilityEpoch',
      'signingKeyId',
      'minimumPreviousRelease',
    ],
    'release',
  );
  if (typeof manifest.release.version !== 'string' || !VERSION.test(manifest.release.version)) {
    throw new Error('release.version must be SemVer 2.0.0');
  }
  positiveInteger(manifest.release.sequence, 'release.sequence');
  positiveInteger(manifest.release.clientCompatibilityEpoch, 'release.clientCompatibilityEpoch');
  if (!COMMIT.test(manifest.release.sourceCommit)) throw new Error('release.sourceCommit must be a full lowercase commit');
  if (!KEY_ID.test(manifest.release.signingKeyId)) throw new Error('release.signingKeyId is invalid');
  const minimum = manifest.release.minimumPreviousRelease;
  if (minimum !== null) {
    exactKeys(minimum, ['version', 'sequence'], 'minimumPreviousRelease');
    if (typeof minimum.version !== 'string' || !VERSION.test(minimum.version)) {
      throw new Error('minimumPreviousRelease.version must be SemVer 2.0.0');
    }
    positiveInteger(minimum.sequence, 'minimumPreviousRelease.sequence');
    if (minimum.sequence >= manifest.release.sequence) {
      throw new Error('minimumPreviousRelease.sequence must precede release.sequence');
    }
  }

  exactKeys(
    manifest.components,
    ['web', 'migrations', 'functions', 'config', 'templates', 'trustList', 'updater'],
    'components',
  );
  const fixed = {
    web: 'dist',
    migrations: 'supabase/migrations',
    functions: 'supabase/functions',
    config: 'supabase/config.toml',
    templates: 'supabase/templates',
  };
  for (const [name, expected] of Object.entries(fixed)) {
    if (manifest.components[name] !== expected) throw new Error(`components.${name} must be ${expected}`);
  }
  for (const name of ['trustList', 'updater']) {
    if (manifest.components[name] !== null) assertPackagePath(manifest.components[name], `components.${name}`);
  }

  if (!Array.isArray(manifest.migrations) || !Array.isArray(manifest.functions)) {
    throw new Error('migrations and functions must be arrays');
  }
  const sortedMigrations = [...manifest.migrations].sort();
  if (sortedMigrations.join('\0') !== manifest.migrations.join('\0')) throw new Error('migrations must be sorted');
  for (const migration of manifest.migrations) {
    if (migration.includes('/') || !/^\d+_[A-Za-z0-9_-]+\.sql$/.test(migration)) {
      throw new Error(`invalid migration filename: ${migration}`);
    }
  }
  // A required **minimum**, not an exact set: adding a BYO Edge Function is an
  // ordinary feature, and an exact set meant the previous release's installed
  // control refused such a release before preflight ever ran. Removing a name
  // from `RELEASE_FUNCTIONS` is the other direction and is not additive — an
  // older release would still try to deploy the name it knows — so a removal
  // bumps `MANIFEST_SCHEMA_VERSION`.
  //
  // Not sorted, deliberately: `RELEASE_FUNCTIONS` is authored in a
  // non-alphabetical order and all four published releases emit exactly that
  // order, so requiring sortedness would reject every one of them.
  if (manifest.functions.length > MAX_FUNCTIONS) throw new Error('too many functions');
  const functions = new Set();
  for (const name of manifest.functions) {
    if (
      typeof name !== 'string' ||
      name.length > MAX_FUNCTION_SLUG_LENGTH ||
      !FUNCTION_SLUG.test(name)
    ) {
      throw new Error(`invalid function slug: ${JSON.stringify(name)}`);
    }
    if (functions.has(name)) throw new Error(`duplicate function slug: ${name}`);
    functions.add(name);
  }
  for (const name of RELEASE_FUNCTIONS) {
    if (!functions.has(name)) throw new Error(`release is missing required function: ${name}`);
  }

  if (!Array.isArray(manifest.files) || manifest.files.length === 0) throw new Error('files must not be empty');
  let previous = '';
  const seen = new Set();
  for (const entry of manifest.files) {
    exactKeys(entry, ['path', 'sha256', 'size', 'component'], `file ${entry?.path ?? '?'}`);
    assertPackagePath(entry.path, 'file.path');
    if (entry.path <= previous) throw new Error('files must be unique and sorted by path');
    previous = entry.path;
    if (seen.has(entry.path)) throw new Error(`duplicate file path: ${entry.path}`);
    seen.add(entry.path);
    if (!SHA256.test(entry.sha256)) throw new Error(`invalid sha256 for ${entry.path}`);
    if (!Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error(`invalid size for ${entry.path}`);
    if (!['web', 'migrations', 'functions', 'config', 'templates', 'trustList', 'updater'].includes(entry.component)) {
      throw new Error(`invalid component for ${entry.path}`);
    }
    const matchingComponents = Object.entries(manifest.components)
      .filter(([, path]) => path !== null && (entry.path === path || entry.path.startsWith(`${path}/`)))
      .map(([name]) => name);
    if (matchingComponents.length !== 1 || matchingComponents[0] !== entry.component) {
      throw new Error(`file component does not match its path: ${entry.path}`);
    }
  }
  for (const [name, path] of Object.entries(manifest.components)) {
    if (path !== null && !manifest.files.some((entry) => entry.path === path || entry.path.startsWith(`${path}/`))) {
      throw new Error(`component ${name} has no files`);
    }
  }
  return manifest;
}

export async function sha256File(path) {
  const bytes = await readFile(path);
  return { sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.byteLength };
}

export async function verifyPackage(packageRoot, manifest) {
  validateManifest(manifest);
  const expected = new Set(manifest.files.map((entry) => entry.path));
  for (const entry of manifest.files) {
    const path = resolvePackagePath(packageRoot, entry.path);
    const stat = await lstat(path).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error(`missing or unsafe package file: ${entry.path}`);
    const actual = await sha256File(path);
    if (actual.size !== entry.size || actual.sha256 !== entry.sha256) {
      throw new Error(`package file does not match manifest: ${entry.path}`);
    }
  }
  const actualPaths = [];
  async function visit(relativeDirectory = '') {
    const directory = relativeDirectory ? resolvePackagePath(packageRoot, relativeDirectory) : resolve(packageRoot);
    const entries = await readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      const relativePath = relativeDirectory ? `${relativeDirectory}/${entry.name}` : entry.name;
      assertPackagePath(relativePath);
      if (entry.isSymbolicLink()) throw new Error(`symlinks are refused: ${relativePath}`);
      if (entry.isDirectory()) await visit(relativePath);
      else if (entry.isFile()) actualPaths.push(relativePath);
      else throw new Error(`unsupported package entry: ${relativePath}`);
    }
  }
  await visit();
  actualPaths.sort();
  const allowed = [
    ...expected,
    'manifest.json',
    ...(manifest.signature === null ? [] : [manifest.signature.path]),
  ].sort();
  if (actualPaths.join('\0') !== allowed.join('\0')) throw new Error('package contains unmanifested or missing files');
  const onDiskManifest = await readFile(resolvePackagePath(packageRoot, 'manifest.json'), 'utf8');
  if (onDiskManifest !== manifestBytes(manifest)) throw new Error('manifest.json does not match the verified manifest');

  const migrationFiles = manifest.files
    .filter((entry) => entry.path.startsWith('supabase/migrations/'))
    .map((entry) => entry.path.slice('supabase/migrations/'.length));
  if (migrationFiles.join('\0') !== manifest.migrations.join('\0')) throw new Error('migration inventory does not match files');
  // Load-bearing now that `functions` is a minimum rather than a frozen
  // constant: this is what keeps an added slug *file-backed*. A name that no
  // signed, hash-verified entrypoint corresponds to cannot reach a deploy,
  // whatever else the manifest claims.
  for (const name of manifest.functions) {
    if (!expected.has(`supabase/functions/${name}/index.ts`)) throw new Error(`missing function entrypoint: ${name}`);
  }
  return expected.size;
}

export async function verifyPackageOnDisk(packageRoot) {
  const path = resolvePackagePath(packageRoot, 'manifest.json');
  const stat = await lstat(path).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink()) throw new Error('missing or unsafe manifest.json');
  let manifest;
  try {
    manifest = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new Error('manifest.json is not valid JSON');
  }
  await verifyPackage(packageRoot, manifest);
  return manifest;
}
