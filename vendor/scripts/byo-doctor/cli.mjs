#!/usr/bin/env node
import { pathToFileURL } from 'node:url';
import { runDoctor, formatReport } from './doctor.mjs';
import { createDatabaseAdapter } from './database.mjs';
import { createHttpAdapters } from './http.mjs';

const help = `Usage: node scripts/byo-doctor/cli.mjs --migrations DIR --expected-epoch N [--json] [--timeout-ms N] [--allow-billable-voyage]

Explicit environment inputs (no env files loaded automatically):
  KINJOT_DOCTOR_DB_URL             PostgreSQL connection (psql required)
  KINJOT_DOCTOR_PROJECT_REF        Supabase project for deployment metadata
  KINJOT_DOCTOR_MANAGEMENT_TOKEN   Supabase Management API token (list functions only)
  KINJOT_DOCTOR_OPENAI_KEY         Optional locally supplied OpenAI credential
  KINJOT_DOCTOR_VOYAGE_KEY         Optional locally supplied Voyage credential

OpenAI uses GET /v1/models. Voyage requires --allow-billable-voyage for
one tiny synthetic embedding request, which may incur provider charges.
No credentials in flags. No Kinjot requests, uploads, repairs, or function invocations.
Exit: 0 all healthy; 1 confirmed unhealthy; 2 unavailable/not configured/config error.
`;

export async function main(
  argv = process.argv.slice(2),
  env = process.env,
  output = process.stdout,
  errors = process.stderr,
) {
  try {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
      const arg = argv[i];
      if (arg === '--help') {
        output.write(help);
        return 0;
      }
      if (['--json', '--allow-billable-voyage'].includes(arg)) {
        if (options[arg]) throw new Error();
        options[arg] = true;
      } else if (['--migrations', '--expected-epoch', '--timeout-ms'].includes(arg)) {
        if (options[arg] !== undefined || !argv[i + 1] || argv[i + 1].startsWith('--'))
          throw new Error();
        options[arg] = argv[++i];
      } else throw new Error();
    }
    const timeoutMs =
      options['--timeout-ms'] === undefined ? 5000 : Number(options['--timeout-ms']);
    const config = {
      migrationDirectory: options['--migrations'],
      expectedEpoch: Number(options['--expected-epoch']),
      timeoutMs,
    };
    const http = createHttpAdapters({
      projectRef: env.KINJOT_DOCTOR_PROJECT_REF,
      managementToken: env.KINJOT_DOCTOR_MANAGEMENT_TOKEN,
      openaiKey: env.KINJOT_DOCTOR_OPENAI_KEY,
      voyageKey: env.KINJOT_DOCTOR_VOYAGE_KEY,
      allowBillableVoyage: Boolean(options['--allow-billable-voyage']),
      timeoutMs,
    });
    let database;
    if (env.KINJOT_DOCTOR_DB_URL) {
      try {
        database = createDatabaseAdapter({ databaseUrl: env.KINJOT_DOCTOR_DB_URL, timeoutMs });
      } catch {
        database = {
          read: async () => {
            throw Object.assign(new Error('Invalid database configuration.'), {
              code: 'invalid_configuration',
            });
          },
        };
      }
    }
    const report = await runDoctor(config, { database, ...http });
    output.write(options['--json'] ? JSON.stringify(report, null, 2) + '\n' : formatReport(report));
    return report.status === 'healthy' ? 0 : report.status === 'unhealthy' ? 1 : 2;
  } catch {
    // Never print argv, env, exception messages, causes, or stacks.
    errors.write(
      'Doctor could not run: invalid configuration or unavailable local dependency. Use --help.\n',
    );
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
