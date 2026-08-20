# Agent Mailbox

Agent Mailbox gives automated tests and AI agents short-lived email addresses
for signup, verification, magic-link, and password-reset flows. It runs in your
own Cloudflare account and exposes both a JSON API and a stateless MCP endpoint.

Each address has a separate random mailbox token. Messages live in a
SQLite-backed Durable Object, attachments live in R2, and an alarm deletes the
mailbox when its time-to-live expires.

## Quick start

You need Node.js 24 or newer and a Cloudflare account with at least one active
domain. Create and deploy a fresh copy with:

```bash
npx create-agent-mailbox@latest
```

> The `create-agent-mailbox` package will become available when the first public
> release is published. Until then, clone this repository and run:

```bash
pnpm install
pnpm run setup
```

The TypeScript CLI uses Wrangler's browser login, loads the active zones
in your account, and recommends dedicated `mail.<domain>` and
`mailbox.<domain>` hostnames. It shows one deployment plan before making any
changes. Once approved, it configures Email Routing, subaddressing and Email
Sending, runs the project checks, and deploys the Worker. Cloudflare provisions
the R2 bucket, Durable Object, DNS records, and inbound address rule from the
Worker configuration. The selected zone's account is pinned in the generated
Worker configuration, so Wrangler does not ask you to choose it again.

The bootstrapper uses Corepack to install the repository's exact pnpm lockfile;
pnpm does not need to be installed globally.

After deployment, the same flow can connect Codex or Claude Code and install
the bundled Agent Mailbox skill. The client receives only the path to a local
credential bridge; the API key remains in the ignored mode-`0600` credentials
file. Restart an already-open client after connecting it.

Each selected zone gets an isolated Worker named after the zone, such as
`agent-mailbox-example-com`. You can deploy Agent Mailbox for multiple domains
in the same Cloudflare account without one setup replacing another domain's
routing, storage, secrets, or configuration. Keep each long-lived deployment in
its own project directory so its generated configuration and credentials remain
available; for example, use `npx create-agent-mailbox@latest mailbox-example-net`
for a second domain.

If Wrangler has multiple authentication profiles, setup asks which one to use
before loading its zones. A single profile is selected automatically. For
scripted setup, pass `--profile <name>` explicitly.

Wrangler OAuth is sufficient; you do not need to create a separate Cloudflare
API token. DNS availability checks use Cloudflare's public DNS resolver, and
Wrangler handles any final custom-domain conflict confirmation during deploy.

The CLI generates a master API key and sends it to Wrangler over standard input,
so it never appears in the command line. A local copy is written to the ignored
`.agent-mailbox.credentials.json` file with mode `0600`; this is the credential
you will give to API or MCP clients. Move it to your password manager if you do
not want to keep the local copy.

Useful setup modes:

```bash
# Validate local setup code and configuration. No login or Cloudflare changes.
pnpm mailbox deploy --check

# Log in, select a zone, and inspect DNS, but make no changes.
pnpm mailbox deploy --plan

# Scripted use after Wrangler is already authenticated.
pnpm mailbox deploy --zone example.com --yes
```

`pnpm run setup` remains as a compatibility alias for `pnpm mailbox deploy`.

## Manage deployments

Agent Mailbox uses Cloudflare as the source of truth rather than maintaining a
second local registry:

```bash
# Find every Agent Mailbox Worker accessible to a Wrangler profile.
pnpm run list

# Check Worker bindings, custom domain, Email Routing, MX records, health,
# local credentials, and authenticated MCP connectivity.
pnpm run doctor

# Configure an installed MCP client and copy the portable Agent Skill.
pnpm run connect

# Safely remove one deployment after showing its exact Cloudflare resources.
pnpm run teardown

# Remove this checkout's MCP client connections and optionally its credentials.
pnpm run disconnect

# Empty and delete an R2 bucket retained by an earlier teardown.
pnpm run purge-data
```

`list` shows which deployment matches the credentials in the current checkout.
`doctor` defaults to the Worker in `wrangler.jsonc`; pass a Worker name, email
domain, or MCP hostname to inspect another discovered instance. Authenticated
MCP checks are skipped for instances whose API key is not available locally.

For non-interactive client setup, select one or more clients explicitly:

```bash
pnpm run connect --client codex --yes
pnpm run connect --client codex --client claude --yes
```

The bundled skill is installed into the selected client's user skill directory.
Use `--no-skill` if you only want the MCP connection. Existing client
connections or skill directories with different contents are left untouched.

### Remove a deployment

