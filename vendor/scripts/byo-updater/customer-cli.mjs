#!/usr/bin/env node
import { execFile } from 'node:child_process';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createUpdaterAdapters } from './apply-adapters.mjs';
import { runDoctor, formatReport } from '../byo-doctor/doctor.mjs';
import { createDatabaseAdapter } from '../byo-doctor/database.mjs';
import { createHttpAdapters } from '../byo-doctor/http.mjs';
import { GitCheckpointStore } from './git-checkpoint.mjs';
import { GitInstanceStore } from './git-configuration.mjs';
import {
  activateLicense,
  activeLink,
  assertIntentLicense,
  authorizedUnlink,
  compensatedLink,
  confirmedLink,
  confirmedUnlink,
  createLinkingIntent,
  deactivateLicense,
  pendingUnlink,
  validateLicenseAvailability,
  validateLicenseInstance,
} from './license-lifecycle.mjs';
import { validateOperatorConfig } from './operator-config.mjs';
import { downloadRelease } from './release-download.mjs';
import { acquireUpdateLock, authenticateInstalledControl, FileStateStore } from './state.mjs';
import { runUpdate } from './updater.mjs';
import { formatCliFailure, main as localUpdaterMain } from './cli.mjs';
import { UpdaterRefusal } from './refusal.mjs';

const CHANNEL_KEYS = [
  'schemaVersion',
  'channel',
  'enabled',
  'releaseEndpoint',
  'r2Origin',
  'storeId',
  'productId',
  'trustList',
];

function fixed(message = 'customer updater configuration is invalid') {
  return new Error(message);
}

function isModeWidening(state, mode) {
  if (!state || state.mode === mode) return false;
  if (state.mode === 'backend-only' && mode === 'full' && state.attempt === null) return true;
  throw new UpdaterRefusal('mode_mismatch');
}

