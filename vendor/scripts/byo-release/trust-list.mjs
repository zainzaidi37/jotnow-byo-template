import { Buffer } from 'node:buffer';
import { TextDecoder } from 'node:util';
import { stableJson } from './manifest.mjs';

export const TRUST_LIST_SCHEMA_VERSION = 1;
export const TRUST_LIST_ALGORITHM = 'minisign-ed25519-blake2b512';

const KEY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const UTF8 = new TextDecoder('utf-8', { fatal: true });
const MAX_TRUST_LIST_BYTES = 1024 * 1024;
const MAX_TRUSTED_KEYS = 64;
const PUBLIC_KEY_ALGORITHM = Buffer.from('Ed', 'ascii');

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

export function decodeCanonicalBase64(value, expectedLength, label) {
  if (
    typeof value !== 'string' ||
    value.length === 0 ||
    value.length % 4 !== 0 ||
    !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)
  ) {
    throw new Error(`${label} must be canonical base64`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length !== expectedLength || bytes.toString('base64') !== value) {
    throw new Error(`${label} has an invalid encoded length`);
  }
  return bytes;
}

export function parseMinisignPublicKey(value, label = 'public key') {
  const packet = decodeCanonicalBase64(value, 42, label);
  if (!packet.subarray(0, 2).equals(PUBLIC_KEY_ALGORITHM)) {
    throw new Error(`${label} must use the minisign Ed public-key format`);
  }
  return Object.freeze({
    encoded: value,
    internalKeyId: packet.subarray(2, 10),
    publicKey: packet.subarray(10, 42),
  });
}

export function validateTrustList(value) {
  exactKeys(value, ['schemaVersion', 'algorithm', 'keys'], 'trust list');
  if (value.schemaVersion !== TRUST_LIST_SCHEMA_VERSION) throw new Error('unsupported trust-list schema');
  if (value.algorithm !== TRUST_LIST_ALGORITHM) throw new Error('unsupported trust-list algorithm');
  if (!Array.isArray(value.keys) || value.keys.length === 0 || value.keys.length > MAX_TRUSTED_KEYS) {
    throw new Error(`trust list must contain between 1 and ${MAX_TRUSTED_KEYS} keys`);
  }

  const ids = new Set();
  const internalIds = new Set();
  const publicKeys = new Set();
  const normalizedKeys = value.keys.map((entry, index) => {
    exactKeys(entry, ['id', 'publicKey'], `trust list key ${index}`);
    if (typeof entry.id !== 'string' || !KEY_ID.test(entry.id)) throw new Error(`trust list key ${index} has an invalid id`);
    if (ids.has(entry.id)) throw new Error(`duplicate trust-list key id: ${entry.id}`);
    ids.add(entry.id);
    const parsed = parseMinisignPublicKey(entry.publicKey, `trust list key ${entry.id}`);
    const internalId = parsed.internalKeyId.toString('hex');
    const publicKey = parsed.publicKey.toString('hex');
    if (internalIds.has(internalId)) throw new Error(`duplicate minisign internal key id: ${internalId}`);
    if (publicKeys.has(publicKey)) throw new Error(`duplicate minisign public key for id: ${entry.id}`);
    internalIds.add(internalId);
    publicKeys.add(publicKey);
    return Object.freeze({ id: entry.id, publicKey: entry.publicKey });
  });
  return Object.freeze({
    schemaVersion: TRUST_LIST_SCHEMA_VERSION,
    algorithm: TRUST_LIST_ALGORITHM,
    keys: Object.freeze(normalizedKeys),
  });
}

export function trustListBytes(value) {
  return Buffer.from(`${stableJson(validateTrustList(value))}\n`, 'utf8');
}

export function parseTrustList(input) {
  if (typeof input !== 'string' && !ArrayBuffer.isView(input)) return validateTrustList(input);
  const inputLength = typeof input === 'string' ? Buffer.byteLength(input, 'utf8') : input.byteLength;
  if (inputLength > MAX_TRUST_LIST_BYTES) throw new Error('serialized trust list is too large');
  const originalBytes = typeof input === 'string'
    ? Buffer.from(input, 'utf8')
    : Buffer.from(input.buffer, input.byteOffset, input.byteLength);
  let source;
  try {
    source = typeof input === 'string' ? input : UTF8.decode(input);
  } catch {
    throw new Error('trust list must be valid UTF-8');
  }
  let value;
  try {
    value = JSON.parse(source);
  } catch {
    throw new Error('trust list must be valid JSON');
  }
  const normalized = validateTrustList(value);
  if (!originalBytes.equals(trustListBytes(normalized))) {
    throw new Error('serialized trust list must use canonical encoding');
  }
  return normalized;
}

export function resolveTrustedKey(trustList, id) {
  const trusted = parseTrustList(trustList);
  if (typeof id !== 'string' || !KEY_ID.test(id)) throw new Error('manifest signing key id is invalid');
  const entry = trusted.keys.find((key) => key.id === id);
  if (!entry) throw new Error(`manifest signing key is not trusted: ${id}`);
  return Object.freeze({ ...entry, ...parseMinisignPublicKey(entry.publicKey) });
}
