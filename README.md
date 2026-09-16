# Jotnow self-host deployment template

Use Jotnow with your own Supabase project and the included `byo.jotnow.dev`
web app, or host the web app on your own Cloudflare Pages project.

> **Not yet on sale.** Setup, Link and Update work with a valid license key,
> but the self-host purchase has not opened, so keys are not generally
> available yet.

## Setup at a glance

1. **Create a Supabase project.** Start without AI keys or a Cloudflare account.
   [Project setup](#project-setup)
2. **Create a repository** using this template and add the required GitHub
   secrets and variables.
   [Repository configuration](#repository-configuration)
3. **Configure Supabase Auth** URLs and signup settings.
   [Authentication](#authentication)
4. **Set up Jotnow:** open **Actions → Jotnow deployment → Run workflow**,
   select `setup`, and wait for it to finish. Setup links your license when
   needed, installs the backend, and runs core diagnostics.
5. **Create your confirmed account in Supabase Auth, then open the app.**
   On `byo.jotnow.dev`, enter your receipt's license key at
   the host's access page first. Then enter your Supabase project URL and public
   connection key, sign in and save a note. Open a second browser session to
   check sync. Never put your license or deployment secrets in a URL.

OpenAI and Voyage credentials are optional. Add them later using
[Enable AI](#optional-enable-ai).

Run `update` again for later releases. If a run fails, follow
[the recovery guidance](#recovering-a-failed-run).

## Setup details

### Project setup

Choose your deployment mode:

- **`backend-only`** (new-install default): use `byo.jotnow.dev` with your own
  Supabase backend. No Cloudflare credentials needed.
- **`full`**: web app on your Cloudflare Pages project, backend on Supabase.

Existing installations retain their recorded deployment mode when no mode is
specified. Keep an existing explicit mode setting for subsequent updates.

For `full`, create a **Direct Upload Cloudflare Pages project** before installing:

- Use the account in `CLOUDFLARE_ACCOUNT_ID`.
- Match its name to `JOTNOW_PAGES_PROJECT` and production branch to
  `JOTNOW_PAGES_BRANCH` (default: `main`).
- Give your Cloudflare token Pages edit access in that account.

An empty Pages project is enough. The updater checks it but does not create it.

### Repository configuration

Open **Settings → Secrets and variables → Actions** in your repository.

**Secrets**

| Name                    | Value                            | Required for |
| ----------------------- | -------------------------------- | ------------ |
| `JOTNOW_LICENSE_KEY`    | Your license key                 | Both modes   |
| `JOTNOW_DATABASE_URL`   | Supabase Postgres connection URL | Both modes   |
| `SUPABASE_ACCESS_TOKEN` | Supabase Management API token    | Both modes   |
| `CLOUDFLARE_API_TOKEN`  | Token with Pages edit access     | `full`       |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare account ID            | `full`       |

**Variables**

| Name                          | Value                                                                      |
| ----------------------------- | -------------------------------------------------------------------------- |
| `JOTNOW_SUPABASE_PROJECT_REF` | Your Supabase project ref                                                  |
| `JOTNOW_DEPLOYMENT_MODE`      | Optional: `full` or `backend-only`; new installs default to `backend-only` |
| `JOTNOW_PAGES_PROJECT`        | Existing Pages project name; `full` only                                   |
| `JOTNOW_PAGES_BRANCH`         | Pages production branch; defaults to `main`                                |

The database URL is used for migrations. `SUPABASE_ACCESS_TOKEN` deploys
functions and has **account-wide access**. Both must target your intended
project. Jotnow never receives these credentials.

### Authentication

In **Supabase Dashboard → Authentication → URL Configuration**, set:

- **Site URL:** `https://byo.jotnow.dev` for the included web app.
- **Redirect URL:** `https://byo.jotnow.dev/app`.

For own hosting, use your Pages origin and that origin plus `/app` instead.

The updater does not change Auth settings. `JOTNOW_SITE_URL` and
`JOTNOW_AUTH_CALLBACK_URL` are no longer required and do not configure Supabase.

For the default setup:

- Keep signups closed, email confirmations off, and SMTP unconfigured.
- Create your account in the Dashboard with a password and confirmed email.
- Configure GitHub login separately if wanted.

Password recovery is managed in your own project. Email-based recovery requires SMTP.

### Optional: enable AI

You can take notes, search their text and sync without provider credentials.
When you want AI features, add these secrets in your **Supabase Dashboard →
Edge Functions → Secrets**:

- `OPENAI_API_KEY`: answers, note summaries and Tidy planning.
- `VOYAGE_API_KEY`: embeddings for semantic retrieval.

Both are needed for the current note-indexing pipeline. The providers bill your
accounts. Keep these keys in Supabase; do not duplicate them in GitHub or enter
them in the app. The browser's session-only Recall key is a separate feature.

Missing AI configuration does not invalidate a working notes installation.
Presence of a key is not proof that it is valid or that its provider is healthy.
Saved Recall history remains available to browse.

Open **Settings → Account → Enable AI** in Jotnow and use **Recheck** after
adding keys. This reads configuration status from your authenticated backend;
it never returns key values. When both keys are present, pending AI work can
resume. If a configured provider rejects requests or is unavailable, check its
account and your Edge Function logs.

Supabase's [secret management guide](https://supabase.com/docs/guides/functions/secrets)
links directly to the Dashboard's **Functions → Secrets** page and confirms
that changing secrets does not require redeploying functions.

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

### Automatic updates

The deployment workflow runs `update` every Monday at 04:17 UTC, in whatever
mode your installation recorded. A scheduled event carries no operation input,
so the workflow selects `update` for it explicitly and skips the
dispatch-only `doctor` step.

Enable the **Jotnow deployment** workflow in your repository for the schedule to
run. Disable it if you would rather run every update by hand.

## Doctor and recovery

`doctor` checks migrations, schema compatibility, the self-host marker, backfill,
functions, and providers. **It diagnoses problems; it does not repair them.**

Setup uses the core diagnostic result: schema and function deployment checks
must pass, while optional AI diagnostics do not block installation. This does
not prove your login, end-to-end sync, or provider health; finish the app steps
above. Standalone Doctor retains the detailed results for all requested checks.

Doctor needs authenticated release inventory from an install attempt. If inventory
is missing or cannot be authenticated, it makes no diagnostic provider requests.
It runs from the current template so fixes also apply to older installed releases.

The customer workflow needs only database and Supabase project credentials.
It does not receive provider keys. The normal AI setup path uses the **Enable
AI** section of Jotnow Settings to check configuration stored in Supabase.

The standalone Doctor CLI still supports **locally supplied probe
credentials** for explicit operator diagnostics. These do not read your
Supabase secrets. An absent local probe key does not mean your backend's key is
missing. Its optional Voyage probe can incur a small charge and requires
`--allow-billable-voyage`. No such probe is part of normal setup.

### Recovering a failed run

For a failed first install, check the database connection, Supabase Management
API access, and (for `full`) the Pages project and branch. Fix the reported cause
and rerun `update` for the same release. Doctor cannot check a pre-install
environment without authenticated inventory.

| Finding                                                        | Next step                                                                                                   |
| -------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Interrupted update                                             | Fix the cause; rerun `update` for the recorded release and mode. Preserve recovery state.                   |
| Pending migrations without an interrupted update               | Check release inventory and database history. Update cannot replay an installed release as a schema repair. |
| Remote-only migration history                                  | Check the project and release, then run `repair-guide`. See the repair limits below.                        |
| Notes eligible for backfill                                    | Run `backfill`. It queues eligible notes, including Trash, without resetting jobs.                          |
| Missing marker, incompatible schema version, or damaged schema | Investigate the release and database. Do not change migration history just to clear a diagnostic.           |
| Function or provider failure                                   | Restore the deployment, credential, or dependency; rerun Doctor.                                            |

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
