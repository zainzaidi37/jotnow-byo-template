import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';
import { TextDecoder } from 'node:util';
import { manifestBytes as canonicalManifestBytes, validateManifest } from './manifest.mjs';
import { parseTrustList, resolveTrustedKey } from './trust-list.mjs';

/**
 * How `verifySignedManifest` turns verified bytes into a manifest value.
 *
 * `validate` is a shape gate on already-trusted input: by the time it runs
 * both minisign signatures have passed, so it contributes nothing to
 * authenticity and can be relaxed without losing a guarantee. `encode` is the
 * part that cannot be relaxed. It re-serializes the *parsed* value and the
 * caller compares the result to the signed message, which is what proves the
 * value in hand is the value that was signed rather than a reinterpretation of
 * the same bytes.
 *
 * A reader is therefore only safe if `encode` is a faithful inverse of
 * `JSON.parse` over everything `validate` accepts. `stableJson` is generic —
 * it sorts `Object.keys` at every level and enumerates no fields — so a reader
 * that accepts unknown keys still re-encodes to the exact signed bytes. A
 * reader whose `encode` dropped or normalized anything `validate` accepted
 * would silently break the binding, which is the one failure this abstraction
 * must not permit.
 *
 * `adoptable` marks a reader whose result carries the whole manifest, which is
 * what `adoptTrustList` needs. A narrowing reader must leave it false: a
 * partial view would let adoption read a component list that was never
 * validated.
 */
export const STRICT_MANIFEST_READER = Object.freeze({
  validate: validateManifest,
  encode: canonicalManifestBytes,
  adoptable: true,
});

const UTF8 = new TextDecoder('utf-8', { fatal: true });
const SPKI_ED25519_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const SIGNATURE_ALGORITHM = Buffer.from('ED', 'ascii');
const VERIFIED_RELEASES = new WeakMap();
const MAX_MANIFEST_BYTES = 16 * 1024 * 1024;
const MAX_SIGNATURE_BYTES = 20 * 1024;

function bytes(value, label) {
  if (typeof value === 'string') return Buffer.from(value, 'utf8');
  if (ArrayBuffer.isView(value))
    return Buffer.from(value.buffer, value.byteOffset, value.byteLength);
  throw new Error(`${label} must be a string or byte array`);
}

function decodeText(value, label) {
  try {
    return typeof value === 'string' ? value : UTF8.decode(bytes(value, label));
  } catch {
    throw new Error(`${label} must be valid UTF-8`);
  }
}

function canonicalBase64(value, length, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`${label} must be canonical base64`);
  }
  const decoded = Buffer.from(value, 'base64');
  if (decoded.length !== length || decoded.toString('base64') !== value)
    throw new Error(`${label} has an invalid encoded length`);
  return decoded;
}

