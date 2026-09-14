# jotnow self-host deployment template

**Production enrollment is not available.** This repository is a preview of
the deployment tooling. Do not add credentials or run deployment workflows yet.
Jotnow Self-host purchases remain unavailable; see
https://jotnow.dev/self-host/setup for release status.

The checked-in production channel is disabled. Its endpoint and storage origin
are deliberately non-routable, its SKU IDs are unset, and its production trust
file is not provisioned. Link and Update refuse enrollment. Changing only
`enabled` does not make this a usable release. The TEST signing key and TEST
release endpoint must never be substituted for production configuration.

This repository contains deployment tooling and its MIT license. It contains
no application bundle, license key, database credential, provider credential,
or production signature trust root. Before production enrollment can open,
the operator must publish a reviewed production SKU, endpoint, storage origin,
distinct public trust root and authenticated initial release.

Scheduled deployment runs are omitted while enrollment is disabled. The
instructions below describe the intended deployment flow after release; they
are not an invitation to configure an installation today.

## Deployment after release

Set repository secrets for `JOTNOW_LICENSE_KEY`, `JOTNOW_DATABASE_URL`,
`SUPABASE_ACCESS_TOKEN`, `CLOUDFLARE_API_TOKEN`, and
`CLOUDFLARE_ACCOUNT_ID`. Set repository variables for the project ref,
Pages project/branch, and deployment mode. The database URL is
used by `psql` and `supabase db push`; `SUPABASE_ACCESS_TOKEN` is a separate,
account-wide Management API credential used to deploy functions and is the
broadest credential in the workflow. Jotnow never receives these values.

Set `JOTNOW_DEPLOYMENT_MODE` to `full` or `backend-only`; scheduled updates use
that value. If it is unset, scheduled updates use `full`.

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

Deploy runs are scheduled or manual. Every run performs the recurring embedding
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
SQL. Before the first authenticated install, Doctor reports that no trusted
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
