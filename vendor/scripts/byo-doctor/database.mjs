import { spawn } from 'node:child_process';
import { delimiter, isAbsolute } from 'node:path';
import { Buffer } from 'node:buffer';

import { BUCKET_PREREQUISITES, SCHEMA_PREREQUISITES } from './schema.mjs';

const MAX_STDOUT_BYTES = 1024 * 1024;
const MAX_STDERR_BYTES = 64 * 1024;
const CHECK_NAMES = new Set([
  'migrations',
  'epoch',
  'marker',
  'extensions',
  'schema',
  'bucket',
  'backfill',
]);

const QUERIES = {
  migrations: `SELECT version::text
FROM supabase_migrations.schema_migrations
ORDER BY version;`,
  epoch: 'SELECT public.jotnow_schema_compatibility()::text;',
  marker: `SELECT self_hosted
FROM public.deployment_settings
WHERE id = true;`,
  extensions: `SELECT e.extname, e.extversion
FROM pg_catalog.pg_extension e
WHERE e.extname IN ('vector', 'pgcrypto', 'uuid-ossp')
ORDER BY e.extname;`,
  schema: `SELECT inventory.object_kind, inventory.object_name
FROM (
  SELECT 'table'::text AS object_kind,
         n.nspname || '.' || c.relname AS object_name
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r', 'p')
  UNION ALL
  SELECT 'column'::text,
         n.nspname || '.' || c.relname || '.' || a.attname
  FROM pg_catalog.pg_attribute a
  JOIN pg_catalog.pg_class c ON c.oid = a.attrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND c.relkind IN ('r', 'p')
    AND a.attnum > 0
    AND NOT a.attisdropped
  UNION ALL
  SELECT 'function'::text,
         n.nspname || '.' || p.proname || '(' ||
           pg_catalog.replace(pg_catalog.oidvectortypes(p.proargtypes), ', ', ',') || ')'
  FROM pg_catalog.pg_proc p
  JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public' AND p.prokind = 'f'
  UNION ALL
  SELECT 'trigger'::text,
         n.nspname || '.' || c.relname || '.' || t.tgname
  FROM pg_catalog.pg_trigger t
  JOIN pg_catalog.pg_class c ON c.oid = t.tgrelid
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public'
    AND NOT t.tgisinternal
    AND t.tgenabled IN ('O', 'A')
  UNION ALL
  SELECT 'extension'::text,
         n.nspname || '.' || e.extname
  FROM pg_catalog.pg_extension e
  JOIN pg_catalog.pg_namespace n ON e.extnamespace = n.oid
) inventory
ORDER BY inventory.object_kind, inventory.object_name;`,
  // Storage buckets are rows, not catalog entries, so this cannot ride along
  // with the inventory above — and must not, because reading an RLS-enabled
  // table under `row_security = off` is the one statement in this module that
  // needs BYPASSRLS. Its own check, so a role that lacks it loses this answer
  // and no other (`schema.mjs`, BUCKET_PREREQUISITES).
  bucket: `SELECT 'bucket'::text AS object_kind,
       'storage.buckets.' || b.id AS object_name
FROM storage.buckets b
ORDER BY object_name;`,
};

export const BACKFILL_COUNT_SQL = `SELECT count(*)::text
FROM public.notes n
WHERE n.deleted_at IS NULL
  AND NOT EXISTS (
    SELECT 1 FROM public.note_embeddings ne WHERE ne.note_id = n.id)
  AND NOT EXISTS (
    SELECT 1 FROM public.embedding_jobs j WHERE j.note_id = n.id)`;

QUERIES.backfill = `WITH scope AS (
  SELECT pg_catalog.count(*) = 3 AND pg_catalog.bool_and(
    r.rolsuper OR r.rolbypassrls OR
      pg_catalog.pg_has_role(current_user, c.relowner, 'USAGE')
  ) AS allowed
  FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  JOIN pg_catalog.pg_roles r ON r.rolname = current_user
  WHERE n.nspname = 'public'
    AND c.relname IN ('notes', 'note_embeddings', 'embedding_jobs')
    AND c.relkind IN ('r', 'p')
)
SELECT CASE WHEN scope.allowed IS TRUE THEN 'scope_ok' ELSE 'scope_denied' END,
       CASE WHEN scope.allowed IS TRUE THEN (${BACKFILL_COUNT_SQL}) ELSE NULL END
FROM scope;`;
Object.freeze(QUERIES);

