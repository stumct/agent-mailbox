# Publishing checklist

This project should be published from a new Git repository rather than by
changing the visibility of the original private repository. The private
history contains deployment identifiers and author metadata that do not belong
in the public project.

Before publication:

1. Finish and review the sanitised changes in the private repository.
2. Run `pnpm install --frozen-lockfile` and `pnpm check` from a clean clone.
3. Confirm `rg` finds no private domains, usernames, email addresses, account
   identifiers, or production resource names in tracked files.
4. Run a dedicated secret scanner against the tracked tree.
5. Export the reviewed commit without its `.git` directory into a new folder.
6. Initialise a new Git repository using a public or GitHub noreply author
   address, then create one clean initial commit.
7. Inspect `git ls-files`, the initial diff, and the commit metadata before
   creating the public remote.
8. Push only the new repository's `main` branch. Never mirror or force-push the
   original repository.
9. Enable private vulnerability reporting, secret scanning, dependency alerts,
   and branch protection on the public repository.

## Publishing the setup package

`create-agent-mailbox` is a small bootstrap package. A released version
downloads the source archive from the matching Git tag, installs it, and runs
the repository's TypeScript setup CLI. Publish in this order so `npx` can never
point at a missing template:

1. Confirm the package name is still available and enable npm trusted
   publishing for the public GitHub repository.
2. Add the clean public GitHub repository URL to the package's `repository`
   metadata. Do not reuse the private remote URL.
3. Set the same release version in the root and
   `packages/create-agent-mailbox/package.json`, then create the public
   `vX.Y.Z` GitHub tag.
4. Verify the tag's source archive and run `pnpm check`. Every stable or
   prerelease package must have an exact matching tag.
5. Configure the public repository's `npm` environment and authorize
   `.github/workflows/release.yml` as the npm trusted publisher.
6. Publish a GitHub release for the tag. The protected workflow verifies the
   version, packed artifact, tests, and dry-run deployment before publishing
   with OIDC provenance.
7. Test `npx create-agent-mailbox@X.Y.Z --help`, then perform one clean test
   deployment in a disposable Cloudflare zone before promoting the release.

Do not publish the npm package from this private repository: its default source
archive must be the clean public repository and tag.

Keep the original repository private. It remains the only copy of the old
history and any private deployment configuration.
