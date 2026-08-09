# Releasing

This repository publishes twelve public npm packages:

- `@zhcsyncer/pi-extensions`
- `@zhcsyncer/pi-recap`
- `@zhcsyncer/pi-tool-display-intent`
- `@zhcsyncer/pi-todo`
- `@zhcsyncer/pi-glance`
- `@zhcsyncer/pi-plan-mode`
- `@zhcsyncer/pi-context7`
- `@zhcsyncer/pi-ask-user-question`
- `@zhcsyncer/pi-herdr-companion`
- `@zhcsyncer/pi-subagents`
- `@zhcsyncer/pi-fast-mode`
- `@zhcsyncer/pi-meter`
- `pi-provider-volcengine-agent-plan`


Packages version independently. Because the aggregate root tarball embeds bundled child sources, every bundled child release must include a root release of at least the same bump level. The standalone `pi-provider-volcengine-agent-plan` package is excluded from the aggregate tarball and may release without the root. Unchanged siblings remain unreleased.

A successful publish creates package-level Git tags and GitHub Releases. The root package also owns the repository `vX.Y.Z` tag and latest release.

## One-time setup

### Configure npm trusted publishers

In the npm settings for every existing public package, add the same GitHub Actions trusted publisher:

- Organization or user: `zhcsyncer`
- Repository: `pi-extensions`
- Workflow filename: `release.yml`
- Allowed action: `npm publish`
- Environment: leave empty

The release workflow uses OIDC and does not normally require an `NPM_TOKEN`. npm automatically generates provenance for public packages published from this repository.

### Bootstrap a new npm package

npm trusted publishing can only be configured after a package exists. Normal releases never receive an npm token: before publishing, `scripts/check-unbootstrapped-packages.mjs` stops the release if any public workspace package does not yet exist on npm. This happens before `changeset publish`, preventing a partial release.

Create a protected GitHub Environment named `npm-bootstrap`, require reviewer approval, and store a short-lived granular token there as `NPM_BOOTSTRAP_TOKEN`. Only `.github/workflows/bootstrap-npm-package.yml` can use it.

A new package must still pass through the Changesets version-PR flow:

1. Merge the package and its changeset into `main`, then review and merge the generated `chore: version packages` PR.
2. The normal release job stops safely because the package does not exist on npm.
3. Run **Bootstrap npm package** from `main` and enter the exact workspace package name. The workflow verifies a clean `main` checkout, a public workspace manifest, a non-`0.0.0` version with a matching changelog entry, and that the package name is still absent from npm. It publishes only that exact package.
4. Configure the new package's npm Trusted Publisher immediately, using `release.yml` and the `npm publish` allowed action.
5. Re-run the previously failed normal release job. Changesets skips the already-published bootstrap version, publishes any remaining versions through OIDC, and release reconciliation creates the package tag and GitHub Release.
6. Revoke the short-lived token and clear the `NPM_BOOTSTRAP_TOKEN` Environment secret until another new package needs its first publish.

Do not run `npm publish` locally and do not expose the bootstrap token to the normal release or pull-request workflows.

### Allow Actions to create pull requests

In GitHub, open **Settings → Actions → General → Workflow permissions** and enable **Allow GitHub Actions to create and approve pull requests**.

## Add a release change

Create a changeset in every user-facing pull request:

```bash
pnpm changeset
```

Select each affected public package and its bump type. When selecting a bundled child package, also select `@zhcsyncer/pi-extensions` with an equal or higher bump. Standalone packages do not require a root release unless root package contents or documentation also change.

Changes that do not need a release, such as CI-only or internal documentation changes, do not need a changeset.

## Release review gate

Before pushing a release-bearing change to `main`:

1. Run `pnpm changeset status` to calculate the complete release plan.
2. Show the user every planned package with its current version, bump type, and target version.
3. Wait for explicit user review and approval.

Do not push the release-bearing change to `main`, merge the generated version PR, or trigger publishing before that approval.

## Automated flow

1. Changes with one or more changesets land on `main`.
2. `.github/workflows/release.yml` creates or updates `chore: version packages`.
3. Review and merge that version PR when ready to release.
4. The workflow validates that every public workspace package already exists on npm, then publishes every planned package version through OIDC.
5. For a new package, follow the protected bootstrap flow above and re-run the stopped release job.
6. The workflow reconciles package tags and creates GitHub Releases for the packages published in that plan.

Publishing and release reconciliation are idempotent. If npm publishing partially succeeds or GitHub Release creation fails, rerun the failed workflow job.
