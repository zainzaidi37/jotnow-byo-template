const REFUSAL_DEFINITIONS = Object.freeze({
  mode_mismatch: Object.freeze({
    error: 'updater mode differs from durable deployment state',
    operator:
      'This mode change is not permitted. Keep full mode after web publication, and recover any incomplete update in its recorded mode.',
  }),
  release_replay: Object.freeze({
    error: 'release sequence is a replay or downgrade; explicit rollback is not implemented',
    operator:
      'The selected release is already installed or older. Select a newer release; rollback is not supported.',
  }),
  incomplete_recovery_target: Object.freeze({
    error:
      'an incomplete update remains the recovery target; resolve it before selecting another release',
    operator:
      'An incomplete update must be recovered with its original release. Retry that exact release before selecting another.',
  }),
  minimum_previous_release: Object.freeze({
    error: 'installed release does not satisfy the minimum previous release',
    operator:
      'The selected release requires a different previous release. Install the required release in sequence before retrying.',
  }),
  initial_backend_not_empty: Object.freeze({
    error: 'initial deployment requires a verified empty backend',
    operator:
      "Initial installation requires an empty Jotnow backend. Use the updater for the backend's installed release or a fresh Supabase project.",
  }),
  database_history_unavailable: Object.freeze({
    error: 'database migration history is unavailable',
    operator:
      'Database migration history must be readable before this update. Verify database access and retry.',
  }),
  database_history_mismatch: Object.freeze({
    error: 'database migration history does not match this release',
    operator:
      'Database migration history does not match this release. Inspect the actual history and signed release, then follow the manual migration guide before any repair.',
  }),
  database_epoch_unavailable: Object.freeze({
    error: 'database compatibility epoch is unavailable',
    operator:
      'The database compatibility epoch must be readable before this update. Verify database access and migration history before retrying.',
  }),
  database_epoch_mismatch: Object.freeze({
    error: 'release bundle does not support the database compatibility epoch',
    operator:
      'This release does not support the database compatibility epoch. Install the required intermediate release first.',
  }),
  supabase_management_access: Object.freeze({
    error: 'Supabase Management API access preflight failed',
    operator:
      'Supabase Management API access to the configured project is required. Verify the project reference and management access token.',
  }),
  pages_project_prerequisite: Object.freeze({
    error: 'Cloudflare Pages project prerequisite preflight failed',
    operator:
      'The Cloudflare Pages project must already exist and match the configured production branch. Verify the account, token, project, and branch before retrying.',
  }),
  widening_requires_release: Object.freeze({
    error:
      'full mode requires a newer authenticated release; current backend release has no web publication',
    operator:
      'Full mode requires a newer authenticated release; the current backend release has no web publication.',
  }),
});

export const UPDATER_REFUSAL_REASONS = Object.freeze(Object.keys(REFUSAL_DEFINITIONS));

function recognizedReason(value) {
  return typeof value === 'string' && Object.hasOwn(REFUSAL_DEFINITIONS, value) ? value : null;
}

export function normalizeUpdaterRefusalReason(value) {
  try {
    const direct = recognizedReason(value);
    if (direct) return direct;
    if ((typeof value !== 'object' && typeof value !== 'function') || value === null) return null;
    const reason = recognizedReason(value.reason);
    if (reason) return reason;
    return value.code === 'release_replay_refused' ? 'release_replay' : null;
  } catch {
    return null;
  }
}

export class UpdaterRefusal extends Error {
  constructor(reason) {
    const normalized = normalizeUpdaterRefusalReason(reason);
    if (!normalized) throw new TypeError('unknown updater refusal reason');
    super(REFUSAL_DEFINITIONS[normalized].error);
    this.name = 'UpdaterRefusal';
    this.code = 'updater_refused';
    this.reason = normalized;
  }
}

export function updaterRefusalMessage(value) {
  const reason = normalizeUpdaterRefusalReason(value);
  return reason ? REFUSAL_DEFINITIONS[reason].operator : null;
}
