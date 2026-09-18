import { Buffer } from 'node:buffer';
import { databaseConnection } from './operator-config.mjs';
import { UpdaterRefusal } from './refusal.mjs';
import { runBoundedProcess } from './safe-process.mjs';

// Supabase publishes `db.<ref>.supabase.co` over IPv6 only. GitHub-hosted
// runners are IPv4-only, so an operator who pastes the Connect dialog's default
// URL cannot reach their own database, while every structural check on that URL
// passes. Rather than refuse a correct-looking secret, resolve the project's
// session pooler from the Management API — the token is already supplied for
// function deployment — and retry once.
//
// The pooler host is never guessed from the region: only the API's own
// `db_host` is used. The API advertises port 6543, which is Supavisor's
// transaction mode; migrations need session mode, which is the same host on
// 5432.
const SESSION_POOLER_PORT = '5432';
const POOLER_HOST_SUFFIX = '.pooler.supabase.com';
const PROBE_CEILING_MS = 15_000;
const MAX_POOLER_BODY_BYTES = 64 * 1024;
const MAX_POOLER_BODY_READS = 128;

function directHost(url, projectRef) {
  return url.hostname === `db.${projectRef}.supabase.co`;
}

/**
 * A single bounded reachability probe. Any failure — refused connection,
 * authentication, timeout — is reported as unreachable, because the caller's
 * only decision is whether to try the other endpoint. The probe never
 * distinguishes further, and never retries on its own.
 */
export function createPsqlProbe({ psql, cwd, timeoutMs, runProcess = runBoundedProcess }) {
  return async function probe(connection) {
    try {
      await runProcess({
        executable: psql,
        args: [
          '--no-psqlrc',
          '--no-password',
          '--quiet',
          '--tuples-only',
          '--no-align',
          '--set=ON_ERROR_STOP=1',
          '--command=select 1',
        ],
        cwd,
        env: connection.psqlEnv,
        timeoutMs: Math.min(timeoutMs, PROBE_CEILING_MS),
        label: 'database reachability probe',
      });
      return true;
    } catch {
      return false;
    }
  };
}

function cancelBody(response) {
  try {
    const cancellation = response?.body?.cancel?.();
    cancellation?.catch?.(() => {});
  } catch {
    // Cleanup must never replace the fixed endpoint refusal.
  }
}

async function boundedJson(response, setActiveReader) {
  const declared = Number(response.headers?.get?.('content-length'));
  if (Number.isFinite(declared) && (declared < 0 || declared > MAX_POOLER_BODY_BYTES)) {
    cancelBody(response);
    throw new Error('invalid pooler response');
  }
  const reader = response.body?.getReader?.();
  if (!reader) {
    cancelBody(response);
    throw new Error('invalid pooler response');
  }
  setActiveReader(reader);
  const chunks = [];
  let size = 0;
  let reads = 0;
  while (true) {
    if ((reads += 1) > MAX_POOLER_BODY_READS) {
      cancelReader(reader);
      throw new Error('invalid pooler response');
    }
    const { done, value } = await reader.read();
    if (done) break;
    if (!(value instanceof Uint8Array)) {
      cancelReader(reader);
      throw new Error('invalid pooler response');
    }
    size += value.byteLength;
    if (size > MAX_POOLER_BODY_BYTES) {
      cancelReader(reader);
      throw new Error('invalid pooler response');
    }
    chunks.push(Buffer.from(value));
  }
  return JSON.parse(Buffer.concat(chunks, size).toString('utf8'));
}

function cancelReader(reader) {
  try {
    const cancellation = reader?.cancel?.();
    cancellation?.catch?.(() => {});
  } catch {
    // Cleanup must never replace the fixed endpoint refusal.
  }
}

async function poolerHost({ projectRef, managementToken, timeoutMs, fetchImpl }) {
  const controller = new AbortController();
  let activeReader;
  let timer;
  const operation = Promise.resolve()
    .then(() =>
      fetchImpl(`https://api.supabase.com/v1/projects/${projectRef}/config/database/pooler`, {
        headers: { Authorization: `Bearer ${managementToken}` },
        redirect: 'error',
        signal: controller.signal,
      }),
    )
    .then(async (response) => {
      if (!response?.ok) {
        cancelBody(response);
        return null;
      }
      const body = await boundedJson(response, (reader) => {
        activeReader = reader;
      });
      if (!Array.isArray(body) || body.length > 128) return null;
      const primary = body.find((entry) => entry?.database_type === 'PRIMARY');
      const host = primary?.db_host;
      if (typeof host !== 'string' || !host.endsWith(POOLER_HOST_SUFFIX)) return null;
      // A hostile or misconfigured response must not become a connection target.
      if (new URL(`https://${host}`).hostname !== host) return null;
      return host;
    })
    .catch(() => null);
  // A mocked or broken fetch implementation may ignore AbortSignal. Race it so
  // the caller is still released at the advertised deadline, and retain a
  // rejection handler on the underlying operation for any late settlement.
  const timeout = new Promise((resolve) => {
    timer = setTimeout(
      () => {
        try {
          controller.abort();
        } catch {
          // The deadline remains authoritative even if abort itself misbehaves.
        }
        cancelReader(activeReader);
        resolve(null);
      },
      Math.min(timeoutMs, PROBE_CEILING_MS),
    );
  });
  try {
    return await Promise.race([operation, timeout]);
  } finally {
    clearTimeout(timer);
  }
}

function pooledUrl(url, host, projectRef) {
  const pooled = new URL(url);
  pooled.hostname = host;
  pooled.port = SESSION_POOLER_PORT;
  pooled.username = encodeURIComponent(`postgres.${projectRef}`);
  return pooled.toString();
}

/**
 * Returns the database URL to use, which is the operator's own URL unless it
 * names the unreachable direct host and a pooler endpoint answers in its place.
 *
 * Bounded by construction: at most one Management API request and at most two
 * probes, with no retry budget of its own and no recursion. A URL that is not a
 * direct-host URL is returned untouched without any probe, so the common case
 * costs nothing.
 */
export async function resolveDatabaseEndpoint({
  databaseUrl,
  projectRef,
  managementToken,
  timeoutMs,
  probe,
  fetchImpl = globalThis.fetch,
}) {
  // Structural problems stay with `databaseConnection`, whose refusals name the
  // exact defect. Resolving must never pre-empt those messages.
  let connection;
  let url;
  try {
    url = new URL(databaseUrl);
    connection = databaseConnection(databaseUrl, projectRef, timeoutMs);
  } catch {
    return databaseUrl;
  }
  if (!directHost(url, projectRef)) return databaseUrl;
  if (await probe(connection)) return databaseUrl;

  const host = await poolerHost({ projectRef, managementToken, timeoutMs, fetchImpl });
  if (!host) throw new UpdaterRefusal('database_direct_host_unreachable');

  const candidate = pooledUrl(url, host, projectRef);
  let pooledConnection;
  try {
    pooledConnection = databaseConnection(candidate, projectRef, timeoutMs);
  } catch {
    throw new UpdaterRefusal('database_direct_host_unreachable');
  }
  if (!(await probe(pooledConnection))) {
    throw new UpdaterRefusal('database_direct_host_unreachable');
  }
  return candidate;
}
