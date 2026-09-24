import { isAbsolute } from 'node:path';
import { UpdaterRefusal } from './refusal.mjs';

const PROJECT_REF = /^[a-z0-9]{20}$/;
const NAME = /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/;

function invalid() {
  throw new Error('invalid BYO updater operator configuration');
}

function safeExecutable(value) {
  if (typeof value !== 'string' || !isAbsolute(value) || /[\0\r\n]/.test(value)) invalid();
  return value;
}

// Database URLs only, which is why every refusal here names `KINJOT_DATABASE_URL`.
// `databaseConnection` is the sole caller and the `web` branch has none today. A
// future web-URL caller needs its own reason rather than this one's copy.
function safeUrl(value, { web = false } = {}) {
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw new UpdaterRefusal('database_url_invalid');
  }
  if (parsed.hash || (web ? !['https:', 'http:'].includes(parsed.protocol) : false))
    throw new UpdaterRefusal('database_url_invalid');
  if (web && parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname)) {
    throw new UpdaterRefusal('database_url_invalid');
  }
  return parsed;
}

function decoded(value) {
  try {
    const result = decodeURIComponent(value);
    if (!result || /[^\x20-\x7e]/.test(result)) throw new UpdaterRefusal('database_url_invalid');
    return result;
  } catch {
    throw new UpdaterRefusal('database_url_invalid');
  }
}

export function databaseConnection(databaseUrl, projectRef, timeoutMs) {
  if (databaseUrl === undefined || databaseUrl === null || databaseUrl === '') {
    throw new UpdaterRefusal('database_url_missing');
  }
  const url = safeUrl(databaseUrl);
  if (!['postgres:', 'postgresql:'].includes(url.protocol) || !url.username || !url.password) {
    throw new UpdaterRefusal('database_url_invalid');
  }
  if (
    url.hash ||
    url.pathname !== '/postgres' ||
    [...url.searchParams.keys()].some((key) => key !== 'sslmode') ||
    [...url.searchParams.keys()].length > 1 ||
    (url.searchParams.has('sslmode') &&
      !['require', 'verify-ca', 'verify-full'].includes(url.searchParams.get('sslmode')))
  ) {
    throw new UpdaterRefusal('database_url_invalid');
  }
  const username = decoded(url.username);
  const directHost = url.hostname === `db.${projectRef}.supabase.co`;
  const poolerHost = url.hostname.endsWith('.pooler.supabase.com');
  if (!directHost && !poolerHost) throw new UpdaterRefusal('database_url_host_mismatch');
  if (directHost && username !== 'postgres') {
    throw new UpdaterRefusal('database_url_direct_username_invalid');
  }
  if (poolerHost && username !== `postgres.${projectRef}`) {
    throw new UpdaterRefusal('database_url_pooler_username_invalid');
  }
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
      PGAPPNAME: 'kinjot-byo-updater',
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
  if (!['full', 'backend-only'].includes(mode)) {
    throw new UpdaterRefusal('deployment_mode_invalid');
  }
  if (typeof databaseOnly !== 'boolean') invalid();
  if (!PROJECT_REF.test(projectRef)) {
    throw new UpdaterRefusal(
      projectRef === undefined || projectRef === null || projectRef === ''
        ? 'project_ref_missing'
        : 'project_ref_invalid',
    );
  }
  if (mode === 'full') {
    if (typeof pagesProject !== 'string' || !NAME.test(pagesProject)) {
      throw new UpdaterRefusal(
        pagesProject === undefined || pagesProject === null || pagesProject === ''
          ? 'pages_project_missing'
          : 'pages_project_prerequisite',
      );
    }
    if (typeof pagesBranch !== 'string' || !NAME.test(pagesBranch)) {
      throw new UpdaterRefusal('pages_branch_invalid');
    }
  }
  if (!databaseOnly && (typeof managementToken !== 'string' || !managementToken)) {
    throw new UpdaterRefusal('management_token_missing');
  }
  if (mode === 'full' && (typeof cloudflareToken !== 'string' || !cloudflareToken)) {
    throw new UpdaterRefusal('cloudflare_token_missing');
  }
  if (mode === 'full' && !/^[a-f0-9]{32}$/.test(cloudflareAccountId)) {
    throw new UpdaterRefusal(
      cloudflareAccountId === undefined ||
        cloudflareAccountId === null ||
        cloudflareAccountId === ''
        ? 'cloudflare_account_missing'
        : 'cloudflare_account_invalid',
    );
  }
  if (
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
