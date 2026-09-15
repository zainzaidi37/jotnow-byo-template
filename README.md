# jotnow self-host deployment template

This reviewable template deploys the jotnow web app to your Cloudflare Pages
project and its backend to your Supabase project. It contains deployment code
and a public signature trust root only—no application payload, private source,
license key, database credential, or provider credential.

The checked-in channel names the production release endpoint, licensed SKU,
and production signature trust root. Enrollment remains disabled: Link and
Update refuse before contacting a provider. This template is launch preparation
and is not yet an installable offer. The deployment workflow has no schedule
while enrollment is disabled.

Set repository secrets for `JOTNOW_LICENSE_KEY`, `JOTNOW_DATABASE_URL`, and
`SUPABASE_ACCESS_TOKEN`. Set repository variables for the project ref and
deployment mode. For `full` mode, also set `CLOUDFLARE_API_TOKEN` and
`CLOUDFLARE_ACCOUNT_ID` secrets plus Pages project/branch variables;
`backend-only` mode does not need those Cloudflare credentials. The database URL is
used by `psql` and `supabase db push`; `SUPABASE_ACCESS_TOKEN` is a separate,
account-wide Management API credential used to deploy functions and is the
broadest credential in the workflow. Jotnow never receives these values.

Set `JOTNOW_DEPLOYMENT_MODE` to `full` or `backend-only`; updates use
that value. If it is unset, updates use `full`.

Before the first `full` deployment, create a **Direct Upload Cloudflare Pages
project** in the account named by `CLOUDFLARE_ACCOUNT_ID`. Its name must exactly
match `JOTNOW_PAGES_PROJECT`, and its production branch must match
`JOTNOW_PAGES_BRANCH` (default `main`). Give the deployment token Pages edit
access in that account. The updater checks that this project exists and that
the name and branch match; it **does not create the project**. An empty project
with no deployments is sufficient. Backend-only mode needs no Pages project.

Configure Auth manually in **your Supabase project's Dashboard → Authentication
→ URL Configuration**: set Site URL to the HTTPS origin that will serve your
app, and add its exact `/app` URL to the redirect allowlist. For example, a
Pages deployment at `https://your-project.pages.dev` uses that Site URL and
`https://your-project.pages.dev/app` as its redirect URL. If you use a different
host, use that host's URLs. The updater does not apply remote Auth settings.
`JOTNOW_SITE_URL` and `JOTNOW_AUTH_CALLBACK_URL` are no longer required inputs;
setting them in GitHub does not configure Supabase Auth.

Keep email signups closed, email confirmations off, and SMTP unconfigured by
default. Create your operator account in the project's Dashboard with its
email confirmed and a password. GitHub login is optional and requires provider
configuration in that same project. Password recovery is an operator task in
your own project; the Dashboard's mail-based recovery actions require SMTP.

Run the Link workflow once. It first commits a sanitized linking intent, then
activates the license, commits the exact instance identity, and marks it active.
`.jotnow/instance.json` contains a SHA-256 key fingerprint, SKU ownership,
and lifecycle phase; the license key remains a GitHub Actions secret. If an
activation response is lost, Link refuses to activate again. Find the exact
instance UUID in the license provider and rerun Link with `license_instance_id`;
the updater adopts it only after the same key, product, store, and instance name
validate. If that instance is already inactive, the updater records the resolved
intent only after a bare same-key and same-SKU validation proves activation usage
is zero, then requires a separate Link run before creating a new activation. A
404 alone is never treated as proof: the provider returns the same 404 shape for
a deleted instance and an instance owned by another key. If a post-activation
Git checkpoint is rejected, the updater attempts to deactivate only that
validated instance. A failed compensation remains a visible unresolved intent
and needs the same adoption flow. The public license
API has no idempotency key, so an instance whose identity is unavailable cannot
be recovered automatically.

Unlink commits its intent before validating ownership and deactivating the exact
instance. A retry can finish after the durable ownership phase when the exact
instance validates, or when same-key and same-SKU validation proves there are no
active slots. A different license key is refused before any provider request. Link and Unlink
therefore resume from a fresh checkout using the configuration branch.

While enrollment is disabled, deploy runs are manual and this scaffold has no
weekly schedule. When enrollment opens, restore all three workflow settings
in `.github/workflows/jotnow-deployment.yml` together:

- Under `on`, add `schedule: [{ cron: '17 4 * * 1' }]` (Mondays, 04:17 UTC).
- Set the selected-operation step's `if` to
  `github.event_name == 'schedule' || inputs.operation != 'doctor'`.
