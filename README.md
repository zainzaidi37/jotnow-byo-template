# Jotnow self-host deployment template

Deploy Jotnow to your own Supabase and Cloudflare Pages projects.

> **Enrollment is not open yet.** Link, Update, and automatic updates are disabled.
> The setup steps below apply once enrollment opens.

## Setup at a glance

1. **Create a repository** using this template.
2. **Prepare your projects:** Supabase and, for `full` mode, Cloudflare Pages.
   [Project setup](#project-setup)
3. **Add your GitHub secrets and variables.**
   [Repository configuration](#repository-configuration)
4. **Configure Supabase Auth** and create your account.
   [Authentication](#authentication)
5. **Link your license:** open **Actions → Jotnow deployment → Run workflow**,
   select `link`, and wait for it to finish.
6. **Install:** run the same workflow with `update`.
7. **Check the installation:** run `doctor` for read-only diagnostics.
   [Doctor and recovery](#doctor-and-recovery)

Run `update` again for later releases. If a run fails, follow
[the recovery guidance](#recovering-a-failed-run).

## Setup details

### Project setup

Choose your deployment mode:

- **`full`** (default): web app on Cloudflare Pages, backend on Supabase.
- **`backend-only`**: Supabase backend only; no Cloudflare credentials needed.

For `full`, create a **Direct Upload Cloudflare Pages project** before installing:

- Use the account in `CLOUDFLARE_ACCOUNT_ID`.
- Match its name to `JOTNOW_PAGES_PROJECT` and production branch to
  `JOTNOW_PAGES_BRANCH` (default: `main`).
- Give your Cloudflare token Pages edit access in that account.

An empty Pages project is enough. The updater checks it but does not create it.

### Repository configuration

Open **Settings → Secrets and variables → Actions** in your repository.

**Secrets**

| Name | Value | Required for |
| --- | --- | --- |
| `JOTNOW_LICENSE_KEY` | Your license key | Both modes |
| `JOTNOW_DATABASE_URL` | Supabase Postgres connection URL | Both modes |
| `SUPABASE_ACCESS_TOKEN` | Supabase Management API token | Both modes |
| `CLOUDFLARE_API_TOKEN` | Token with Pages edit access | `full` |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID | `full` |

**Variables**

| Name | Value |
| --- | --- |
| `JOTNOW_SUPABASE_PROJECT_REF` | Your Supabase project ref |
| `JOTNOW_DEPLOYMENT_MODE` | `full` or `backend-only`; defaults to `full` |
| `JOTNOW_PAGES_PROJECT` | Existing Pages project name; `full` only |
| `JOTNOW_PAGES_BRANCH` | Pages production branch; defaults to `main` |

The database URL is used for migrations. `SUPABASE_ACCESS_TOKEN` deploys
functions and has **account-wide access**. Both must target your intended
project. Jotnow never receives these credentials.

### Authentication

In **Supabase Dashboard → Authentication → URL Configuration**, set:

- **Site URL:** your app's HTTPS origin, such as `https://your-project.pages.dev`.
- **Redirect URL:** that origin plus `/app`, such as
  `https://your-project.pages.dev/app`.

The updater does not change Auth settings. `JOTNOW_SITE_URL` and
`JOTNOW_AUTH_CALLBACK_URL` are no longer required and do not configure Supabase.

For the default setup:

- Keep signups closed, email confirmations off, and SMTP unconfigured.
- Create your account in the Dashboard with a password and confirmed email.
- Configure GitHub login separately if wanted.

Password recovery is managed in your own project. Email-based recovery requires SMTP.

## Updates and maintenance

- Run `update` to install newer releases. Each update also runs embedding
  backfill, even when up to date or pinned. You can run `backfill` separately.
- Keep backups; they are recommended, not a deployment requirement.
- If an update fails, retry the **same release and mode** after fixing the cause.
  Do not reset the backend, edit `.jotnow`, or switch releases to bypass recovery.
- Migration drift stops updates. Use [the recovery guidance](#recovering-a-failed-run);
  updates never rewrite migration history.

### Adding Pages to a backend-only installation

1. Resolve any incomplete update in its recorded mode.
2. Create the Pages project and add its credentials.
3. With the current template and a **newer release available**, set
   `JOTNOW_DEPLOYMENT_MODE=full` and run `update`.

Keep that mode for future updates. Switching back to `backend-only` is unsupported,
as is adding Pages from the same already-installed release.

### Automatic updates — when enrollment opens

Restore all three settings in `.github/workflows/jotnow-deployment.yml`:

1. Under `on`, add `schedule: [{ cron: '17 4 * * 1' }]` (Mondays, 04:17 UTC).
2. Set the selected-operation step's `if` to
   `github.event_name == 'schedule' || inputs.operation != 'doctor'`.
3. Set its `OPERATION` value to
   `${{ github.event_name == 'schedule' && 'update' || inputs.operation }}`.

Then enable the deployment workflow in the customer repository.
Adding cron alone is insufficient: scheduled events have no operation input.

## Doctor and recovery

`doctor` checks migrations, schema compatibility, the self-host marker, backfill,
functions, and providers. **It diagnoses problems; it does not repair them.**

Doctor needs authenticated release inventory from an install attempt. If inventory
is missing or cannot be authenticated, it makes no diagnostic provider requests.
It runs from the current template so fixes also apply to older installed releases.

Its workflow step receives the database URL, Supabase project/token, and optional
`OPENAI_API_KEY` and `VOYAGE_API_KEY` secrets. The Voyage check can incur a small
charge and runs only with `allow_billable_voyage` selected.

### Recovering a failed run

For a failed first install, check the database connection, Supabase Management
API access, and (for `full`) the Pages project and branch. Fix the reported cause
and rerun `update` for the same release. Doctor cannot check a pre-install
environment without authenticated inventory.

| Finding | Next step |
| --- | --- |
| Interrupted update | Fix the cause; rerun `update` for the recorded release and mode. Preserve recovery state. |
| Pending migrations without an interrupted update | Check release inventory and database history. Update cannot replay an installed release as a schema repair. |
| Remote-only migration history | Check the project and release, then run `repair-guide`. See the repair limits below. |
| Notes eligible for backfill | Run `backfill`. It queues eligible notes, including Trash, without resetting jobs. |
| Missing marker, incompatible schema version, or damaged schema | Investigate the release and database. Do not change migration history just to clear a diagnostic. |
| Function or provider failure | Restore the deployment, credential, or dependency; rerun Doctor. |

**Repair limits:** `migration-repair` changes bookkeeping only, requires exact typed
confirmation, and cannot execute or undo SQL. Verify SQL effects independently.

**Reading the results:**

- A zero backfill gap does not prove queued jobs finished.
- ACTIVE function metadata does not prove invocation or provider configuration works.
- Schema checks do not verify SQL function bodies, RLS policies, or every index.
- Doctor cannot establish that your database URL and project ref belong together.
- Check individual results even when others are unavailable. Unconfigured optional
  providers prevent an all-healthy result.

### License linking and unlinking

Run `link` once. If activation is interrupted, **do not create another instance**:

1. Find the exact instance UUID at the license provider.
2. Rerun `link` with `license_instance_id`.
3. If that instance is already inactive, Link verifies zero active slots and
   records recovery. Run `link` separately afterward to activate again.

Link validates the key, product, store, and instance name before adopting an
instance. A 404 alone does not prove it is inactive. Without the instance UUID,
an ambiguous activation cannot be recovered automatically.

If saving an activation fails, Link attempts to deactivate that verified instance.
If this also fails, use the recovery steps above.

Run `unlink` to release the linked instance. It saves progress before deactivation;
retries validate ownership or zero active slots before completing. A different
license key is refused before any provider request.

## Technical details

- **Contents:** deployment tools and a public signature trust root. Application
  bundles are downloaded separately; this template contains no credentials or
  private application source.
- **Channel:** pins the production endpoint, licensed product, and trust root.
  Disabled enrollment makes Link and Update refuse before provider calls.
- **Recovery records:** the configuration branch stores progress. `.jotnow/instance.json`
  holds a SHA-256 key fingerprint, product ownership, and lifecycle state;
  the license key stays in GitHub Secrets.
- **Tooling:** Supabase CLI 2.111.0, pnpm 10.15.1, and Wrangler 4.110.0 are
  installed before credentials are exposed. The frozen install disables lifecycle
  scripts. Vendored updater, verifier, and Doctor code fetch no npm code.

## License

This template and its deployment tools use the [MIT License](LICENSE).
Downloaded Jotnow application bundles use their separate commercial license;
MIT does not cover the purchased app or private Jotnow source.
