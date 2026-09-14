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
  exactKeys(
    manifest,
    ['schemaVersion', 'release', 'signature', 'components', 'migrations', 'functions', 'files'],
    'manifest',
  );
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
  if (manifest.functions.join('\0') !== RELEASE_FUNCTIONS.join('\0')) {
    throw new Error('functions do not match the release function contract');
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
