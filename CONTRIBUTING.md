# Contributing

Thanks for improving Agent Mailbox.

## Development

You need Node.js 24 or newer and pnpm 10.

```bash
pnpm install
cp .dev.vars.example .dev.vars
pnpm check
```

Use `pnpm dev` for local development and `pnpm test:watch` while changing code.
Tests should cover behaviour rather than implementation details, and Worker
features should be exercised through the Cloudflare Workers runtime.

The repository is a pnpm workspace. `packages/create-agent-mailbox` contains
the thin npm bootstrapper; it downloads the matching tagged source release and
hands off to the shared setup CLI in `scripts/setup.ts`. Keep setup behaviour in
the shared CLI so cloned and `npx` installations behave the same way.

Safe setup checks that do not contact Cloudflare or deploy anything:

```bash
pnpm run setup --check
node packages/create-agent-mailbox/src/index.ts --help
pnpm --filter create-agent-mailbox build
pnpm --filter create-agent-mailbox pack --dry-run
```

`pnpm check` enforces formatting, type-aware linting, generated Wrangler types,
tests, the packed setup artifact, and a dry-run Worker deployment. Use
`pnpm format` to apply the repository's formatting rules.

## Pull requests

- Keep changes focused and explain the problem being solved.
- Add or update tests for behavioural changes.
- Run `pnpm check` before opening the pull request.
- Treat changes under `skills/` as executable agent behaviour and call them out
  explicitly for security review.
- Do not commit API keys, mailbox tokens, real email contents, deployment
  domains, or production Wrangler configuration.

Use GitHub's private vulnerability reporting flow for security issues rather
than opening a public issue. See [SECURITY.md](SECURITY.md).