- Set its `OPERATION` environment value to
  `${{ github.event_name == 'schedule' && 'update' || inputs.operation }}`.

A cron trigger alone is insufficient: scheduled events have no operation input.
Enable the deployment workflow in the customer repository after enrollment opens.

Every run performs the recurring embedding
backfill, including an up-to-date or pinned run. Backfill is also available
manually. Backend-only mode never invokes Cloudflare Pages. Migration drift is
fatal; use the manual repair guide and the explicit repair command—scheduled
updates never rewrite migration history.

To add Pages hosting to a completed backend-only installation, first create
the Pages project and configure its credentials, then select `full` for a
manual update with a newer release available. Keep `JOTNOW_DEPLOYMENT_MODE`
set to `full` for later updates. This requires the updated template bootstrap;
old signed updaters refuse the transition by themselves. An incomplete update
must be recovered in its recorded mode before changing mode. Once widened,
full → backend-only is refused. If the backend is already on the latest
release, this transition refuses explicitly; publishing that same release's
web bundle separately is not yet supported.

Run Doctor for read-only migration drift, compatibility epoch, deployment
marker, schema, backfill, Edge Function, and provider diagnostics. It reads the
expected migration inventory and epoch from the signed manifest in the installed
immutable control directory; the template does not contain release migration
SQL. Doctor runs from the current template after authenticating that inventory,
so diagnostic fixes also apply when the installed signed updater is older.
Authentication failure stops before diagnostic provider requests. Before the first authenticated install, Doctor reports that no trusted
inventory is available and makes no provider request. Its step receives only the
database URL, Supabase project/token, and optional `OPENAI_API_KEY` and
`VOYAGE_API_KEY`. The Voyage probe runs only when `allow_billable_voyage` is
explicitly selected because it can incur a small provider charge.

If the first install fails, resolve its stated prerequisite and rerun Install
against the same release. Doctor cannot diagnose a pre-install environment:
it requires the signed inventory left by an authenticated install. Check the
database connection, Management API access to the intended Supabase project,
and, for full mode, the existing Pages project and its production branch.
Do not reset the backend or edit `.jotnow` recovery state to bypass a refusal.

Doctor reports problems; recovery is a separate operator action:

| Diagnostic                                        | Next action                                                                                                                                                                                                                              |
| ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interrupted update                                | Resolve the reported prerequisite and rerun Update for the recorded release and mode. Preserve the recovery state.                                                                                                                       |
| Pending migrations without an incomplete update   | Verify the release inventory and database history before choosing a recovery. Update refuses replay of an already-installed release; it is not a general schema repair command.                                                          |
| Remote-only migration history                     | Check the intended release and database first. Use `repair-guide`; `migration-repair` changes history only, requires exact typed confirmation, and cannot execute or undo SQL. Independently verify SQL effects before changing history. |
| Notes eligible for backfill                       | Run Backfill. It queues eligible notes, including Trash, without resetting existing jobs. A zero gap does not establish that queued jobs completed.                                                                                      |
| Missing marker, epoch mismatch, or damaged schema | Investigate the installed release and database. Doctor does not rewrite these objects; do not change migration history merely to clear the diagnostic.                                                                                   |
| Function or provider check fails                  | Restore the intended deployment, credential, or dependency, then rerun Doctor. ACTIVE metadata does not prove function invocation or runtime provider configuration works.                                                               |

The database URL and Supabase project ref must identify the same intended
project; Doctor cannot verify their provenance. Its schema checks are structural:
a green result does not verify SQL function bodies, RLS policies, or all indexes.
Keep inspecting individual checks when other checks are unavailable. Optional
unconfigured providers still prevent the all-healthy exit status.

Dependency/tool preparation occurs before the credential-bearing operation.
The verifier/updater/doctor are vendored Node source and fetch no npm code.
Supabase CLI 2.111.0, pnpm 10.15.1, and Wrangler 4.110.0 are operator tooling
installed before secrets are exposed. The frozen pnpm install disables lifecycle
scripts. No dependency lifecycle script runs after that point.

Automated backups are recommended but never used as a feature or deployment
gate. A failed update retains its sanitized recovery checkpoint in the
configuration branch; retry the same target. Do not select another release
until the incomplete attempt is deliberately resolved.

## License boundary

This deployment template and its vendored updater, verifier, and doctor tooling
are licensed under the MIT License; see `LICENSE`. Jotnow application bundles
downloaded separately by this tooling remain subject to the Jotnow commercial
license supplied with those bundles. This license does not cover the purchased
application or any private Jotnow source or artifacts.
