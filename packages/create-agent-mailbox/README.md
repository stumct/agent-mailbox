# create-agent-mailbox

Create and deploy a self-hosted
[Agent Mailbox](https://github.com/stumct/agent-mailbox) instance in your own
Cloudflare account.

```bash
npx create-agent-mailbox@latest
```

The bootstrapper downloads the source for its exact release tag, installs the
committed dependency lockfile through Corepack, and starts the interactive
Cloudflare setup. Credentials remain in Wrangler's keyring and an ignored local
mode-`0600` credentials file.

See the [project README](https://github.com/stumct/agent-mailbox#readme) for
requirements, lifecycle commands, safety guarantees, and manual deployment.
