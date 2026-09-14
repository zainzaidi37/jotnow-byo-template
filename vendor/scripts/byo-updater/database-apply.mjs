import { lstat, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { scanSql } from '../migration-lint/tokenize.mjs';
import { runBoundedProcess } from './safe-process.mjs';

const MAX_MIGRATION_BYTES = 4 * 1024 * 1024;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;
const VERSION = /^\d{14}_[A-Za-z0-9_-]+\.sql$/;

function words(tokens, index, ...values) {
  return values.every(
    (value, offset) =>
      tokens[index + offset]?.kind === 'word' && tokens[index + offset].value === value,
  );
}

function transactionSetting(tokens) {
  if (words(tokens, 0, 'set', 'transaction')) return true;
  if (words(tokens, 0, 'set', 'session', 'characteristics', 'as', 'transaction')) return true;
  if (words(tokens, 0, 'reset', 'all')) return true;
  const offset = words(tokens, 0, 'set', 'local') || words(tokens, 0, 'set', 'session') ? 2 : 1;
  const restricted = new Set([
    'statement_timeout',
    'lock_timeout',
    'idle_in_transaction_session_timeout',
  ]);
  if (words(tokens, 0, 'set') && restricted.has(tokens[offset]?.value)) return true;
  if (words(tokens, 0, 'reset') && restricted.has(tokens[1]?.value)) return true;
  return false;
}

export function assertRehearsableSql(sql, filename) {
  if (typeof sql !== 'string' || !VERSION.test(filename))
    throw new Error('invalid migration input');
  const parsed = scanSql(sql);
  if (parsed.errors.length) throw new Error(`migration cannot be safely rehearsed: ${filename}`);
  if (parsed.code.includes('\\'))
    throw new Error(`migration contains a psql meta-command: ${filename}`);
  for (const statement of parsed.statements) {
    const tokens = parsed.tokens.filter(
      (token) => token.start >= statement.start && token.end <= statement.end,
    );
    const forbidden =
      words(tokens, 0, 'begin') ||
      words(tokens, 0, 'start', 'transaction') ||
      words(tokens, 0, 'commit') ||
      words(tokens, 0, 'end') ||
      words(tokens, 0, 'rollback') ||
      words(tokens, 0, 'abort') ||
      words(tokens, 0, 'savepoint') ||
      words(tokens, 0, 'release', 'savepoint') ||
      words(tokens, 0, 'prepare', 'transaction') ||
      words(tokens, 0, 'vacuum') ||
      words(tokens, 0, 'reindex') ||
      words(tokens, 0, 'create', 'database') ||
      words(tokens, 0, 'create', 'tablespace') ||
      words(tokens, 0, 'drop', 'database') ||
      words(tokens, 0, 'drop', 'tablespace') ||
      words(tokens, 0, 'alter', 'system') ||
      words(tokens, 0, 'checkpoint') ||
      words(tokens, 0, 'discard') ||
      transactionSetting(tokens) ||
      (words(tokens, 0, 'copy') &&
        tokens.some(
          (_, index) =>
            words(tokens, index, 'from', 'stdin') ||
            words(tokens, index, 'from', 'program') ||
            words(tokens, index, 'to', 'program'),
        )) ||
      tokens.some((_, index) => words(tokens, index, 'concurrently'));
    if (forbidden) throw new Error(`migration escapes the rehearsal transaction: ${filename}`);
  }
}

async function readPending(packageRoot, manifest, applied) {
  const pending = manifest.migrations.filter((name) => !applied.includes(name.slice(0, 14)));
  const files = [];
  let total = 0;
  for (const name of pending) {
    const path = join(packageRoot, 'supabase', 'migrations', name);
    const stat = await lstat(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_MIGRATION_BYTES) {
      throw new Error(`migration is unsafe or exceeds its bound: ${name}`);
    }
    total += stat.size;
    if (total > MAX_PENDING_BYTES) throw new Error('pending migrations exceed rehearsal bound');
    const sql = await readFile(path, 'utf8');
    assertRehearsableSql(sql, name);
    files.push({ name, sql });
  }
  return files;
}

function psqlScript(body, timeoutMs, { commit = false, readOnly = false } = {}) {
  return `\\set ON_ERROR_STOP on
BEGIN${readOnly ? ' READ ONLY' : ''};
SET LOCAL statement_timeout = '${timeoutMs}ms';
SET LOCAL lock_timeout = '${Math.min(timeoutMs, 10_000)}ms';
SET LOCAL idle_in_transaction_session_timeout = '${timeoutMs}ms';
${body}
${commit ? 'COMMIT' : 'ROLLBACK'};
`;
}

export function createDatabaseApply({ config, readDatabase, runProcess = runBoundedProcess }) {
  const invoke = (body, label, options) =>
    runProcess({
      executable: config.executables.psql,
      args: [
        '--no-psqlrc',
        '--no-password',
        '--quiet',
        '--tuples-only',
        '--no-align',
        '--set=ON_ERROR_STOP=1',
        '--set=VERBOSITY=verbose',
      ],
      cwd: config.stateDirectory,
      env: config.database.psqlEnv,
      input: psqlScript(body, config.timeoutMs, options),
      timeoutMs: config.timeoutMs,
      label,
    });
  return Object.freeze({
    read: readDatabase.read.bind(readDatabase),
    async emptyAppSchema() {
      const output = await invoke(
        `SELECT CASE WHEN NOT EXISTS (
  SELECT 1 FROM pg_catalog.pg_class c
  JOIN pg_catalog.pg_namespace n ON n.oid = c.relnamespace
  WHERE n.nspname = 'public' AND c.relkind IN ('r','p','v','m','S')
) THEN 'empty' ELSE 'not_empty' END;`,
        'empty-schema preflight',
        { readOnly: true },
      );
      const value = output.toString('utf8').trim();
      if (!['empty', 'not_empty'].includes(value)) throw new Error('empty-schema preflight failed');
      return value === 'empty';
    },
    async rehearse({ packageRoot, manifest, applied }) {
      const pending = await readPending(packageRoot, manifest, applied);
      if (!pending.length) return;
      const body = pending.map(({ name, sql }) => `-- ${name}\n${sql}`).join('\n');
      await invoke(body, 'migration rehearsal');
    },
    async initializeAndBackfill() {
      await invoke(
        `INSERT INTO public.deployment_settings (id, self_hosted)
VALUES (true, true)
ON CONFLICT (id) DO UPDATE SET self_hosted = true
WHERE public.deployment_settings.self_hosted IS DISTINCT FROM true;
SELECT public.backfill_self_hosted_embeddings();`,
        'self-host initialization',
        { commit: true },
      );
    },
    async backfill() {
      await invoke('SELECT public.backfill_self_hosted_embeddings();', 'embedding backfill', {
        commit: true,
      });
    },
  });
}
