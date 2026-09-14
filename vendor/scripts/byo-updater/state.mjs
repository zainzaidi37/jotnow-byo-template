import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import {
  copyFile,
  chmod,
  lstat,
  mkdir,
  open,
  readdir,
  realpath,
  rename,
  rmdir,
  rm,
  unlink,
} from 'node:fs/promises';
import { hostname } from 'node:os';
import { basename, dirname, join, relative, resolve, sep } from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { stableJson, resolvePackagePath, sha256File } from '../byo-release/manifest.mjs';
import { verifySignedManifest } from '../byo-release/signature.mjs';
import { parseTrustList, validateTrustList } from '../byo-release/trust-list.mjs';

export const STATE_SCHEMA_VERSION = 1;
export const ATTEMPT_PHASES = Object.freeze([
  'verified',
  'control_installed',
  'migrations_applied',
  'backend_initialized',
  'functions_deployed',
  'web_published',
]);
const MODES = new Set(['full', 'backend-only']);
const SHA256 = /^[a-f0-9]{64}$/;
const COMMIT = /^[a-f0-9]{40}$/;
const MAX_STATE_BYTES = 2 * 1024 * 1024;
const VERSION =
  /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-((?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*)(?:\.(?:0|[1-9]\d*|[0-9A-Za-z-]*[A-Za-z-][0-9A-Za-z-]*))*))?(?:\+([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?$/;

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

function releaseRecord(value, label) {
  exactKeys(
    value,
    ['version', 'sequence', 'sourceCommit', 'clientCompatibilityEpoch', 'manifestSha256'],
    label,
  );
  if (typeof value.version !== 'string' || !VERSION.test(value.version)) {
    throw new Error(`${label}.version must be SemVer 2.0.0`);
  }
  for (const field of ['sequence', 'clientCompatibilityEpoch']) {
    if (!Number.isSafeInteger(value[field]) || value[field] <= 0) {
      throw new Error(`${label}.${field} must be positive`);
    }
  }
  if (!COMMIT.test(value.sourceCommit)) throw new Error(`${label}.sourceCommit is invalid`);
  if (!SHA256.test(value.manifestSha256)) throw new Error(`${label}.manifestSha256 is invalid`);
  return Object.freeze({ ...value });
}

export function validateState(value) {
  exactKeys(
    value,
    [
      'schemaVersion',
      'mode',
      'installedRelease',
      'effectiveTrustList',
      'updaterControl',
      'attempt',
    ],
    'updater state',
  );
  if (value.schemaVersion !== STATE_SCHEMA_VERSION)
    throw new Error('unsupported updater state schema');
  if (!MODES.has(value.mode)) throw new Error('updater state mode is invalid');
  const installedRelease =
    value.installedRelease === null
      ? null
      : releaseRecord(value.installedRelease, 'installedRelease');
  const effectiveTrustList = validateTrustList(value.effectiveTrustList);
  let updaterControl = null;
  if (value.updaterControl !== null) {
    exactKeys(value.updaterControl, ['sequence', 'directory'], 'updaterControl');
    if (
      !Number.isSafeInteger(value.updaterControl.sequence) ||
      value.updaterControl.sequence <= 0
    ) {
      throw new Error('updaterControl.sequence must be positive');
    }
    if (value.updaterControl.directory !== `control/${value.updaterControl.sequence}`) {
      throw new Error('updaterControl.directory must be its immutable sequence directory');
    }
    updaterControl = Object.freeze({ ...value.updaterControl });
  }
  let attempt = null;
  if (value.attempt !== null) {
    exactKeys(value.attempt, ['target', 'phase'], 'attempt');
    if (!ATTEMPT_PHASES.includes(value.attempt.phase)) throw new Error('attempt phase is invalid');
    attempt = Object.freeze({
      target: releaseRecord(value.attempt.target, 'attempt.target'),
      phase: value.attempt.phase,
    });
  }
  return Object.freeze({
    schemaVersion: STATE_SCHEMA_VERSION,
    mode: value.mode,
    installedRelease,
    effectiveTrustList,
    updaterControl,
    attempt,
  });
}

export function stateBytes(value) {
  return Buffer.from(`${stableJson(validateState(value))}\n`, 'utf8');
}

export function parseState(input) {
  const original = Buffer.isBuffer(input)
    ? input
    : ArrayBuffer.isView(input)
      ? Buffer.from(input.buffer, input.byteOffset, input.byteLength)
      : Buffer.from(input, 'utf8');
  if (original.byteLength > MAX_STATE_BYTES)
    throw new Error('updater state exceeds its size bound');
  let parsed;
  try {
    parsed = JSON.parse(original.toString('utf8'));
  } catch {
    throw new Error('updater state must be valid JSON');
  }
  const normalized = validateState(parsed);
  if (!original.equals(stateBytes(normalized)))
    throw new Error('updater state must use canonical encoding');
  return normalized;
}

async function assertOwnedDirectory(path) {
  const root = resolve(path);
  await mkdir(root, { recursive: true, mode: 0o700 });
  const stat = await lstat(root);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(root)) !== root) {
    throw new Error('state directory must be a real directory with no symlink traversal');
  }
  return root;
}

async function syncDirectory(path) {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function readBoundedRegular(path, maximumBytes, label) {
  const before = await lstat(path).catch(() => null);
  if (!before?.isFile() || before.isSymbolicLink()) {
    throw new Error(`${label} must be a regular file with no symlink traversal`);
  }
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const opened = await handle.stat();
    if (opened.dev !== before.dev || opened.ino !== before.ino || opened.size !== before.size) {
      throw new Error(`${label} changed while it was opened`);
    }
    if (opened.size > maximumBytes) throw new Error(`${label} exceeds its size bound`);
    const bytes = Buffer.alloc(opened.size);
    let offset = 0;
    while (offset < bytes.length) {
      const { bytesRead } = await handle.read(bytes, offset, bytes.length - offset, offset);
      if (bytesRead === 0) throw new Error(`${label} changed while it was read`);
      offset += bytesRead;
    }
    const extra = Buffer.alloc(1);
    if ((await handle.read(extra, 0, 1, bytes.length)).bytesRead !== 0) {
      throw new Error(`${label} changed while it was read`);
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

export class FileStateStore {
  constructor(directory) {
    this.directory = resolve(directory);
    this.statePath = join(this.directory, 'deployment-state.json');
  }

  async initialize() {
    await assertOwnedDirectory(this.directory);
  }

  async read() {
    await this.initialize();
    const stat = await lstat(this.statePath).catch(() => null);
    if (!stat) return null;
    return parseState(await readBoundedRegular(this.statePath, MAX_STATE_BYTES, 'updater state'));
  }

  async write(value) {
    await this.initialize();
    const bytes = stateBytes(value);
    const temporary = join(this.directory, `.state-${randomBytes(16).toString('hex')}.tmp`);
    try {
      const handle = await open(
        temporary,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      const existing = await lstat(this.statePath).catch(() => null);
      if (existing && (!existing.isFile() || existing.isSymbolicLink())) {
        throw new Error('refusing to replace unsafe updater state');
      }
      await rename(temporary, this.statePath);
      await syncDirectory(this.directory);
      return validateState(value);
    } catch (error) {
      await rm(temporary, { force: true });
      throw error;
    }
  }
}

function lockRecordBytes(record) {
  return Buffer.from(`${stableJson(record)}\n`, 'utf8');
}

function ownerRecord() {
  return Object.freeze({
    schemaVersion: 1,
    token: randomBytes(16).toString('hex'),
    pid: process.pid,
    hostname: hostname(),
  });
}

async function createOwnedDirectoryLock(directory, existsMessage) {
  try {
    await mkdir(directory, { mode: 0o700 });
  } catch (error) {
    if (error?.code === 'EEXIST') throw new Error(existsMessage);
    throw error;
  }
  const record = ownerRecord();
  let ownerCreated = false;
  try {
    const handle = await open(join(directory, 'owner.json'), 'wx', 0o600);
    ownerCreated = true;
    try {
      await handle.writeFile(lockRecordBytes(record));
      await handle.sync();
    } finally {
      await handle.close();
    }
    await syncDirectory(directory);
  } catch (error) {
    if (ownerCreated) await unlink(join(directory, 'owner.json')).catch(() => {});
    await rmdir(directory).catch(() => {});
    throw error;
  }
  let released = false;
  return Object.freeze({
    record,
    async release() {
      if (released) return;
      const current = await readLock(directory);
      if (current.token !== record.token) throw new Error('lock ownership changed');
      await unlink(join(directory, 'owner.json'));
      await rmdir(directory);
      released = true;
    },
  });
}

async function refuseRecoveryInProgress(root) {
  const recoveryGuard = await lstat(join(root, 'update.lock.recovery')).catch(() => null);
  if (recoveryGuard) throw new Error('stale-lock recovery is in progress or requires recovery');
}

async function readLock(directory) {
  const path = join(directory, 'owner.json');
  let bytes;
  try {
    bytes = await readBoundedRegular(path, 1024, 'update lock owner record');
  } catch {
    throw new Error('update lock has no valid owner record');
  }
  let record;
  try {
    record = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('update lock owner record is invalid');
  }
  exactKeys(record, ['schemaVersion', 'token', 'pid', 'hostname'], 'update lock owner');
  if (
    record.schemaVersion !== 1 ||
    typeof record.token !== 'string' ||
    !/^[a-f0-9]{32}$/.test(record.token) ||
    !Number.isSafeInteger(record.pid) ||
    record.pid <= 0 ||
    typeof record.hostname !== 'string' ||
    record.hostname.length === 0 ||
    record.hostname.length > 255
  ) {
    throw new Error('update lock owner record is invalid');
  }
  return Object.freeze(record);
}

export async function acquireUpdateLock(stateDirectory) {
  const root = await assertOwnedDirectory(stateDirectory);
  await refuseRecoveryInProgress(root);
  const lockDirectory = join(root, 'update.lock');
  const lock = await createOwnedDirectoryLock(
    lockDirectory,
    'another update holds the deployment lock',
  );
  try {
    await refuseRecoveryInProgress(root);
  } catch (error) {
    await lock.release();
    throw error;
  }
  return lock;
}

function localOwnerStatus(record) {
  if (record.hostname !== hostname()) return 'remote';
  try {
    process.kill(record.pid, 0);
    return 'live';
  } catch (error) {
    return error?.code === 'ESRCH' ? 'dead' : 'live';
  }
}

export async function recoverStaleLock({ stateDirectory, confirmation, proveOwnerDead }) {
  const root = await assertOwnedDirectory(stateDirectory);
  const recovery = await createOwnedDirectoryLock(
    join(root, 'update.lock.recovery'),
    'another stale-lock recovery is in progress or requires recovery',
  );
  const lockDirectory = join(root, 'update.lock');
  try {
    const record = await readLock(lockDirectory);
    if (confirmation !== `RECOVER ${record.token}`)
      throw new Error('stale-lock recovery confirmation is invalid');
    const ownerStatus = localOwnerStatus(record);
    if (ownerStatus === 'live') throw new Error('a live local process owns the update lock');
    const provenDead =
      ownerStatus === 'dead' ||
      (ownerStatus === 'remote' && (await proveOwnerDead?.(record)) === true);
    if (!provenDead) throw new Error('lock owner is live or its death was not established');
    const current = await readLock(lockDirectory);
    if (current.token !== record.token) throw new Error('update lock changed during recovery');
    await unlink(join(lockDirectory, 'owner.json'));
    await rmdir(lockDirectory);
    await syncDirectory(root);
    return record;
  } finally {
    await recovery.release();
  }
}

async function ensureOwnedControlDirectory(root) {
  const control = join(root, 'control');
  try {
    await mkdir(control, { mode: 0o700 });
  } catch (error) {
    if (error?.code !== 'EEXIST') throw error;
  }
  const stat = await lstat(control);
  if (!stat.isDirectory() || stat.isSymbolicLink() || (await realpath(control)) !== control) {
    throw new Error('updater control directory must be a real directory with no symlink traversal');
  }
  return control;
}

async function listFiles(root) {
  const files = [];
  async function visit(directory) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      const rel = relative(root, path).split(sep).join('/');
      if (entry.isSymbolicLink()) throw new Error(`control source contains a symlink: ${rel}`);
      if (entry.isDirectory()) await visit(path);
      else if (entry.isFile()) files.push(rel);
      else throw new Error(`control source contains an unsupported entry: ${rel}`);
    }
  }
  await visit(root);
  return files.sort();
}

export async function installImmutableControl({ stateDirectory, packageRoot, manifest }) {
  const root = await assertOwnedDirectory(stateDirectory);
  const controlRoot = await ensureOwnedControlDirectory(root);
  const component = manifest.components.updater;
  if (typeof component !== 'string') throw new Error('release has no updater control component');
  const entries = manifest.files.filter((entry) => entry.component === 'updater');
  if (entries.length === 0) throw new Error('release updater control component is empty');
  if (entries.some((entry) => !entry.path.startsWith(`${component}/`))) {
    throw new Error('updater file is outside its component');
  }
  const destination = join(controlRoot, String(manifest.release.sequence));
  const authentication = [
    { rel: 'manifest.json', source: resolvePackagePath(packageRoot, 'manifest.json') },
    {
      rel: 'manifest.json.minisig',
      source: resolvePackagePath(packageRoot, 'manifest.json.minisig'),
    },
  ];
  const authenticationDigests = new Map();
  for (const file of authentication)
    authenticationDigests.set(file.rel, await sha256File(file.source));

  async function matchesExisting() {
    const stat = await lstat(destination).catch(() => null);
    if (!stat) return false;
    if (!stat.isDirectory() || stat.isSymbolicLink())
      throw new Error('existing updater control is unsafe');
    const expected = [
      ...entries.map((entry) => entry.path.slice(`${component}/`.length)),
      ...authentication.map((file) => file.rel),
    ].sort();
    if ((await listFiles(destination)).join('\0') !== expected.join('\0')) {
      throw new Error('immutable updater control differs from the authenticated release');
    }
    for (const entry of entries) {
      const rel = entry.path.slice(`${component}/`.length);
      const digest = await sha256File(resolvePackagePath(destination, rel));
      if (digest.sha256 !== entry.sha256 || digest.size !== entry.size) {
        throw new Error('immutable updater control differs from the authenticated release');
      }
    }
    for (const file of authentication) {
      const digest = await sha256File(resolvePackagePath(destination, file.rel));
      const expectedDigest = authenticationDigests.get(file.rel);
      if (digest.sha256 !== expectedDigest.sha256 || digest.size !== expectedDigest.size) {
        throw new Error('immutable updater control differs from the authenticated release');
      }
    }
    return true;
  }

  if (await matchesExisting()) {
    return Object.freeze({
      sequence: manifest.release.sequence,
      directory: `control/${manifest.release.sequence}`,
    });
  }
  const temporary = join(
    dirname(destination),
    `.${basename(destination)}-${randomBytes(16).toString('hex')}`,
  );
  await mkdir(temporary, { mode: 0o700 });
  try {
    for (const entry of entries) {
      if (!entry.path.startsWith(`${component}/`))
        throw new Error('updater file is outside its component');
      const rel = entry.path.slice(`${component}/`.length);
      const source = resolvePackagePath(packageRoot, entry.path);
      const target = resolvePackagePath(temporary, rel);
      await mkdir(dirname(target), { recursive: true, mode: 0o700 });
      await copyFile(source, target, constants.COPYFILE_EXCL);
      await chmod(target, 0o444);
      const targetHandle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await targetHandle.sync();
      } finally {
        await targetHandle.close();
      }
      await syncDirectory(dirname(target));
    }
    for (const file of authentication) {
      const target = resolvePackagePath(temporary, file.rel);
      await copyFile(file.source, target, constants.COPYFILE_EXCL);
      await chmod(target, 0o444);
      const handle = await open(target, constants.O_RDONLY | constants.O_NOFOLLOW);
      try {
        await handle.sync();
      } finally {
        await handle.close();
      }
    }
    await syncDirectory(temporary);
    await rename(temporary, destination);
    await syncDirectory(dirname(destination));
  } catch (error) {
    await rm(temporary, { recursive: true, force: true });
    if (error?.code === 'EEXIST' && (await matchesExisting())) {
      return Object.freeze({
        sequence: manifest.release.sequence,
        directory: `control/${manifest.release.sequence}`,
      });
    }
    throw error;
  }
  return Object.freeze({
    sequence: manifest.release.sequence,
    directory: `control/${manifest.release.sequence}`,
  });
}

function sameControlRelease(target, manifest, manifestSha256) {
  const release = manifest.release;
  return (
    target?.version === release.version &&
    target?.sequence === release.sequence &&
    target?.sourceCommit === release.sourceCommit &&
    target?.clientCompatibilityEpoch === release.clientCompatibilityEpoch &&
    target?.manifestSha256 === manifestSha256
  );
}

export async function authenticateInstalledControl({ stateDirectory, state }) {
  const validated = validateState(state);
  const control = validated.updaterControl;
  if (!control) throw new Error('deployment has no installed updater control');
  const root = resolve(stateDirectory, control.directory);
  const stateRoot = resolve(stateDirectory);
  if (dirname(root) !== join(stateRoot, 'control'))
    throw new Error('installed updater control path is invalid');
  const stat = await lstat(root).catch(() => null);
  if (!stat?.isDirectory() || stat.isSymbolicLink() || (await realpath(root)) !== root) {
    throw new Error('installed updater control directory is unsafe');
  }
  const rawManifest = await readBoundedRegular(
    join(root, 'manifest.json'),
    16 * 1024 * 1024,
    'installed control manifest',
  );
  const signature = await readBoundedRegular(
    join(root, 'manifest.json.minisig'),
    20 * 1024,
    'installed control signature',
  );
  const authenticated = verifySignedManifest({
    manifestBytes: rawManifest,
    signature,
    trustList: validated.effectiveTrustList,
  });
  const manifestSha256 = createHash('sha256').update(rawManifest).digest('hex');
  const target =
    validated.attempt?.target.sequence === control.sequence
      ? validated.attempt.target
      : validated.installedRelease?.sequence === control.sequence
        ? validated.installedRelease
        : null;
  if (!sameControlRelease(target, authenticated.manifest, manifestSha256)) {
    throw new Error('installed updater control does not match durable release state');
  }
  const component = authenticated.manifest.components.updater;
  if (typeof component !== 'string') throw new Error('installed release has no updater control');
  const entries = authenticated.manifest.files.filter((entry) => entry.component === 'updater');
  const expected = [
    ...entries.map((entry) => entry.path.slice(`${component}/`.length)),
    'manifest.json',
    'manifest.json.minisig',
  ].sort();
  if ((await listFiles(root)).join('\0') !== expected.join('\0')) {
    throw new Error('installed updater control inventory differs from its authenticated manifest');
  }
  for (const entry of entries) {
    if (!entry.path.startsWith(`${component}/`))
      throw new Error('installed updater file is outside its component');
    const digest = await sha256File(
      resolvePackagePath(root, entry.path.slice(`${component}/`.length)),
    );
    if (digest.sha256 !== entry.sha256 || digest.size !== entry.size) {
      throw new Error('installed updater control differs from its authenticated manifest');
    }
  }
  return Object.freeze({ manifest: authenticated.manifest, root });
}

export function initialState({ mode, trustList }) {
  return validateState({
    schemaVersion: STATE_SCHEMA_VERSION,
    mode,
    installedRelease: null,
    effectiveTrustList: parseTrustList(trustList),
    updaterControl: null,
    attempt: null,
  });
}