`teardown` selects one discovered instance and requires its full Worker name as
confirmation. It removes only that Worker's exact inbound Email Routing rule,
custom domain, Worker, and Durable Object namespace. Shared zone-level Email
Routing DNS, subaddressing, Email Sending, and other Agent Mailbox deployments
remain unchanged.

```bash
# Inspect the exact removal plan without changing Cloudflare.
pnpm run teardown -- agent-mailbox-example-com --dry-run

# Remove the Worker while retaining its R2 attachment bucket.
pnpm run teardown -- agent-mailbox-example-com

# Irreversibly empty and delete the attachment bucket as well.
pnpm run teardown -- agent-mailbox-example-com --purge-data
```

The operation is ordered so the Worker is deleted last. If an earlier step
fails, rerun the same command to continue safely. For unattended use, provide
the instance, Wrangler profile, and `--yes` explicitly.

When teardown retains attachments, it writes an ignored mode-`0600` cleanup
receipt in the project directory. This keeps the exact account and bucket
discoverable after the Worker has gone. Delete it later with:

```bash
pnpm run purge-data
```

Use `disconnect` separately for local cleanup. By default it removes selected
MCP connections and keeps both credentials and the shared skill. Interactive
mode offers to delete matching credentials; scripted use requires
`--remove-credentials`. Because the skill can serve multiple deployments, it is
only deleted with the explicit `--remove-skill` option.

## Redeploy, update, and rotate credentials

Running setup again for the same domain is a safe redeploy. If this project has
matching local credentials, setup reinstalls the same master API key rather
than invalidating connected clients. Replacing the key always requires an
explicit choice or `--rotate-credentials`.

To update a deployment from a future tagged release, create the new source
without deploying, copy the generated configuration and ignored credentials
from the old project, review the changes, and then run setup:

```bash
npx create-agent-mailbox@X.Y.Z agent-mailbox-next --no-deploy
cp agent-mailbox/wrangler.jsonc agent-mailbox/.agent-mailbox.credentials.json agent-mailbox-next/
cd agent-mailbox-next
corepack pnpm run setup
corepack pnpm run doctor
```

Keep the old directory until `doctor` succeeds. Wrangler retains earlier Worker
versions for rollback. If the local credentials are unavailable, setup refuses
non-interactive replacement unless `--rotate-credentials` is supplied.

## Safety model

- A master API key protects every API and MCP request.
- A separate mailbox token protects each created mailbox.
- Mailboxes expire automatically after at most the configured maximum TTL.
- Incoming mail to unknown or expired addresses is rejected.
- Email contents are untrusted data. Link and code extraction is deterministic.
- Outbound sending is rate-limited per mailbox and intended only for test mail.
- API responses containing mailbox data use `Cache-Control: no-store`.

Do not expose a deployment without a strong master API key. This project is a
self-hosted testing tool, not a public disposable-email service.

## Requirements

- Node.js 24 or newer. pnpm 10 is required only when developing from a clone.
- A Cloudflare account with a domain on Cloudflare.
- Access to Cloudflare Email Routing and Email Sending for that domain.

The CLI requires dedicated subdomains rather than taking over an apex domain.
Agent Mailbox creates addresses such as
`inbox+purpose-random@mail.example.com`. Some services reject or normalise `+`
aliases; those services may require a dedicated catch-all implementation in a
future release.

## Manual deployment

The setup CLI is the recommended path. These are the equivalent manual steps.

### 1. Configure the Worker

Edit `wrangler.jsonc` and replace every `example.com` value:

- `name` must be unique for each Agent Mailbox deployment in the Cloudflare
  account.
- `addresses[0]` is the inbound base address, normally
  `inbox@<EMAIL_DOMAIN>`.
- `routes[0].pattern` is the public API and MCP hostname.
- `vars.EMAIL_DOMAIN` is the domain used for generated addresses.
- `vars.MCP_HOSTNAME` is the hostname allowed by the MCP transport.

If you change binding names, run `pnpm exec wrangler types` and commit the
updated `worker-configuration.d.ts`.

### 2. Provision domain-level email features

In the Cloudflare dashboard, open **Compute → Email Service**:

