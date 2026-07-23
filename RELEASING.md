# Releasing

This repository publishes five public npm packages:

- `@zhcsyncer/pi-extensions`
- `@zhcsyncer/pi-recap`
- `@zhcsyncer/pi-tool-display-intent`
- `@zhcsyncer/pi-todo`
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

npm trusted publishing can only be configured after a package exists. A new package must still be published through the Changesets version-PR flow:

1. Create a short-lived granular npm token that can create the new package and publish its first version. An unscoped, not-yet-created package may require temporary read/write access to all packages owned by the account because it cannot yet be selected by name.
2. Store the token as the repository secret `NPM_BOOTSTRAP_TOKEN`. Do not expose it to pull-request workflows.
3. Review and merge the generated `chore: version packages` PR. `scripts/publish-packages.sh` detects the bootstrap secret, disables OIDC for that publish command, and lets `changeset publish` perform the first publish. Do not run `npm publish` manually.
4. Configure the new package's trusted publisher immediately after the first publish, using `release.yml` and the `npm publish` allowed action.
5. Delete the `NPM_BOOTSTRAP_TOKEN` repository secret and revoke the npm token. With no bootstrap secret, the same script uses trusted publishing (OIDC) for normal releases.

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
4. The workflow validates and publishes every planned package version not already present on npm.
5. The workflow reconciles package tags and creates GitHub Releases for the packages published in that plan.

Publishing and release reconciliation are idempotent. If npm publishing partially succeeds or GitHub Release creation fails, rerun the failed workflow job.
