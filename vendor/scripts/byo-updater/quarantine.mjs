import { constants } from 'node:fs';
import { Buffer } from 'node:buffer';
import { lstat, mkdir, mkdtemp, open, readFile, realpath, rm } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';
import { TextDecoder } from 'node:util';
import { assertPackagePath, resolvePackagePath, verifyPackage } from '../byo-release/manifest.mjs';
import { verifySignedManifest } from '../byo-release/signature.mjs';
import { ReleaseIntegrityRefusal } from './applicability.mjs';

const BLOCK = 512;
const ZERO_BLOCKS = 2;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const DEFAULT_LIMITS = Object.freeze({
  maxArchiveBytes: 512 * 1024 * 1024,
  maxFileBytes: 128 * 1024 * 1024,
  maxFiles: 20_000,
  maxDirectories: 20_000,
  maxExtractedBytes: 512 * 1024 * 1024,
});

async function assertRegular(path, label) {
  const absolute = resolve(path);
  const stat = await lstat(absolute).catch(() => null);
  if (!stat?.isFile() || stat.isSymbolicLink() || (await realpath(absolute)) !== absolute) {
    throw new Error(`${label} must be a regular file with no symlink traversal`);
  }
  return { path: absolute, stat };
}

function field(header, offset, length, label) {
  const bytes = header.subarray(offset, offset + length);
  const zero = bytes.indexOf(0);
  const value = zero === -1 ? bytes : bytes.subarray(0, zero);
  if (zero !== -1 && bytes.subarray(zero).some((byte) => byte !== 0)) {
    throw new Error(`tar ${label} has nonzero bytes after its terminator`);
  }
  try {
    return UTF8.decode(value);
  } catch {
    throw new Error(`tar ${label} must be valid UTF-8`);
  }
}

function parseOctal(bytes, width, label) {
  const value = bytes.toString('latin1');
  const pattern = new RegExp(`^[0-7]{${width - 1}}\\0$`);
  if (!pattern.test(value)) throw new Error(`tar ${label} is not canonical octal`);
  const parsed = Number.parseInt(value.slice(0, -1), 8);
  if (!Number.isSafeInteger(parsed)) throw new Error(`tar ${label} is out of range`);
  return parsed;
}

function parseChecksum(header) {
  const encoded = header.subarray(148, 156).toString('latin1');
  if (!/^[0-7]{6}\0 $/.test(encoded)) throw new Error('tar checksum is not canonical');
  const expected = Number.parseInt(encoded.slice(0, 6), 8);
  const copy = Buffer.from(header);
  copy.fill(0x20, 148, 156);
  const actual = copy.reduce((sum, byte) => sum + byte, 0);
  if (actual !== expected) throw new Error('tar header checksum mismatch');
}

function parseHeader(header) {
  parseChecksum(header);
  if (!header.subarray(257, 263).equals(Buffer.from('ustar\0'))) {
    throw new Error('tar entry must use the ustar format');
  }
  if (!header.subarray(263, 265).equals(Buffer.from('00'))) {
    throw new Error('tar entry has an unsupported ustar version');
  }
  if (header[156] !== 0x30) throw new Error('tar contains a non-regular entry');
  if (header.subarray(157, 257).some((byte) => byte !== 0)) {
    throw new Error('tar regular entry must not carry link metadata');
  }
  const name = field(header, 0, 100, 'name');
  const prefix = field(header, 345, 155, 'prefix');
  const path = prefix ? `${prefix}/${name}` : name;
  assertPackagePath(path, 'tar entry path');
  const size = parseOctal(header.subarray(124, 136), 12, 'size');
  return { path, size };
}

async function readExactly(handle, buffer, position) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      position + offset,
    );
    if (bytesRead === 0) throw new Error('tar archive is truncated');
    offset += bytesRead;
  }
}

async function copyRange(source, target, sourcePosition, size) {
  const chunk = Buffer.allocUnsafe(Math.min(64 * 1024, Math.max(size, 1)));
  let copied = 0;
  while (copied < size) {
    const length = Math.min(chunk.length, size - copied);
    const { bytesRead } = await source.read(chunk, 0, length, sourcePosition + copied);
    if (bytesRead !== length) throw new Error('tar file body is truncated');
    await target.write(chunk, 0, bytesRead, copied);
    copied += bytesRead;
  }
  await target.sync();
}

