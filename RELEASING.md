# Releasing

This repository uses Changesets and GitHub Actions to keep these public npm packages on the same version and publish them together:

- `@zhcsyncer/pi-extensions`
- `@zhcsyncer/pi-recap`

A successful publish also creates package-level Git tags and one repository-level `vX.Y.Z` GitHub Release.

## One-time setup

### 1. Bootstrap the root npm package

Trusted publishing is configured from an existing npm package's settings. Before enabling the workflow for the unpublished root package, publish the already-tagged `v0.1.1` source once:

```bash
git worktree add /tmp/pi-extensions-v0.1.1 v0.1.1
cd /tmp/pi-extensions-v0.1.1
npm publish . --access public
cd -
git worktree remove /tmp/pi-extensions-v0.1.1
```

This avoids publishing unreleased working-tree changes as version `0.1.1`.

### 2. Configure npm trusted publishers

In the npm settings for both packages, add the same GitHub Actions trusted publisher:

- Organization or user: `zhcsyncer`
- Repository: `pi-extensions`
- Workflow filename: `release.yml`
- Allowed action: `npm publish`
- Environment: leave empty

The release workflow uses OIDC and does not require an `NPM_TOKEN`. npm automatically generates provenance for these public packages when trusted publishing is used from this public repository.

### 3. Allow Actions to create pull requests

In GitHub, open **Settings → Actions → General → Workflow permissions** and enable **Allow GitHub Actions to create and approve pull requests**.

## Add a release change

Create a changeset in every user-facing pull request:

```bash
pnpm changeset
```

Select the affected package and bump type, then write a user-facing summary. The fixed package group ensures both packages receive the same final version and are published together.

Changes that do not need a release, such as CI-only or internal documentation changes, do not need a changeset.

## Automated flow

1. Changes with one or more changesets land on `main`.
2. `.github/workflows/release.yml` creates or updates `chore: version packages`.
3. Review and merge that version PR when ready to release.
4. The workflow validates and publishes every package version not already present on npm.
5. The workflow reconciles package tags and creates one `vX.Y.Z` GitHub Release.

Publishing and release reconciliation are idempotent. If npm publishing partially succeeds or GitHub Release creation fails, rerun the failed workflow job.
