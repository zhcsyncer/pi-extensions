# pi-extensions

[简体中文](./README.zh-CN.md)

A collection of Pi extensions by zhcsyncer.

## Packages

- [`@zhcsyncer/pi-recap`](./packages/pi-recap) — recent activity recap extension with optional session title and tmux window sync.
- [`@zhcsyncer/pi-tool-display-intent`](./packages/pi-tool-display-intent) — compact tool rendering with model-written intent phrases, RPC-visible summaries, adaptive diffs, and bounded Bash call previews.
- [`@zhcsyncer/pi-todo`](./packages/pi-todo) — maintained fork of `@juicesharp/rpiv-todo` with a persistent task overlay and no duplicate successful tool nodes.
- [`@zhcsyncer/pi-glance`](./packages/pi-glance) — maintained `pi-glance` fork with composable extension statuses, bottom-right context progress, and a highlighted auto-compaction marker.
- [`@zhcsyncer/pi-search-hub`](./packages/pi-search-hub) — bundle-private `web_search` and `web_read` tools integrated with intent-aware rendering.

## Bundle-private Search Hub

The aggregate `@zhcsyncer/pi-extensions` package includes the private Search Hub fork and registers its `web_search` and `web_read` tools. Search Hub is not published as a standalone npm package; install the root bundle to use it.

This fork keeps upstream multi-backend search and page extraction while integrating model-written `displaySummary` intents, semantic query/URL call lines, backend and reader status, and the shared tool-display result modes. See the [Search Hub documentation](./packages/pi-search-hub/README.md) or its [Simplified Chinese version](./packages/pi-search-hub/README.zh-CN.md) for configuration and local behavior.

## Install from Git

Install the whole extension bundle from this repository:

```bash
pi install git:github.com/zhcsyncer/pi-extensions
```

Try without installing:

```bash
pi -e git:github.com/zhcsyncer/pi-extensions
```

## Install from npm

Install the complete bundle, including Glance and the private Search Hub fork:

```bash
pi install npm:@zhcsyncer/pi-extensions
```

Install only recap:

```bash
pi install npm:@zhcsyncer/pi-recap
```

Install only the intent-aware tool display:

```bash
pi install npm:@zhcsyncer/pi-tool-display-intent
```

Install only Todo:

```bash
pi install npm:@zhcsyncer/pi-todo
```

Install only Glance:

```bash
pi install npm:@zhcsyncer/pi-glance
```

## Development

Test the root bundle:

```bash
pi -e . --list-models nope
```

Test a package directly:

```bash
pi -e ./packages/pi-recap --list-models nope
pi --no-extensions -e ./packages/pi-tool-display-intent
pi --no-extensions -e ./packages/pi-todo --list-models nope
pi --no-extensions -e ./packages/pi-glance
pi --no-extensions -e ./packages/pi-search-hub --list-models nope
```

When testing `pi-tool-display-intent`, do not load the original `pi-tool-display` or `pi-tool-display-summary` at the same time because all three can own the same built-in tool names.

## Releasing

Add a changeset to each user-facing pull request:

```bash
pnpm changeset
```

Public packages version independently. A changed child package must include the aggregate root package in the same release plan because the root tarball embeds child sources; unchanged siblings do not release. Before pushing a release-bearing change, present the planned packages and target versions for user review. After approved changes land on `main`, GitHub Actions opens a version PR, and merging that reviewed PR publishes the planned packages and creates their GitHub Releases. See [RELEASING.md](./RELEASING.md) for the complete workflow and one-time npm/GitHub setup.

## License

MIT

`pi-tool-display-intent` is a modified fork of MIT-licensed [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) 0.5.0 and adapts the MIT-licensed `displaySummary` mechanism from [`mertdeveci5/pi-tool-display-summary`](https://github.com/mertdeveci5/pi-tool-display-summary) 0.1.0. Full attribution and preserved notices are in [`packages/pi-tool-display-intent/README.md`](./packages/pi-tool-display-intent/README.md), [`LICENSE`](./packages/pi-tool-display-intent/LICENSE), and [`UPSTREAM_LICENSE`](./packages/pi-tool-display-intent/UPSTREAM_LICENSE).

`pi-todo` is forked from MIT-licensed [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) 1.20.0. The exact revision and preserved notices are recorded in [`packages/pi-todo/UPSTREAM_SOURCE.md`](./packages/pi-todo/UPSTREAM_SOURCE.md), [`LICENSE`](./packages/pi-todo/LICENSE), and [`UPSTREAM_LICENSE`](./packages/pi-todo/UPSTREAM_LICENSE).

`pi-glance` is forked from MIT-licensed [`LinYS77/pi-glance`](https://github.com/LinYS77/pi-glance) 0.5.3. The exact revision and preserved notices are recorded in [`packages/pi-glance/UPSTREAM_SOURCE.md`](./packages/pi-glance/UPSTREAM_SOURCE.md), [`LICENSE`](./packages/pi-glance/LICENSE), and [`UPSTREAM_LICENSE`](./packages/pi-glance/UPSTREAM_LICENSE).

`pi-search-hub` is forked from [`ronnieops/pi-search-hub`](https://github.com/ronnieops/pi-search-hub) 2.8.0, whose package metadata and README declare MIT. Its exact revision and preserved notices are recorded in [`packages/pi-search-hub/UPSTREAM_SOURCE.md`](./packages/pi-search-hub/UPSTREAM_SOURCE.md) and [`UPSTREAM_NOTICE.md`](./packages/pi-search-hub/UPSTREAM_NOTICE.md).
