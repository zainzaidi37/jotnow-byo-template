import { Buffer } from 'node:buffer';
import { createHash, randomBytes } from 'node:crypto';
import { stableJson } from '../byo-release/manifest.mjs';

const LICENSE_ORIGIN = 'https://api.lemonsqueezy.com';
const MAX_BODY = 256 * 1024;
const INSTANCE_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const FINGERPRINT = /^[a-f0-9]{64}$/;
const INTENT_ID = /^[a-f0-9]{32}$/;

function fail(message) {
  return new Error(message);
}

async function boundedJson(response) {
  if (!response?.ok) throw fail('license operation was refused');
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && declared > MAX_BODY) throw fail('license response is invalid');
  const reader = response.body?.getReader?.();
  if (!reader) throw fail('license response is invalid');
  const chunks = [];
  let size = 0;
  for (let reads = 0; reads < 256; reads++) {
    const { done, value } = await reader.read();
    if (done) {
      try {
        return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
      } catch {
        throw fail('license response is invalid');
      }
    }
    if (!value.byteLength) continue;
    size += value.byteLength;
    if (size > MAX_BODY) throw fail('license response is invalid');
    chunks.push(Buffer.from(value));
  }
  throw fail('license response is invalid');
}

async function request(fetchImpl, path, fields, timeoutMs, { allowNotFound = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetchImpl(`${LICENSE_ORIGIN}${path}`, {
      method: 'POST',
      redirect: 'error',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams(fields).toString(),
      signal: controller.signal,
    });
    if (allowNotFound && response?.status === 404) {
      try {
        await response.body?.cancel?.();
      } catch {
        // The status is the only trusted field on this response.
      }
      return null;
    }
    return await boundedJson(response);
  } catch {
    throw fail('license operation failed');
  } finally {
    clearTimeout(timer);
  }
}

function validLicenseKey(licenseKey) {
  if (typeof licenseKey !== 'string' || licenseKey.length < 8 || licenseKey.length > 512) {
    throw fail('license key is invalid');
  }
  return licenseKey;
}

export function licenseFingerprint(licenseKey) {
  return createHash('sha256').update(validLicenseKey(licenseKey), 'utf8').digest('hex');
}

export function instanceConfigBytes(value) {
  const expected = [
    'schemaVersion',
    'status',
    'phase',
    'intentId',
    'licenseFingerprint',
    'instanceId',
    'instanceName',
    'storeId',
    'productId',
  ];
  const validState =
    (value?.status === 'linking' &&
      value.phase === 'activation_pending' &&
      value.instanceId === null) ||
    (value?.status === 'linking' &&
      ['activation_confirmed', 'activation_compensated'].includes(value.phase) &&
      INSTANCE_ID.test(value.instanceId)) ||
    (value?.status === 'linked' &&
      value.phase === 'active' &&
      INSTANCE_ID.test(value.instanceId)) ||
    (value?.status === 'unlinking' &&
      ['deactivation_pending', 'deactivation_authorized', 'deactivation_confirmed'].includes(
        value.phase,
      ) &&
      INSTANCE_ID.test(value.instanceId));
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).sort().join('\0') !== expected.sort().join('\0') ||
    value.schemaVersion !== 2 ||
    !validState ||
    !INTENT_ID.test(value.intentId) ||
    !FINGERPRINT.test(value.licenseFingerprint) ||
    typeof value.instanceName !== 'string' ||
    value.instanceName.length < 1 ||
    value.instanceName.length > 128 ||
    !Number.isSafeInteger(value.storeId) ||
    !Number.isSafeInteger(value.productId)
  ) {
    throw fail('license instance configuration is invalid');
  }
  return Buffer.from(`${stableJson(value)}\n`);
}

export function createLinkingIntent({ licenseKey, instanceName, expected }) {
  if (typeof instanceName !== 'string' || instanceName.length < 1) {
    throw fail('license instance name is invalid');
  }
  const intentId = randomBytes(16).toString('hex');
  const ownedInstanceName = `${instanceName.slice(0, 115)}-${intentId.slice(0, 12)}`;
  const intent = {
    schemaVersion: 2,
    status: 'linking',
    phase: 'activation_pending',
    intentId,
    licenseFingerprint: licenseFingerprint(licenseKey),
    instanceId: null,
    instanceName: ownedInstanceName,
    storeId: expected.storeId,
    productId: expected.productId,
  };
  instanceConfigBytes(intent);
  return Object.freeze(intent);
}

export function assertIntentLicense(config, licenseKey) {
  instanceConfigBytes(config);
  if (config.licenseFingerprint !== licenseFingerprint(licenseKey)) {
    throw fail('license key does not own the durable lifecycle intent');
  }
  return config;
}

function projectInstance(config, status, phase, instanceId = config.instanceId) {
  const next = { ...config, status, phase, instanceId };
  instanceConfigBytes(next);
  return Object.freeze(next);
}

export const confirmedLink = (config, instanceId) =>
  projectInstance(config, 'linking', 'activation_confirmed', instanceId);
export const compensatedLink = (config) =>
  projectInstance(config, 'linking', 'activation_compensated');
export const activeLink = (config) => projectInstance(config, 'linked', 'active');
export const pendingUnlink = (config) =>
  projectInstance(config, 'unlinking', 'deactivation_pending');
export const authorizedUnlink = (config) =>
  projectInstance(config, 'unlinking', 'deactivation_authorized');