const SAFE_MESSAGES = Object.freeze({
  timeout: 'Database check timed out.',
  permission_denied: 'Database permission denied.',
  authentication_rejected: 'Database authentication was rejected.',
  missing_prerequisite: 'Database prerequisite is missing.',
  invalid_response: 'Database returned an invalid response.',
  invalid_configuration: 'Invalid database doctor configuration.',
  unavailable: 'Database check is unavailable.',
  connection_failed: 'Database connection failed.',
});

function safeError(code) {
  const error = new Error(SAFE_MESSAGES[code]);
  error.code = code;
  return error;
}

function invalidConfiguration() {
  throw safeError('invalid_configuration');
}

function decodeUrlPart(value) {
  try {
    const decoded = decodeURIComponent(value);
    if (/[^\x20-\x7e]/.test(decoded)) invalidConfiguration();
    return decoded;
  } catch (error) {
    if (error?.code === 'invalid_configuration') throw error;
    invalidConfiguration();
  }
}

function databaseEnvironment(databaseUrl, timeoutMs) {
  if (typeof databaseUrl !== 'string' || databaseUrl.length === 0 || databaseUrl.length > 4096) {
    invalidConfiguration();
  }

  let url;
  try {
    url = new URL(databaseUrl);
  } catch {
    invalidConfiguration();
  }

  if (!['postgres:', 'postgresql:'].includes(url.protocol) || url.hash) invalidConfiguration();
  if (!url.hostname || !url.username || !url.password || !url.pathname.startsWith('/')) {
    invalidConfiguration();
  }
  if (url.pathname.indexOf('/', 1) !== -1) invalidConfiguration();

  const query = [...url.searchParams.entries()];
  if (query.length > 1 || (query.length === 1 && query[0][0] !== 'sslmode')) {
    invalidConfiguration();
  }
  const sslmode = query.length === 0 ? 'require' : query[0][1];
  if (!['require', 'verify-ca', 'verify-full'].includes(sslmode)) invalidConfiguration();

  const hostname =
    url.hostname.startsWith('[') && url.hostname.endsWith(']')
      ? url.hostname.slice(1, -1)
      : url.hostname;
  const database = decodeUrlPart(url.pathname.slice(1));
  const user = decodeUrlPart(url.username);
  const password = decodeUrlPart(url.password);
  if (!hostname || !database || !user || !password) invalidConfiguration();

  // Preserve executable lookup for installations such as Homebrew/Nix while
  // excluding inherited libpq/psql settings. PATH is trusted local process
  // configuration; no release metadata can set it through this module.
  const executableSearchPath = process.env.PATH;
  if (
    executableSearchPath !== undefined &&
    (!executableSearchPath ||
      [...executableSearchPath].some(
        (char) => char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127,
      ) ||
      executableSearchPath.split(delimiter).some((entry) => !isAbsolute(entry)))
  ) {
    invalidConfiguration();
  }

  return {
    ...(executableSearchPath === undefined ? {} : { PATH: executableSearchPath }),
    LANG: 'C',
    LC_ALL: 'C',
    PGAPPNAME: 'jotnow-byo-doctor',
    PGCONNECT_TIMEOUT: String(Math.max(1, Math.ceil(timeoutMs / 1000))),
    PGDATABASE: database,
    PGHOST: hostname,
    PGPASSWORD: password,
    PGPORT: url.port || '5432',
    PGSSLMODE: sslmode,
    PGUSER: user,
  };
}

function scriptFor(query, timeoutMs) {
  return `\\set ON_ERROR_STOP on
BEGIN READ ONLY;
SET LOCAL statement_timeout = '${timeoutMs}ms';
SET LOCAL lock_timeout = '${timeoutMs}ms';
SET LOCAL idle_in_transaction_session_timeout = '${timeoutMs}ms';
SET LOCAL row_security = off;
SET LOCAL search_path = '';
\\set ON_ERROR_STOP off
${query}
\\set doctor_failed :ERROR
\\set doctor_sqlstate :SQLSTATE
ROLLBACK;
\\echo __JOTNOW_SQLSTATE__ :doctor_sqlstate
\\quit
`;
}

