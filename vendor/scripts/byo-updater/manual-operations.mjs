import { mkdtemp, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { isolatedCliEnvironment, runBoundedProcess } from './safe-process.mjs';
import { ensureOperatorWorkDirectory } from './operator-workspace.mjs';
import { acquireUpdateLock } from './state.mjs';

export async function repairMigrationHistory({
  config,
  version,
  status,
  confirmation,
  runProcess = runBoundedProcess,
}) {
  if (!/^\d{14}$/.test(version) || !['applied', 'reverted'].includes(status)) {
    throw new Error('migration repair requires a 14-digit version and applied or reverted status');
  }
  if (confirmation !== `REPAIR ${version} ${status}`) {
    throw new Error(
      'migration repair confirmation does not match the requested bookkeeping change',
    );
  }
  const lock = await acquireUpdateLock(config.stateDirectory);
  try {
    const work = await ensureOperatorWorkDirectory(config.stateDirectory);
    const home = await mkdtemp(join(work, '.repair-'));
    try {
      await runProcess({
        executable: config.executables.supabase,
        args: [
          'migration',
          'repair',
          version,
          '--status',
          status,
          '--db-url',
          config.database.passwordlessUrl,
          '--yes',
        ],
        cwd: config.stateDirectory,
        env: isolatedCliEnvironment(home, {
          PGPASSWORD: config.database.password,
        }),
        timeoutMs: config.timeoutMs,
        label: 'Supabase migration history repair',
      });
    } finally {
      await rm(home, { recursive: true, force: true });
    }
  } finally {
    await lock.release();
  }
  return Object.freeze({ version, status });
}

export const MIGRATION_REPAIR_GUIDE = `Migration history repair changes bookkeeping only.

Before marking APPLIED: independently prove the migration's complete SQL effect already exists. This command does not execute that SQL.
Before marking REVERTED: independently prove the migration's effect is absent or intentionally eligible to run again. This command does not undo schema or data changes.
Always run doctor again, inspect remote-only and pending versions, take an operator-owned backup when available, and use the exact typed confirmation shown by the CLI. Scheduled updates never invoke repair.`;
