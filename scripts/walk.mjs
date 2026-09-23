#!/usr/bin/env node
/**
 * Brings a deployment to the newest release, one release at a time.
 *
 * Each release only installs over its predecessor, so a deployment several
 * releases behind needs one `update` per release. This walk runs those updates
 * for the workflow: every hop is a separate `customer-cli.mjs update` process,
 * so every hop is still validated and applied by the installed release's own
 * control. The walk decides only whether to start another hop, from the
 * installed sequence in durable state before and after each one.
 *
 * It belongs to this template and never ships in a release archive: it lives
 * outside `vendor/` and is not in the runtime inventory.
 *
 * Bounds: at most `MAX_HOPS` hops per run, no new hop after `BUDGET_MS` of
 * walking, and each hop is killed after `HOP_TIMEOUT_MS`.
 */
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { readHandoffStateFile } from '../vendor/scripts/byo-updater/handoff.mjs';

export const MAX_HOPS = 10;
export const BUDGET_MS = 20 * 60 * 1000;
/**
 * A backstop, not a schedule: a hop is `db push` plus bounded function deploys
 * and normally finishes well inside this. The workflow's job timeout is the
 * outer bound.
 */
export const HOP_TIMEOUT_MS = 45 * 60 * 1000;
const KILL_GRACE_MS = 30 * 1000;

const TEMPLATE = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CUSTOMER_CLI = join(TEMPLATE, 'vendor', 'scripts', 'byo-updater', 'customer-cli.mjs');

/**
 * The child's environment: the parent's, minus `JOTNOW_AUTHENTICATED_CONTROL`.
 * That flag tells the bootstrap it is already running inside an authenticated
 * control, so passing it would make a hop skip the hand-off to the installed
 * release.
 */
export function childEnvironment(env) {
  const copy = { ...env };
  delete copy.JOTNOW_AUTHENTICATED_CONTROL;
  return copy;
}

/** `null` state (no state file) means nothing is installed. */
export function installedFromState(state) {
  const release = state?.installedRelease ?? null;
  return { sequence: release?.sequence ?? 0, version: release?.version ?? null };
}

function describe(installed) {
  return installed.sequence === 0
    ? 'no installed release'
    : `release ${installed.version} (sequence ${installed.sequence})`;
}

/**
 * The walk itself, with every effect injected.
 *
 * - `runHop(env)` runs one update and resolves to its exit code.
 * - `readState()` resolves to the durable state, or `null` when there is none.
 * - `now()` returns milliseconds; `write(line)` prints one line.
 *
 * Resolves to the process exit code.
 */
export async function runWalk({
  runHop,
  readState,
  now,
  write,
  env = {},
  maxHops = MAX_HOPS,
  budgetMs = BUDGET_MS,
}) {
  const read = async () => installedFromState(await readState());
  const started = now();
  let walked = 0;
  let before;
  try {
    before = await read();
  } catch (error) {
    write(`Could not read the deployment state: ${error.message}`);
    return 1;
  }
  // Bounded by `maxHops`: every pass either returns or increments `walked`.
  for (;;) {
    if (walked >= maxHops || now() - started >= budgetMs) {
      write(`Walked ${walked} releases in this run; run \`update\` again to continue.`);
      return 1;
    }
    const code = await runHop(childEnvironment(env));
    let after;
    try {
      after = await read();
    } catch (error) {
      write(`Could not read the deployment state: ${error.message}`);
      return 1;
    }
    if (code !== 0) {
      const where =
        after.sequence === 0
          ? 'No release is installed yet.'
          : `The deployment is on ${describe(after)}.`;
      write(`${where} The output above says why this run stopped.`);
      return Number.isInteger(code) && code > 0 && code < 256 ? code : 1;
    }
    if (after.sequence === before.sequence) {
      const pin = env.JOTNOW_RELEASE_PIN;
      if (pin) write(`Stopped at the pinned release ${pin}.`);
      else if (after.sequence === 0) write('The deployment has no installed release.');
      else write(`Deployment is current at ${after.version} (sequence ${after.sequence}).`);
      return 0;
    }
    if (after.sequence < before.sequence) {
      write(
        `The installed release went backwards, from ${describe(before)} to ${describe(after)}. Stopping.`,
      );
      return 1;
    }
    walked += 1;
    before = after;
  }
}

/** One `customer-cli.mjs update`, with inherited stdio and a hard deadline. */
export function spawnUpdate(
  env,
  {
    args = [CUSTOMER_CLI, 'update'],
    timeoutMs = HOP_TIMEOUT_MS,
    graceMs = KILL_GRACE_MS,
    stdio = 'inherit',
  } = {},
) {
  return new Promise((resolvePromise) => {
    const child = spawn(process.execPath, args, { stdio, env });
    let settled = false;
    let grace = null;
    const finish = (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (grace) clearTimeout(grace);
      resolvePromise(code);
    };
    const deadline = setTimeout(() => {
      process.stderr.write(
        `The update did not finish within ${Math.ceil(timeoutMs / 60000)} minutes.\n`,
      );
      child.kill('SIGTERM');
      grace = setTimeout(() => {
        child.kill('SIGKILL');
        // A child that ignores even SIGKILL still cannot hold the walk open.
        setTimeout(() => finish(1), graceMs).unref();
      }, graceMs);
    }, timeoutMs);
    child.on('error', (error) => {
      process.stderr.write(`Could not start the update: ${error.message}\n`);
      finish(1);
    });
    child.on('exit', (code) => finish(code ?? 1));
  });
}

/**
 * Exactly the directory the bootstrap uses (`customer-cli.mjs` `main`: the
 * workspace, then `.jotnow/deployment`), and deliberately NOT
 * `JOTNOW_UPDATER_STATE`: the bootstrap ignores that variable, so honouring
 * it here could read a different state than the hops write and misreport a
 * deployment as current.
 */
export function stateDirectory(env = process.env) {
  return join(resolve(env.GITHUB_WORKSPACE || process.cwd()), '.jotnow', 'deployment');
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  const directory = stateDirectory();
  runWalk({
    runHop: (env) => spawnUpdate(env),
    readState: () => readHandoffStateFile(directory),
    now: () => Date.now(),
    write: (line) => process.stdout.write(`${line}\n`),
    env: process.env,
  }).then(
    (code) => {
      process.exitCode = code;
    },
    (error) => {
      process.stderr.write(`The release walk failed: ${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