function stderrSqlstate(stderr) {
  return /(?:ERROR|FATAL): {2}([0-9A-Z]{5}):/.exec(stderr)?.[1];
}

function classifyFailure(exitCode, stderr, savedSqlstate) {
  const sqlstate =
    savedSqlstate && savedSqlstate !== '00000' ? savedSqlstate : stderrSqlstate(stderr);
  if (sqlstate === '57014' || sqlstate === '55P03') return safeError('timeout');
  if (sqlstate === '42501') return safeError('permission_denied');
  if (sqlstate?.startsWith('28')) return safeError('authentication_rejected');
  if (['42P01', '42703', '42704', '42883', '3F000'].includes(sqlstate)) {
    return safeError('missing_prerequisite');
  }
  if (sqlstate?.startsWith('08') || exitCode === 2) return safeError('connection_failed');
  return safeError('unavailable');
}

function parseSqlstateFooter(stdout) {
  const match = /(?:^|\n)__JOTNOW_SQLSTATE__ ([0-9A-Z]{5})\n?$/.exec(stdout);
  if (!match) throw safeError('invalid_response');
  return { data: stdout.slice(0, match.index), sqlstate: match[1] };
}

function runPsql({ env, query, timeoutMs, spawnImpl }) {
  const args = [
    '--no-psqlrc',
    '--no-password',
    '--quiet',
    '--tuples-only',
    '--no-align',
    '--field-separator=\t',
    '--set=ON_ERROR_STOP=1',
    '--set=VERBOSITY=verbose',
    '--set=SHOW_CONTEXT=never',
  ];

  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl('psql', args, {
        env,
        shell: false,
        stdio: ['pipe', 'pipe', 'pipe'],
      });
    } catch (error) {
      reject(safeError(error?.code === 'EACCES' ? 'permission_denied' : 'unavailable'));
      return;
    }

    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let forcedError = null;
    let settled = false;

    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (error) reject(error);
      else resolve(value);
    };

    const kill = (error) => {
      if (forcedError === null) forcedError = error;
      try {
        child.kill('SIGKILL');
      } catch {
        // Reject below even if a nonconforming child does not emit close.
      }
      finish(forcedError);
    };

    const timer = setTimeout(() => kill(safeError('timeout')), timeoutMs);

    child.stdout.on('data', (chunk) => {
      stdoutBytes += chunk.length;
      if (stdoutBytes > MAX_STDOUT_BYTES) {
        kill(safeError('invalid_response'));
        return;
      }
      stdout.push(chunk);
    });
    child.stderr.on('data', (chunk) => {
      stderrBytes += chunk.length;
      if (stderrBytes > MAX_STDERR_BYTES) {
        kill(safeError('invalid_response'));
        return;
      }
      stderr.push(chunk);
    });

    child.once('error', (error) => {
      const code = error?.code === 'EACCES' ? 'permission_denied' : 'unavailable';
      finish(forcedError ?? safeError(code));
    });
    child.once('close', (code) => {
      if (forcedError) {
        finish(forcedError);
        return;
      }
      const stderrText = Buffer.concat(stderr).toString('utf8');
      const stdoutText = Buffer.concat(stdout).toString('utf8');
      let result;
      try {
        result = parseSqlstateFooter(stdoutText);
      } catch (error) {
        if (code !== 0 || stderrSqlstate(stderrText)) {
          finish(classifyFailure(code, stderrText));
          return;
        }
        finish(error);
        return;
      }
      if (code !== 0 || result.sqlstate !== '00000' || stderrSqlstate(stderrText)) {
        finish(classifyFailure(code, stderrText, result.sqlstate));
        return;
      }
      finish(null, result.data);
    });
    child.stdin.once('error', () => kill(safeError('unavailable')));
    try {
      child.stdin.end(scriptFor(query, timeoutMs));
    } catch {
      kill(safeError('unavailable'));
    }
  });
}

function linesOf(stdout) {
  if (stdout.includes('\0') || stdout.includes('\r')) throw safeError('invalid_response');
  if (stdout === '') return [];
  const withoutFinalNewline = stdout.endsWith('\n') ? stdout.slice(0, -1) : stdout;
  const lines = withoutFinalNewline.split('\n');
  if (lines.some((line) => line.length === 0)) throw safeError('invalid_response');
  return lines;
}