export const confirmedUnlink = (config) =>
  projectInstance(config, 'unlinking', 'deactivation_confirmed');

export async function activateLicense({
  licenseKey,
  instanceName,
  expected,
  existing,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}) {
  validLicenseKey(licenseKey);
  if (
    existing?.status !== 'linking' ||
    existing.phase !== 'activation_pending' ||
    existing.instanceId !== null
  ) {
    throw fail('durable linking intent is required before activation');
  }
  assertIntentLicense(existing, licenseKey);
  if (
    existing.instanceName !== instanceName ||
    existing.storeId !== expected.storeId ||
    existing.productId !== expected.productId
  ) {
    throw fail('linking intent does not match this product');
  }
  const availability = await validateLicenseAvailability({
    licenseKey,
    config: existing,
    fetchImpl,
    timeoutMs,
  });
  if (availability.status !== 'available') {
    throw fail('license activation requires explicit recovery of the existing activation');
  }
  const body = await request(
    fetchImpl,
    '/v1/licenses/activate',
    { license_key: licenseKey, instance_name: instanceName },
    timeoutMs,
  );
  if (
    body?.activated !== true ||
    body.error !== null ||
    body?.license_key?.key !== licenseKey ||
    body.license_key.status !== 'active' ||
    !Number.isSafeInteger(body.license_key.activation_usage) ||
    body.license_key.activation_usage < 1
  ) {
    throw fail('license activation was refused');
  }
  if (body?.meta?.store_id !== expected.storeId || body.meta.product_id !== expected.productId) {
    throw fail('license activation does not match this product');
  }
  if (typeof body.instance?.id !== 'string' || body.instance.name !== instanceName) {
    throw fail('license activation response is ambiguous');
  }
  return confirmedLink(existing, body.instance.id);
}

function matchingLicense(body, licenseKey, config) {
  return (
    body?.license_key?.key === licenseKey &&
    body?.meta?.store_id === config.storeId &&
    body.meta.product_id === config.productId
  );
}

export async function validateLicenseAvailability({
  licenseKey,
  config,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}) {
  assertIntentLicense(config, licenseKey);
  const body = await request(
    fetchImpl,
    '/v1/licenses/validate',
    { license_key: licenseKey },
    timeoutMs,
  );
  if (
    body?.valid !== true ||
    body.error !== null ||
    !matchingLicense(body, licenseKey, config) ||
    body.instance !== null ||
    !Number.isSafeInteger(body.license_key.activation_usage) ||
    body.license_key.activation_usage < 0
  ) {
    throw fail('license availability validation was ambiguous');
  }
  const usage = body.license_key.activation_usage;
  if (
    (usage === 0 && body.license_key.status !== 'inactive') ||
    (usage > 0 && body.license_key.status !== 'active')
  ) {
    throw fail('license availability validation was ambiguous');
  }
  return Object.freeze({ status: usage === 0 ? 'available' : 'occupied', activationUsage: usage });
}

export async function validateLicenseInstance({
  licenseKey,
  config,
  instanceId = config?.instanceId,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}) {
  assertIntentLicense(config, licenseKey);
  if (!INSTANCE_ID.test(instanceId)) throw fail('license instance id is invalid');
  const body = await request(
    fetchImpl,
    '/v1/licenses/validate',
    { license_key: licenseKey, instance_id: instanceId },
    timeoutMs,
    { allowNotFound: true },
  );
  if (body === null) return Object.freeze({ status: 'not_found' });
  if (!matchingLicense(body, licenseKey, config)) {
    throw fail('license validation does not match the durable lifecycle intent');
  }
  if (
    body.valid !== true ||
    body.error !== null ||
    body.license_key.status !== 'active' ||
    !Number.isSafeInteger(body.license_key.activation_usage) ||
    body.license_key.activation_usage < 1 ||
    body.instance?.id !== instanceId ||
    body.instance.name !== config.instanceName
  ) {
    throw fail('license validation was ambiguous');
  }
  return Object.freeze({ status: 'active', instanceId });
}

export async function deactivateLicense({
  licenseKey,
  config,
  fetchImpl = fetch,
  timeoutMs = 15_000,
}) {
  assertIntentLicense(config, licenseKey);
  const ownership = await validateLicenseInstance({
    licenseKey,
    config,
    fetchImpl,
    timeoutMs,
  });
  if (ownership.status === 'not_found') {
    if (config.phase !== 'deactivation_authorized') {
      throw fail('license instance ownership could not be revalidated');
    }
    const availability = await validateLicenseAvailability({
      licenseKey,
      config,
      fetchImpl,
      timeoutMs,
    });
    if (availability.status !== 'available') {
      throw fail('license deactivation outcome is ambiguous');
    }
    return Object.freeze({ status: 'already-unlinked' });
  }
  const body = await request(
    fetchImpl,
    '/v1/licenses/deactivate',
    { license_key: licenseKey, instance_id: config.instanceId },
    timeoutMs,
  );
  if (
    body?.deactivated !== true ||
    body.error !== null ||
    !matchingLicense(body, licenseKey, config) ||
    body.license_key.status !== 'inactive' ||
    !Number.isSafeInteger(body.license_key.activation_usage) ||
    body.license_key.activation_usage < 0 ||
    (body.instance !== undefined && body.instance !== null)
  ) {
    throw fail('license deactivation was refused');
  }
  return Object.freeze({ status: 'unlinked' });
}
