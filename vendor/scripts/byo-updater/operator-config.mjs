import { isAbsolute } from 'node:path';

const PROJECT_REF = /^[a-z0-9]{20}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function invalid() {
  throw new Error('invalid BYO updater operator configuration');
}

function safeExecutable(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value)) invalid();
  return value;
}

function safeUrl(value, { web = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    invalid();
  }
  if (parsed.hash || (web ? !['https:', 'http:'].includes(parsed.protocol) : false)) invalid();
  if (web && parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    invalid();
  }
  return parsed;
}

function decoded(value) {
  try {
    const result = decodeURIComponent(value);
    if (!result || /[^\x20-\x7e]/.test(result)) invalid();
    return result;
  } catch {
    invalid();
  }
}

export function databaseConnection(databaseUrl, projectRef, timeoutMs) {
  const url = safeUrl(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password) {
    invalid();
  }
  if (
    url.hash ||
    url.pathname !== '/postgres' ||
    [...url.searchParams.keys()].some((key) => key !== 'sslmode') ||
    [...url.searchParams.keys()].length > 1 ||
    (url.searchParams.has('sslmode') &&
      !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode')))
  ) {
    invalid();
  }
  const username = decoded(url.username);
  const direct = url.hostname === `db.${projectRef}.supabase.co` && username === 'postgres';
  const pooler =
    url.hostname.endsWith('.pooler.supabase.com') && username === `postgres.${projectRef}`;
  if (!direct && !pooler) invalid();
  const password = decoded(url.password);
  const passwordless = new URL(url);
  passwordless.password = '';
  // pgconn defaults to prefer (including plaintext fallback) without this URL option.
  if (!passwordless.searchParams.has('sslmode'))
    passwordless.searchParams.set('sslmode', 'require');
  return Object.freeze({
    password,
    passwordlessUrl: passwordless.toString(),
    psqlEnv: Object.freeze({
      LANG: 'C',
      LC_ALL: 'C',
      PGAPPNAME: 'jotnow-byo-updater',
      PGCONNECT_TIMEOUT: String(Math.max(1, Math.ceil(timeoutMs / 1000))),
      PGDATABASE: decoded(url.pathname.slice(1)),
      PGHOST: url.hostname,
      PGPASSWORD: password,
      PGPORT: url.port || '5432',
      PGSSLMODE: url.searchParams.get('sslmode') || 'require',
      PGUSER: username,
    }),
  });
}

export function validateOperatorConfig(value, { mode = 'full', databaseOnly = false } = {}) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) invalid();
  const {
    databaseUrl,
    projectRef,
    managementToken,
    cloudflareToken,
    cloudflareAccountId,
    pagesProject,
    pagesBranch = 'main',
    stateDirectory,
    trustListPath,
    executables,
    timeoutMs = 120_000,
  } = value;
  if (
    !['full', 'backend-only'].includes(mode) ||
    typeof databaseOnly !== 'boolean' ||
    !PROJECT_REF.test(projectRef)
  )
    invalid();
  if (
    mode === 'full' &&
    (typeof pagesProject !== 'string' ||
      !NAME.test(pagesProject) ||
      typeof pagesBranch !== 'string' ||
      !NAME.test(pagesBranch))
  )
    invalid();
  if (
    (!databaseOnly && (typeof managementToken !== 'string' || !managementToken)) ||
    (mode === 'full' && (typeof cloudflareToken !== 'string' || !cloudflareToken)) ||
    (mode === 'full' && !/^[a-f0-9]{32}$/.test(cloudflareAccountId)) ||
    typeof stateDirectory !== 'string' ||
    !isAbsolute(stateDirectory) ||
    typeof trustListPath !== 'string' ||
    !isAbsolute(trustListPath) ||
    !Number.isInteger(timeoutMs) ||
    timeoutMs < 1000 ||
    timeoutMs > 15 * 60_000
  ) {
    invalid();
  }
  if (executables === null || typeof executables !== 'object') invalid();
  return Object.freeze({
    mode,
    databaseUrl,
    projectRef,
    managementToken,
    cloudflareToken,
    cloudflareAccountId,
    pagesProject,
    pagesBranch,
    stateDirectory,
    trustListPath,
    timeoutMs,
    executables: Object.freeze({
      psql: safeExecutable(executables.psql),
      supabase: safeExecutable(executables.supabase),
      wrangler: mode === 'full' ? safeExecutable(executables.wrangler) : null,
    }),
    database: databaseConnection(databaseUrl, projectRef, timeoutMs),
  });
}