function parseMigrations(stdout) {
  const lines = linesOf(stdout);
  if (lines.some((line) => !/^\d{14}$/.test(line))) throw safeError('invalid_response');
  return lines;
}

function parseEpoch(stdout) {
  const lines = linesOf(stdout);
  if (lines.length !== 1 || !/^\d+$/.test(lines[0])) throw safeError('invalid_response');
  const epoch = Number(lines[0]);
  if (!Number.isSafeInteger(epoch)) throw safeError('invalid_response');
  return epoch;
}

function parseMarker(stdout) {
  const lines = linesOf(stdout);
  if (lines.length === 0) return null;
  if (lines.length !== 1 || !['t', 'f'].includes(lines[0])) throw safeError('invalid_response');
  return lines[0] === 't';
}

function parseExtensions(stdout) {
  const allowed = new Set(['vector', 'pgcrypto', 'uuid-ossp']);
  const seen = new Set();
  return linesOf(stdout).map((line) => {
    const fields = line.split('\t');
    if (
      fields.length !== 2 ||
      !allowed.has(fields[0]) ||
      seen.has(fields[0]) ||
      !/^[0-9A-Za-z][0-9A-Za-z.+_-]{0,63}$/.test(fields[1])
    ) {
      throw safeError('invalid_response');
    }
    seen.add(fields[0]);
    return { name: fields[0], version: fields[1] };
  });
}

function parseSchema(stdout) {
  const present = new Set();
  for (const line of linesOf(stdout)) {
    const fields = line.split('\t');
    if (
      fields.length !== 2 ||
      !['table', 'column', 'function', 'trigger', 'extension'].includes(fields[0]) ||
      fields[1].length === 0 ||
      fields[1].length > 512 ||
      /[^\x20-\x7e]/.test(fields[1])
    ) {
      throw safeError('invalid_response');
    }
    present.add(`${fields[0]}\t${fields[1]}`);
  }
  return {
    missing: SCHEMA_PREREQUISITES.filter(({ kind, name }) => !present.has(`${kind}\t${name}`)).map(
      ({ name }) => name,
    ),
  };
}

function parseBucket(stdout) {
  const present = new Set();
  for (const line of linesOf(stdout)) {
    const fields = line.split('\t');
    if (
      fields.length !== 2 ||
      fields[0] !== 'bucket' ||
      fields[1].length === 0 ||
      fields[1].length > 512 ||
      /[^\x20-\x7e]/.test(fields[1])
    ) {
      throw safeError('invalid_response');
    }
    present.add(`${fields[0]}\t${fields[1]}`);
  }
  return {
    missing: BUCKET_PREREQUISITES.filter(({ kind, name }) => !present.has(`${kind}\t${name}`)).map(
      ({ name }) => name,
    ),
  };
}

function parseBackfill(stdout) {
  const lines = linesOf(stdout);
  if (lines.length !== 1) throw safeError('invalid_response');
  const fields = lines[0].split('\t');
  if (fields.length !== 2) throw safeError('invalid_response');
  if (fields[0] === 'scope_denied') throw safeError('permission_denied');
  if (fields[0] !== 'scope_ok' || !/^\d+$/.test(fields[1])) {
    throw safeError('invalid_response');
  }
  return fields[1];
}

const PARSERS = Object.freeze({
  migrations: parseMigrations,
  epoch: parseEpoch,
  marker: parseMarker,
  extensions: parseExtensions,
  schema: parseSchema,
  bucket: parseBucket,
  backfill: parseBackfill,
});

export function createDatabaseAdapter(options = {}) {
  if (options === null || typeof options !== 'object') invalidConfiguration();
  const { databaseUrl, timeoutMs = 5000, spawnImpl = spawn } = options;
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 60_000) {
    invalidConfiguration();
  }
  if (typeof spawnImpl !== 'function') invalidConfiguration();
  const env = databaseEnvironment(databaseUrl, timeoutMs);

  return Object.freeze({
    async read(checkName) {
      if (!CHECK_NAMES.has(checkName)) throw safeError('invalid_configuration');
      const stdout = await runPsql({
        env,
        query: QUERIES[checkName],
        timeoutMs,
        spawnImpl,
      });
      return PARSERS[checkName](stdout);
    },
  });
}