function deepFreeze(value) {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function parseMinisignSignature(input) {
  const inputLength =
    typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input?.byteLength;
  if (!Number.isSafeInteger(inputLength) || inputLength > MAX_SIGNATURE_BYTES) {
    throw new Error('minisign signature is too large');
  }
  const source = decodeText(input, 'minisign signature');
  const normalized = source.replaceAll('\r\n', '\n');
  if (normalized.includes('\r'))
    throw new Error('minisign signature contains an invalid line ending');
  const lines = normalized.split('\n');
  if (lines.at(-1) === '') lines.pop();
  if (lines.length !== 4 || lines.some((line) => line.length > 4096)) {
    throw new Error('minisign signature must contain exactly four bounded lines');
  }
  if (!lines[0].startsWith('untrusted comment: '))
    throw new Error('minisign signature has no untrusted comment');
  if (!lines[2].startsWith('trusted comment: '))
    throw new Error('minisign signature has no trusted comment');
  const signaturePacket = canonicalBase64(lines[1], 74, 'minisign signature packet');
  if (!signaturePacket.subarray(0, 2).equals(SIGNATURE_ALGORITHM)) {
    throw new Error('legacy or unknown minisign signature format is refused; expected ED');
  }
  const globalSignature = canonicalBase64(lines[3], 64, 'minisign global signature');
  const trustedComment = lines[2].slice('trusted comment: '.length);
  if (trustedComment.length === 0) throw new Error('minisign trusted comment must not be empty');
  return Object.freeze({
    internalKeyId: signaturePacket.subarray(2, 10),
    signature: signaturePacket.subarray(10, 74),
    trustedComment,
    globalSignature,
  });
}

function publicKeyObject(rawPublicKey) {
  return createPublicKey({
    key: Buffer.concat([SPKI_ED25519_PREFIX, rawPublicKey]),
    format: 'der',
    type: 'spki',
  });
}

export function trustedCommentForManifest(manifest) {
  return `kinjot release ${manifest.release.version} sequence ${manifest.release.sequence} key ${manifest.release.signingKeyId}`;
}

export function verifySignedManifest({
  manifestBytes,
  signature,
  trustList,
  reader = STRICT_MANIFEST_READER,
}) {
  const message = bytes(manifestBytes, 'manifest bytes');
  if (message.length > MAX_MANIFEST_BYTES) throw new Error('manifest is too large');
  let untrustedManifest;
  try {
    untrustedManifest = JSON.parse(UTF8.decode(message));
  } catch {
    throw new Error('manifest bytes must be valid UTF-8 JSON');
  }
  const untrustedKeyId = untrustedManifest?.release?.signingKeyId;
  const trustedKey = resolveTrustedKey(trustList, untrustedKeyId);
  const parsedSignature = parseMinisignSignature(signature);
  if (!timingSafeEqual(parsedSignature.internalKeyId, trustedKey.internalKeyId)) {
    throw new Error('minisign signature key id does not match the trusted public key');
  }
  const key = publicKeyObject(trustedKey.publicKey);
  const digest = createHash('blake2b512').update(message).digest();
  if (!verify(null, digest, key, parsedSignature.signature))
    throw new Error('manifest signature verification failed');
  const globalMessage = Buffer.concat([
    parsedSignature.signature,
    Buffer.from(parsedSignature.trustedComment, 'utf8'),
  ]);
  if (!verify(null, globalMessage, key, parsedSignature.globalSignature)) {
    throw new Error('minisign trusted-comment signature verification failed');
  }

  // Manifest fields and hashes become trusted only after both signatures pass.
  const parsedManifest = reader.validate(untrustedManifest);
  if (untrustedManifest.signature?.algorithm !== 'minisign')
    throw new Error('signed manifest must declare minisign');
  // The binding. `reader.encode` re-serializes the object the parse produced;
  // equality with the signed message is what makes the parsed value — not just
  // the bytes — authenticated. Without it a tolerant reader would accept bytes
  // whose signature covers one object while handing the caller another.
  if (!message.equals(Buffer.from(reader.encode(untrustedManifest), 'utf8'))) {
    throw new Error('signed manifest must use canonical encoding');
  }
  const expectedComment = trustedCommentForManifest(parsedManifest);
  if (parsedSignature.trustedComment !== expectedComment) {
    throw new Error('trusted comment does not describe the signed manifest');
  }
  const authenticatedManifest = deepFreeze(parsedManifest);
  const result = Object.freeze({
    manifest: authenticatedManifest,
    signingKeyId: untrustedKeyId,
    trustedComment: parsedSignature.trustedComment,
  });
  if (reader.adoptable === true) {
    VERIFIED_RELEASES.set(
      result,
      Object.freeze({
        manifest: authenticatedManifest,
        publicKey: trustedKey.encoded,
      }),
    );
  }
  return result;
}

export function adoptTrustList({ verifiedRelease, currentTrustList, candidateTrustListBytes }) {
  const authenticated =
    verifiedRelease !== null && typeof verifiedRelease === 'object'
      ? VERIFIED_RELEASES.get(verifiedRelease)
      : undefined;
  if (!authenticated) throw new Error('trust-list adoption requires an authenticated release');
  const current = parseTrustList(currentTrustList);
  const currentSigner = resolveTrustedKey(current, verifiedRelease.signingKeyId);
  if (currentSigner.encoded !== authenticated.publicKey) {
    throw new Error('current trust list did not authenticate the rotation release');
  }
  const manifest = authenticated.manifest;
  const path = manifest.components.trustList;
  if (path === null) throw new Error('authenticated release carries no trust-list component');
  const entry = manifest.files.find((file) => file.path === path && file.component === 'trustList');
  if (!entry) throw new Error('authenticated release does not bind its trust-list component');
  const candidateBytes = bytes(candidateTrustListBytes, 'candidate trust-list bytes');
  const digest = createHash('sha256').update(candidateBytes).digest('hex');
  if (candidateBytes.length !== entry.size || digest !== entry.sha256) {
    throw new Error('candidate trust list does not match the authenticated manifest');
  }
  const candidate = parseTrustList(candidateBytes);
  for (const existing of current.keys) {
    const retained = candidate.keys.find((key) => key.id === existing.id);
    if (!retained || retained.publicKey !== existing.publicKey) {
      throw new Error(`candidate trust list removes or changes trusted key: ${existing.id}`);
    }
  }
  return candidate;
}
