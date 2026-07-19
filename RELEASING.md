# Releasing

This repository publishes four public npm packages:

- `@zhcsyncer/pi-extensions`
- `@zhcsyncer/pi-recap`
- `@zhcsyncer/pi-tool-display-intent`
- `@zhcsyncer/pi-todo`

Packages version independently. Because the aggregate root tarball embeds child sources, every child release must include a root release of at least the same bump level. Unchanged siblings remain unreleased.

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

npm trusted publishing can only be configured after a package exists. A new package such as `@zhcsyncer/pi-todo` must still be published through the Changesets version-PR flow:

1. Create or rotate a granular npm token with an explicit expiration, read/write access limited to the `@zhcsyncer` package scope, and CI-compatible 2FA settings; store it as the repository secret `NPM_TOKEN`.
2. In a reviewed temporary change, expose that secret as `NPM_TOKEN` only to the Changesets publish step.
3. Merge the generated `chore: version packages` PR and let GitHub Actions perform the first publish. Do not run `npm publish` manually.
4. Configure the package's trusted publisher immediately after the first publish.
5. Remove the temporary workflow token wiring. The encrypted repository secret may remain for future package bootstraps, but must stay disconnected from normal releases and be rotated before its npm expiration date.

### Allow Actions to create pull requests

In GitHub, open **Settings → Actions → General → Workflow permissions** and enable **Allow GitHub Actions to create and approve pull requests**.

## Add a release change

Create a changeset in every user-facing pull request:

```bash
pnpm changeset
```

Select each affected public package and its bump type. When selecting a child package, also select `@zhcsyncer/pi-extensions` with an equal or higher bump.

Changes that do not need a release, such as CI-only or internal documentation changes, do not need a changeset.

## Automated flow

1. Changes with one or more changesets land on `main`.
2. `.github/workflows/release.yml` creates or updates `chore: version packages`.
3. Review and merge that version PR when ready to release.
4. The workflow validates and publishes every planned package version not already present on npm.
5. The workflow reconciles package tags and creates GitHub Releases for the packages published in that plan.

Publishing and release reconciliation are idempotent. If npm publishing partially succeeds or GitHub Release creation fails, rerun the failed workflow job.