export async function extractTarToQuarantine({ archive, parentDirectory, limits = {} }) {
  const knownLimits = new Set(Object.keys(DEFAULT_LIMITS));
  if (Object.keys(limits).some((name) => !knownLimits.has(name))) {
    throw new Error('unknown quarantine limit');
  }
  for (const [name, value] of Object.entries(limits)) {
    if (!Number.isSafeInteger(value) || value <= 0 || value > DEFAULT_LIMITS[name]) {
      throw new Error(`quarantine limit may only tighten its compiled ceiling: ${name}`);
    }
  }
  const bounds = { ...DEFAULT_LIMITS, ...limits };
  const source = await assertRegular(archive, 'release archive');
  if (
    source.stat.size < BLOCK * ZERO_BLOCKS ||
    source.stat.size > bounds.maxArchiveBytes ||
    source.stat.size % BLOCK !== 0
  ) {
    throw new Error('release archive size is invalid or exceeds its bound');
  }
  const parent = resolve(parentDirectory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  if ((await realpath(parent)) !== parent)
    throw new Error('quarantine parent must have no symlink traversal');
  const root = await mkdtemp(join(parent, '.release-quarantine-'));
  const archiveHandle = await open(source.path, constants.O_RDONLY | constants.O_NOFOLLOW);
  const seen = new Set();
  const seenDirectories = new Set();
  let position = 0;
  let extractedBytes = 0;
  try {
    const openedStat = await archiveHandle.stat();
    if (
      openedStat.dev !== source.stat.dev ||
      openedStat.ino !== source.stat.ino ||
      openedStat.size !== source.stat.size
    ) {
      throw new Error('release archive changed while it was opened');
    }
    while (position < source.stat.size - BLOCK * ZERO_BLOCKS) {
      const header = Buffer.alloc(BLOCK);
      await readExactly(archiveHandle, header, position);
      if (header.every((byte) => byte === 0)) {
        throw new Error('tar archive ended before the required two final zero blocks');
      }
      const entry = parseHeader(header);
      if (seen.has(entry.path)) throw new Error(`tar contains duplicate path: ${entry.path}`);
      seen.add(entry.path);
      if (seen.size > bounds.maxFiles) throw new Error('tar contains too many files');
      if (entry.size > bounds.maxFileBytes)
        throw new Error(`tar file exceeds its bound: ${entry.path}`);
      extractedBytes += entry.size;
      if (extractedBytes > bounds.maxExtractedBytes)
        throw new Error('tar extracted bytes exceed their bound');

      const targetPath = resolvePackagePath(root, entry.path);
      let parentPath = '';
      const newDirectories = [];
      for (const component of entry.path.split('/').slice(0, -1)) {
        parentPath = parentPath ? `${parentPath}/${component}` : component;
        if (!seenDirectories.has(parentPath)) newDirectories.push(parentPath);
      }
      if (seenDirectories.size + newDirectories.length > bounds.maxDirectories) {
        throw new Error('tar contains too many directories');
      }
      for (const directory of newDirectories) seenDirectories.add(directory);
      await mkdir(dirname(targetPath), { recursive: true, mode: 0o700 });
      const target = await open(
        targetPath,
        constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
        0o600,
      );
      try {
        await copyRange(archiveHandle, target, position + BLOCK, entry.size);
      } finally {
        await target.close();
      }
      const paddedSize = Math.ceil(entry.size / BLOCK) * BLOCK;
      const paddingSize = paddedSize - entry.size;
      if (paddingSize) {
        const padding = Buffer.alloc(paddingSize);
        await readExactly(archiveHandle, padding, position + BLOCK + entry.size);
        if (padding.some((byte) => byte !== 0)) throw new Error('tar file padding must be zero');
      }
      position += BLOCK + paddedSize;
      if (position > source.stat.size - BLOCK * ZERO_BLOCKS)
        throw new Error('tar file body exceeds archive');
    }
    if (position !== source.stat.size - BLOCK * ZERO_BLOCKS) {
      throw new Error('tar archive has noncanonical padding or termination');
    }
    const terminator = Buffer.alloc(BLOCK * ZERO_BLOCKS);
    await readExactly(archiveHandle, terminator, position);
    if (terminator.some((byte) => byte !== 0))
      throw new Error('tar archive has invalid termination');
    if (seen.size === 0) throw new Error('tar archive contains no files');
    return Object.freeze({ root, files: Object.freeze([...seen].sort()) });
  } catch (error) {
    await rm(root, { recursive: true, force: true });
    throw error;
  } finally {
    await archiveHandle.close();
  }
}

export async function authenticateQuarantinedPackage({ packageRoot, trustList }) {
  const root = resolve(packageRoot);
  const manifestPath = (await assertRegular(join(root, 'manifest.json'), 'release manifest')).path;
  const signaturePath = (
    await assertRegular(join(root, 'manifest.json.minisig'), 'release signature')
  ).path;
  const rawManifest = await readFile(manifestPath);
  const verified = verifySignedManifest({
    manifestBytes: rawManifest,
    signature: await readFile(signaturePath),
    trustList,
  });
  if (verified.manifest.signature?.path !== basename(signaturePath)) {
    throw new Error('signed package must use the fixed manifest.json.minisig signature path');
  }
  try {
    await verifyPackage(root, verified.manifest);
  } catch {
    throw new ReleaseIntegrityRefusal();
  }
  return Object.freeze({ verified, rawManifest });
}