1. [Onboard the receiving domain](https://developers.cloudflare.com/email-service/configuration/domains/).
2. Enable subaddressing in its Email Routing settings.
3. Onboard the same domain under Email Sending.

The Wrangler `addresses` entry creates the inbound address rule when the Worker
is deployed, but DNS, zone-level routing, subaddressing, and sending eligibility
must already be configured.

### 3. Verify and deploy

```bash
pnpm check
pnpm deploy
```

Wrangler provisions the R2 bucket, Durable Object, custom hostname, and inbound
address rule from `wrangler.jsonc`. This deploys the application to your
Cloudflare account; it does not publish this Git repository.

### 4. Protect the deployment

Create a long random value in your password manager, then enter it at Wrangler's
interactive prompt:

```bash
pnpm exec wrangler secret put AGENT_API_KEY
```

Never put this value in `wrangler.jsonc`, a shell command, or source control.

### 5. Verify the deployment

Verify the public health endpoint:

```bash
curl https://mailbox.example.com/health
```

Replace the hostname with your configured route. A successful response is
`{"ok":true}`.

## Local development

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm dev
```

Replace the example secret in `.dev.vars` before starting the Worker. Local
Durable Object and R2 state is stored under the ignored `.wrangler` directory.

Run the complete verification suite with:

```bash
pnpm check
```

## JSON API

All mailbox routes require the master key:

```http
Authorization: Bearer <AGENT_API_KEY>
```

Mailbox-specific operations also require the token returned at creation:

```http
X-Mailbox-Token: <MAILBOX_TOKEN>
```

### Create a mailbox

```bash
curl -X POST https://mailbox.example.com/api/mailboxes \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"purpose":"signup","ttlSeconds":3600}'
```

The response contains `address`, `mailboxToken`, and `expiresAt`. Save the
mailbox token; it cannot be recovered.

### Wait for a verification email

```bash
curl "https://mailbox.example.com/api/mailboxes/$ADDRESS/wait?subject=verify&timeoutSeconds=20" \
  -H "Authorization: Bearer $AGENT_API_KEY" \
  -H "X-Mailbox-Token: $MAILBOX_TOKEN"
```

Routes:

- `POST /api/mailboxes`
- `GET /api/mailboxes/:address/messages`
- `GET /api/mailboxes/:address/messages/:id`
- `GET /api/mailboxes/:address/messages/:id/links`
- `GET /api/mailboxes/:address/messages/:id/codes`
- `GET /api/mailboxes/:address/messages/:id/attachments/:index`
- `GET /api/mailboxes/:address/wait`
- `POST /api/mailboxes/:address/send`
- `DELETE /api/mailboxes/:address`
- `GET /health`

Attachment indexes come from the `attachments` array returned with a complete
message and are zero-based.

## MCP

The Streamable HTTP endpoint is `https://<your-hostname>/mcp`. Configure your MCP
client with that URL and this header:

```http
Authorization: Bearer <AGENT_API_KEY>
```

Available tools:

- `create_mailbox`
- `wait_for_email`
- `list_emails`
- `get_email`
- `get_links`
- `get_codes`
- `send_email`
- `delete_mailbox`

The easiest client setup is:

```bash
pnpm run connect
```

This supports Codex and Claude Code. It gives each deployment a unique MCP
connection name, which allows clients to distinguish multiple Agent Mailbox
domains.

### Optional stdio bridge

Older MCP clients can use `bin/agent-mailbox-mcp`, which runs `mcp-remote` from
this project's dependencies. After automated setup, it reads the endpoint and
key from `.agent-mailbox.credentials.json`:

```bash
bin/agent-mailbox-mcp
```

You can override those generated values with environment variables:

```bash
export AGENT_MAILBOX_MCP_URL=https://mailbox.example.com/mcp
export AGENT_MAILBOX_API_KEY='<master-api-key>'
bin/agent-mailbox-mcp
```

For graphical Linux clients, store the key in Secret Service instead of an
environment variable and configure these non-secret lookup attributes:

```bash
export AGENT_MAILBOX_MCP_URL=https://mailbox.example.com/mcp
export AGENT_MAILBOX_KEYRING_SERVICE=agent-mailbox
export AGENT_MAILBOX_KEYRING_ACCOUNT=agent-mailbox
bin/agent-mailbox-mcp
```

## Operations

- Default mailbox TTL: one day.
- Maximum mailbox TTL: seven days.
- Default outbound limit: 20 messages per mailbox per UTC day.
- Workers logs and traces are enabled in `wrangler.jsonc`; adjust sampling for
  your expected traffic and budget.
- Deleting or expiring a mailbox also deletes its R2 attachments.

Treat the master API key and every mailbox token as credentials. Email bodies,
headers, links, codes, and attachments may contain personal or sensitive data.

## Support, contributing, and security

Open a GitHub issue for reproducible bugs, feature requests, and ordinary usage
questions. See [CONTRIBUTING.md](CONTRIBUTING.md) for development guidance and
[SECURITY.md](SECURITY.md) for private vulnerability reporting. Never include
credentials, mailbox contents, or private deployment identifiers in an issue.

## Licence

Agent Mailbox is available under the [MIT License](LICENSE).
