import { UpdaterRefusal } from './refusal.mjs';

export class ReleaseReplayRefusal extends UpdaterRefusal {
  constructor() {
    super('release_replay');
    this.name = 'ReleaseReplayRefusal';
    this.code = 'release_replay_refused';
  }
}

export class ReleaseIntegrityRefusal extends Error {
  constructor() {
    super('release package integrity verification failed');
    this.code = 'release_integrity_refused';
  }
}

export function releaseRecordFor(manifest, manifestSha256) {
  const release = manifest.release;
  return Object.freeze({
    version: release.version,
    sequence: release.sequence,
    sourceCommit: release.sourceCommit,
    clientCompatibilityEpoch: release.clientCompatibilityEpoch,
    manifestSha256,
  });
}

function sameRelease(left, right) {
  return (
    left?.version === right.version &&
    left?.sequence === right.sequence &&
    left?.sourceCommit === right.sourceCommit &&
    left?.clientCompatibilityEpoch === right.clientCompatibilityEpoch &&
    left?.manifestSha256 === right.manifestSha256
  );
}

function isPartialInitialMigrationRecovery({ manifest, target, state, preflight, stateExisted }) {
  const applied = preflight.appliedMigrations;
  if (!Array.isArray(applied)) return false;
  const signedVersions = manifest.migrations.map((name) => name.slice(0, 14));
  return (
    stateExisted === true &&
    state.installedRelease === null &&
    manifest.release.minimumPreviousRelease === null &&
    preflight.emptyBackend === false &&
    state.attempt?.phase === 'control_installed' &&
    sameRelease(state.attempt.target, target) &&
    state.updaterControl?.sequence === target.sequence &&
    applied.length > 0 &&
    applied.length < signedVersions.length &&
    applied.every((version, index) => version === signedVersions[index])
  );
}

export function assertApplicable({ manifest, target, state, preflight, stateExisted }) {
  if (preflight === null || typeof preflight !== 'object') {
    throw new UpdaterRefusal('database_history_unavailable');
  }
  let emptyBackend;
  let databaseEpoch;
  let appliedMigrations;
  try {
    emptyBackend = preflight.emptyBackend;
  } catch {
    throw new UpdaterRefusal('database_history_unavailable');
  }
  if (typeof emptyBackend !== 'boolean') {
    throw new UpdaterRefusal('database_history_unavailable');
  }
  try {
    databaseEpoch = preflight.databaseEpoch;
  } catch {
    throw new UpdaterRefusal('database_epoch_unavailable');
  }
  if (databaseEpoch !== null && (!Number.isSafeInteger(databaseEpoch) || databaseEpoch <= 0)) {
    throw new UpdaterRefusal('database_epoch_unavailable');
  }
  try {
    appliedMigrations = preflight.appliedMigrations;
  } catch {
    throw new UpdaterRefusal('database_history_unavailable');
  }
  let migrationHistoryValid = false;
  try {
    migrationHistoryValid =
      (databaseEpoch !== null && appliedMigrations === undefined) ||
      (Array.isArray(appliedMigrations) &&
        !appliedMigrations.some(
          (version) => typeof version !== 'string' || !/^\d{14}$/.test(version),
        ) &&
        new Set(appliedMigrations).size === appliedMigrations.length);
  } catch {
    // A hostile result is reduced to the fixed mismatch reason below.
  }
  if (!migrationHistoryValid) {
    throw new UpdaterRefusal('database_history_mismatch');
  }
  const installed = state.installedRelease;
  const minimum = manifest.release.minimumPreviousRelease;
  if (state.attempt && !sameRelease(state.attempt.target, target)) {
    throw new UpdaterRefusal('incomplete_recovery_target');
  }
  if (installed) {
    if (target.sequence <= installed.sequence) {
      throw new ReleaseReplayRefusal();
    }
    if (minimum === null) throw new UpdaterRefusal('minimum_previous_release');
    if (installed.sequence < minimum.sequence) {
      throw new UpdaterRefusal('minimum_previous_release');
    }
    if (installed.sequence === minimum.sequence && installed.version !== minimum.version) {
      throw new UpdaterRefusal('minimum_previous_release');
    }
  } else {
    if (minimum !== null) throw new UpdaterRefusal('minimum_previous_release');
    const retryingTarget = state.attempt && sameRelease(state.attempt.target, target);
    if (stateExisted && !retryingTarget) {
      throw new UpdaterRefusal('incomplete_recovery_target');
    }
    if (!stateExisted && !emptyBackend) {
      throw new UpdaterRefusal('initial_backend_not_empty');
    }
  }

  if (databaseEpoch === null) {
    const emptyInitial = installed === null && emptyBackend && appliedMigrations.length === 0;
    const partialInitial = isPartialInitialMigrationRecovery({
      manifest,
      target,
      state,
      preflight: { appliedMigrations, emptyBackend },
      stateExisted,
    });
    if (!(emptyInitial || partialInitial)) {
      throw new UpdaterRefusal('database_epoch_unavailable');
    }
  } else if (databaseEpoch !== target.clientCompatibilityEpoch) {
    throw new UpdaterRefusal('database_epoch_mismatch');
  }
  return target;
}