async function withLegacyOperatorUrlDefaults(operation) {
  const defaults = {
    JOTNOW_SITE_URL: 'http://127.0.0.1',
    JOTNOW_AUTH_CALLBACK_URL: 'http://127.0.0.1/auth/callback',
  };
  const previous = new Map();
  for (const [name, value] of Object.entries(defaults)) {
    previous.set(name, Object.hasOwn(process.env, name) ? process.env[name] : undefined);
    if (!process.env[name]) process.env[name] = value;
  }
  try {
    return await operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

function licenseRecovery(recoveryAction = 'link') {
  return Object.assign(new Error('license lifecycle recovery is required'), {
    code: 'license_recovery_required',
    recoveryAction,
  });
}

function exactKeys(value, keys) {
  return (
    value &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).sort().join('\0') === [...keys].sort().join('\0')
  );
}

async function channelConfig(repository) {
  let value;
  try {
    value = JSON.parse(await readFile(join(repository, 'jotnow.channel.json'), 'utf8'));
  } catch {
    throw fixed();
  }
  if (
    !exactKeys(value, CHANNEL_KEYS) ||
    value.schemaVersion !== 1 ||
    !['test', 'production'].includes(value.channel) ||
    typeof value.enabled !== 'boolean' ||
    typeof value.releaseEndpoint !== 'string' ||
    typeof value.r2Origin !== 'string' ||
    !Number.isSafeInteger(value.storeId) ||
    !Number.isSafeInteger(value.productId) ||
    typeof value.trustList !== 'string' ||
    value.trustList.startsWith('/') ||
    value.trustList.includes('..')
  ) {
    throw fixed();
  }
  if (!value.enabled) throw fixed(`${value.channel} release enrollment is disabled`);
  const endpoint = new URL(value.releaseEndpoint);
  const r2 = new URL(value.r2Origin);
  if (
    endpoint.protocol !== 'https:' ||
    endpoint.search ||
    endpoint.hash ||
    r2.protocol !== 'https:' ||
    r2.origin !== value.r2Origin ||
    r2.pathname !== '/'
  ) {
    throw fixed();
  }
  return Object.freeze({ ...value });
}

function git(repository, args) {
  return new Promise((accept, reject) => {
    execFile(
      'git',
      ['-C', repository, ...args],
      { env: { PATH: process.env.PATH, LANG: 'C' } },
      (error, stdout) =>
        error
          ? reject(fixed('unable to read configuration branch'))
          : accept(String(stdout).trim()),
    );
  });
}

function operatorConfig(mode, stateDirectory, trustListPath) {
  return validateOperatorConfig(
    {
      databaseUrl: process.env.JOTNOW_DATABASE_URL,
      projectRef: process.env.JOTNOW_SUPABASE_PROJECT_REF,
      managementToken: process.env.SUPABASE_ACCESS_TOKEN,
      cloudflareToken: process.env.CLOUDFLARE_API_TOKEN,
      cloudflareAccountId: process.env.CLOUDFLARE_ACCOUNT_ID,
      pagesProject: process.env.JOTNOW_PAGES_PROJECT,
      pagesBranch: process.env.JOTNOW_PAGES_BRANCH || 'main',
      stateDirectory,
      trustListPath,
      executables: {
        psql: process.env.JOTNOW_PSQL_BIN,
        supabase: process.env.JOTNOW_SUPABASE_BIN,
        wrangler: process.env.JOTNOW_WRANGLER_BIN,
      },
      timeoutMs: Number(process.env.JOTNOW_UPDATE_TIMEOUT_MS || 120_000),
    },
    { mode },
  );
}

export async function selectInstalledControl(
  repository,
  stateDirectory,
  argv,
  authenticate = authenticateInstalledControl,
) {
  if (process.env.JOTNOW_AUTHENTICATED_CONTROL === '1') return false;
  const state = await new FileStateStore(stateDirectory).read();
  if (!state?.updaterControl) return false;
  let authenticated;
  try {
    authenticated = await authenticate({ stateDirectory, state });
  } catch (error) {
    if (argv[0] === 'doctor') return false;
    throw error;
  }
  const initialRecoveryUpdate =
    argv[0] === 'update' &&
    argv.length <= 2 &&
    (argv.length === 1 || ['full', 'backend-only'].includes(argv[1])) &&
    (argv[1] ?? 'full') === state.mode &&
    state.installedRelease === null &&
    state.attempt?.phase === 'control_installed' &&
    state.attempt.target.sequence === 1 &&
    state.updaterControl.sequence === state.attempt.target.sequence &&
    authenticated.manifest.release.minimumPreviousRelease === null;
  const wideningUpdate =
    argv.length === 2 &&
    argv[0] === 'update' &&
    argv[1] === 'full' &&
    state.mode === 'backend-only' &&
    state.installedRelease !== null &&
    state.attempt === null &&
    state.updaterControl.sequence === state.installedRelease.sequence;
  const explicitUpdateMode =
    argv.length === 2 && argv[0] === 'update' && ['full', 'backend-only'].includes(argv[1])
      ? argv[1]
      : null;
  if (explicitUpdateMode && state.mode !== explicitUpdateMode && !wideningUpdate) {
    throw new UpdaterRefusal('mode_mismatch');
  }
  if (initialRecoveryUpdate || wideningUpdate) return false;
  const entry = join(authenticated.root, 'scripts/byo-updater/customer-cli.mjs');
  const module = await import(pathToFileURL(entry).href);
  process.env.JOTNOW_AUTHENTICATED_CONTROL = '1';
  const result = await withLegacyOperatorUrlDefaults(() => module.main(argv));
  return Number.isInteger(result) ? result : true;
}

async function stores(repository, stateDirectory) {
  const branch = process.env.JOTNOW_CONFIGURATION_BRANCH || process.env.GITHUB_REF_NAME;
  if (!branch) throw fixed('configuration branch is required');
  const expectedHead = await git(repository, ['rev-parse', 'HEAD']);
  const localStore = new FileStateStore(stateDirectory);
  return {
    instance: new GitInstanceStore({ repository, branch, expectedHead }),
    checkpoint: new GitCheckpointStore({
      repository,
      stateDirectory,
      branch,
      expectedHead,
      localStore,
    }),
  };
}

export async function update(repository, stateDirectory, mode, dependencies = {}) {
  const readChannel = dependencies.channelConfig ?? channelConfig;
  const readOperatorConfig = dependencies.operatorConfig ?? operatorConfig;
  const createStores = dependencies.stores ?? stores;
  const fetchRelease = dependencies.downloadRelease ?? downloadRelease;
  const createAdapters = dependencies.createUpdaterAdapters ?? createUpdaterAdapters;
  const applyUpdate = dependencies.runUpdate ?? runUpdate;
  const acquireLock = dependencies.acquireUpdateLock ?? acquireUpdateLock;
  const channel = await readChannel(repository);
  const trustListPath = resolve(repository, channel.trustList);
  const config = readOperatorConfig(mode, stateDirectory, trustListPath);
  const durable = await createStores(repository, stateDirectory);
  const instance = await durable.instance.read();
  if (!instance || instance.status !== 'linked') throw fixed('deployment is not linked');
  assertIntentLicense(instance, process.env.JOTNOW_LICENSE_KEY);
  if (instance.storeId !== channel.storeId || instance.productId !== channel.productId) {
    throw fixed('linked instance does not match the configured release channel');
  }
  const state = await durable.checkpoint.read();
  const widening = isModeWidening(state, mode);
  const requestedPin = process.env.JOTNOW_RELEASE_PIN || null;
  if (state?.attempt && requestedPin && requestedPin !== state.attempt.target.version) {
    throw fixed('the configured pin differs from the incomplete recovery target');
  }
  const pin = state?.attempt?.target.version ?? requestedPin;
  const downloads = join(stateDirectory, 'downloads');
  await mkdir(downloads, { recursive: true, mode: 0o700 });
  const archive = join(downloads, 'selected-release.tar');
  await rm(archive, { force: true });
  try {
    const selected = await fetchRelease({
      endpoint: channel.releaseEndpoint,
      expectedR2Origin: channel.r2Origin,
      request: {
        schemaVersion: 1,
        licenseKey: process.env.JOTNOW_LICENSE_KEY,
        instanceId: instance.instanceId,
        installed: state?.installedRelease ?? null,
        pin,
      },
      archivePath: archive,
      timeoutMs: config.timeoutMs,
    });
    const adapters = createAdapters(config);
    if (selected.status === 'up-to-date') {
      if (state?.attempt)
        throw fixed('release service cannot satisfy the incomplete recovery target');
      if (widening) throw new UpdaterRefusal('widening_requires_release');
      const lock = await acquireLock(stateDirectory);
      try {
        await adapters.backfill();
      } finally {
        await lock.release();
      }
      process.stdout.write('Release is up to date; recurring embedding backfill queued.\n');
      return;
    }
    const result = await applyUpdate({
      archive,
      stateDirectory,
      bootstrapTrustList: await readFile(trustListPath),
      mode,
      adapters,
      stateStore: durable.checkpoint,
      expectedSelection: selected.expected,
    });
    process.stdout.write(
      `Authenticated BYO release ${result.release.version} sequence ${result.release.sequence} installed.\n`,
    );
  } finally {
    await rm(archive, { force: true });
  }
}

async function link(repository, durable, channel, rest, dependencies) {
  let adoption = null;
  if (rest.length) {
    if (rest.length !== 2 || rest[0] !== '--adopt-instance') throw fixed();
    adoption = rest[1];
  }
  const licenseKey = process.env.JOTNOW_LICENSE_KEY;
  const instanceName = process.env.JOTNOW_INSTANCE_NAME || basename(repository);
  let lifecycle = await durable.instance.read();
  if (lifecycle) assertIntentLicense(lifecycle, licenseKey);
  if (
    lifecycle?.storeId !== undefined &&
    (lifecycle.storeId !== channel.storeId || lifecycle.productId !== channel.productId)
  ) {
    throw fixed('durable lifecycle intent does not match the configured release channel');
  }
  if (lifecycle?.status === 'linked') throw fixed('deployment is already linked');
  if (lifecycle?.status === 'unlinking') {
    throw fixed('deployment unlinking must be completed before relinking');
  }
  if (lifecycle?.phase === 'activation_confirmed') {
    if (adoption) throw fixed('adoption is not valid after activation was confirmed');
    let ownership;
    try {
      ownership = await (dependencies.validateLicenseInstance ?? validateLicenseInstance)({
        licenseKey,
        config: lifecycle,
      });
    } catch {
      throw licenseRecovery();
    }
    if (ownership.status === 'not_found') {
      let availability;
      try {
        availability = await (
          dependencies.validateLicenseAvailability ?? validateLicenseAvailability
        )({ licenseKey, config: lifecycle });
      } catch {
        throw licenseRecovery();
      }
      if (availability.status !== 'available') throw licenseRecovery();
      await durable.instance.checkpoint(compensatedLink(lifecycle));
      process.stdout.write(
        'Confirmed release instance is inactive; its durable intent is resolved. Run Link again to create a new activation.\n',
      );
      return 2;
    }
    await durable.instance.checkpoint(activeLink(lifecycle));
    process.stdout.write('Release instance linked and committed.\n');
    return;
  }
  if (lifecycle?.phase === 'activation_pending' && !adoption) {
    throw licenseRecovery();
  }
  if (lifecycle?.phase === 'activation_pending' && adoption) {
    let ownership;
    try {
      ownership = await (dependencies.validateLicenseInstance ?? validateLicenseInstance)({
        licenseKey,
        config: lifecycle,
        instanceId: adoption,
      });
    } catch {
      throw licenseRecovery();
    }
    lifecycle = confirmedLink(lifecycle, adoption);
    if (ownership.status === 'not_found') {
      let availability;
      try {
        availability = await (
          dependencies.validateLicenseAvailability ?? validateLicenseAvailability
        )({ licenseKey, config: lifecycle });
      } catch {
        throw licenseRecovery();
      }
      if (availability.status !== 'available') throw licenseRecovery();
      await durable.instance.checkpoint(compensatedLink(lifecycle));
      process.stdout.write(
        'Recovered instance is already inactive; its durable intent is resolved. Run Link again to create a new activation.\n',
      );
      return 2;
    }
    await durable.instance.checkpoint(lifecycle);
    await durable.instance.checkpoint(activeLink(lifecycle));
    process.stdout.write('Release instance adopted, linked, and committed.\n');
    return;
  }
  if (adoption) throw fixed('adoption requires an unresolved durable linking intent');
  lifecycle = createLinkingIntent({
    licenseKey,
    instanceName,
    expected: { storeId: channel.storeId, productId: channel.productId },
  });
  await durable.instance.checkpoint(lifecycle);
  let confirmed;
  try {
    confirmed = await (dependencies.activateLicense ?? activateLicense)({
      licenseKey,
      instanceName: lifecycle.instanceName,
      expected: { storeId: channel.storeId, productId: channel.productId },
      existing: lifecycle,
    });
  } catch {
    throw licenseRecovery();
  }
  try {
    await durable.instance.checkpoint(confirmed);
  } catch (checkpointError) {
    let compensationCompleted = false;
    try {
      await (dependencies.deactivateLicense ?? deactivateLicense)({
        licenseKey,
        config: confirmed,
      });
      await durable.instance.checkpoint(compensatedLink(confirmed));
      compensationCompleted = true;
    } catch {
      // The durable activation intent remains unresolved. A later run must
      // validate an explicitly supplied instance and never activates again.
    }
    if (!compensationCompleted) throw licenseRecovery();
    throw checkpointError;
  }
  await durable.instance.checkpoint(activeLink(confirmed));
  process.stdout.write('Release instance linked and committed.\n');
}

async function unlink(durable, channel, rest, dependencies) {
  if (rest.length) throw fixed();
  const licenseKey = process.env.JOTNOW_LICENSE_KEY;
  let lifecycle = await durable.instance.read();
  if (!lifecycle) throw fixed('deployment is not linked');
  assertIntentLicense(lifecycle, licenseKey);
  if (lifecycle.storeId !== channel.storeId || lifecycle.productId !== channel.productId) {
    throw fixed('durable lifecycle intent does not match the configured release channel');
  }
  if (lifecycle.phase === 'activation_pending') {
    throw licenseRecovery();
  }
  if (lifecycle.phase === 'activation_compensated') {
    await durable.instance.checkpoint(null);
    process.stdout.write('Compensated release instance intent cleared.\n');
    return;
  }
  if (lifecycle.phase === 'deactivation_confirmed') {
    await durable.instance.checkpoint(null);
    process.stdout.write('Release instance deactivated and unlinked.\n');
    return;
  }
  if (lifecycle.status !== 'unlinking') {
    lifecycle = pendingUnlink(lifecycle);
    await durable.instance.checkpoint(lifecycle);
  }
  if (lifecycle.phase === 'deactivation_pending') {
    let ownership;
    try {
      ownership = await (dependencies.validateLicenseInstance ?? validateLicenseInstance)({
        licenseKey,
        config: lifecycle,
      });
    } catch {
      throw licenseRecovery('unlink');
    }
    if (ownership.status === 'not_found') {
      let availability;
      try {
        availability = await (
          dependencies.validateLicenseAvailability ?? validateLicenseAvailability
        )({ licenseKey, config: lifecycle });
      } catch {
        throw licenseRecovery('unlink');
      }
      if (availability.status !== 'available') throw licenseRecovery('unlink');
      lifecycle = confirmedUnlink(lifecycle);
      await durable.instance.checkpoint(lifecycle);
      await durable.instance.checkpoint(null);
      process.stdout.write('Release instance was already inactive and is now unlinked.\n');
      return;
    }
    lifecycle = authorizedUnlink(lifecycle);
    await durable.instance.checkpoint(lifecycle);
  }
  try {
    await (dependencies.deactivateLicense ?? deactivateLicense)({ licenseKey, config: lifecycle });
  } catch {
    throw licenseRecovery('unlink');
  }
  lifecycle = confirmedUnlink(lifecycle);
  await durable.instance.checkpoint(lifecycle);
  await durable.instance.checkpoint(null);
  process.stdout.write('Release instance deactivated and unlinked.\n');
}

export async function doctor(repository, stateDirectory, argv, dependencies = {}) {
  const json = argv.includes('--json');
  const allowBillableVoyage = argv.includes('--allow-billable-voyage');
  if (argv.some((arg) => !['--json', '--allow-billable-voyage'].includes(arg))) throw fixed();
  const durable = await (dependencies.stores ?? stores)(repository, stateDirectory);
  const state = await durable.checkpoint.read();
  if (!state?.updaterControl) {
    process.stdout.write(
      'Jotnow doctor: unavailable\nNo authenticated installed release inventory is available; complete an authenticated install before running doctor.\nRead-only diagnostics; no changes made.\n',
    );
    return 2;
  }
  let authenticated;
  try {
    authenticated = await (
      dependencies.authenticateInstalledControl ?? authenticateInstalledControl
    )({ stateDirectory, state });
  } catch {
    process.stdout.write(
      'Jotnow doctor: unavailable\nThe installed release inventory could not be authenticated; no diagnostic provider request was made.\nRead-only diagnostics; no changes made.\n',
    );
    return 2;
  }
  const manifest = authenticated.manifest;
  const timeoutMs = Number(process.env.JOTNOW_DOCTOR_TIMEOUT_MS || 5000);
  let database;
  if (process.env.JOTNOW_DATABASE_URL) {
    try {
      database = (dependencies.createDatabaseAdapter ?? createDatabaseAdapter)({
        databaseUrl: process.env.JOTNOW_DATABASE_URL,
        timeoutMs,
      });
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
  const http = (dependencies.createHttpAdapters ?? createHttpAdapters)({
    projectRef: process.env.JOTNOW_SUPABASE_PROJECT_REF,
    managementToken: process.env.SUPABASE_ACCESS_TOKEN,
    openaiKey: process.env.OPENAI_API_KEY,
    voyageKey: process.env.VOYAGE_API_KEY,
    allowBillableVoyage,
    timeoutMs,
  });
  const report = await (dependencies.runDoctor ?? runDoctor)(
    {
      migrationVersions: manifest.migrations.map((name) => name.slice(0, 14)),
      expectedEpoch: manifest.release.clientCompatibilityEpoch,
      timeoutMs,
    },
    { database, ...http },
  );
  process.stdout.write(json ? `${JSON.stringify(report, null, 2)}\n` : formatReport(report));
  return report.status === 'healthy' ? 0 : report.status === 'unhealthy' ? 1 : 2;
}

export async function main(argv = process.argv.slice(2), dependencies = {}) {
  const repository = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const stateDirectory = join(repository, '.jotnow', 'deployment');
  const delegated = await (dependencies.selectInstalledControl ?? selectInstalledControl)(
    repository,
    stateDirectory,
    argv,
  );
  if (delegated !== false) return delegated === true ? undefined : delegated;
  const [command, ...rest] = argv;
  if (command === 'update') {
    const mode = rest[0] || 'full';
    if (!['full', 'backend-only'].includes(mode) || rest.length > 1) throw fixed();
    await update(repository, stateDirectory, mode, dependencies);
    return;
  }
  if (['backfill', 'repair-guide', 'migration-repair'].includes(command)) {
    await (dependencies.localUpdaterMain ?? localUpdaterMain)(argv);
    return;
  }
  if (command === 'doctor') return doctor(repository, stateDirectory, rest, dependencies);
  const durable = await (dependencies.stores ?? stores)(repository, stateDirectory);
  const channel = await (dependencies.channelConfig ?? channelConfig)(repository);
  if (command === 'link') {
    return link(repository, durable, channel, rest, dependencies);
  }
  if (command === 'unlink') {
    return unlink(durable, channel, rest, dependencies);
  }
  throw fixed(
    'command must be link, unlink, update, backfill, doctor, repair-guide, or migration-repair',
  );
}

export async function runCustomerCli(
  argv = process.argv.slice(2),
  { execute = main, stderr = process.stderr } = {},
) {
  try {
    const result = await execute(argv);
    return Number.isInteger(result) ? result : 0;
  } catch (error) {
    stderr.write(formatCliFailure(error));
    return 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] || '').href) {
  runCustomerCli().then((exitCode) => {
    process.exitCode = exitCode;
  });
}
