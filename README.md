# pi-extensions

A collection of Pi extensions by zhcsyncer.

## Packages

- [`@zhcsyncer/pi-recap`](./packages/pi-recap) — recent activity recap extension with optional session title and tmux window sync.
- [`@zhcsyncer/pi-tool-display-intent`](./packages/pi-tool-display-intent) — compact tool rendering with model-written intent phrases, RPC-visible summaries, and adaptive diffs.
- [`@zhcsyncer/pi-todo`](./packages/pi-todo) — internal fork of `@juicesharp/rpiv-todo` with a persistent task overlay and no duplicate successful tool nodes.

## Install from Git

Install the whole extension bundle from this repository:

```bash
pi install git:github.com/zhcsyncer/pi-extensions@v0.2.0
```

Try without installing:

```bash
pi -e git:github.com/zhcsyncer/pi-extensions
```

## Install from npm

Install the complete bundle:

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
```

When testing `pi-tool-display-intent`, do not load the original `pi-tool-display` or `pi-tool-display-summary` at the same time because all three can own the same built-in tool names.

## Releasing

Add a changeset to each user-facing pull request:

```bash
pnpm changeset
```

The packages are kept on the same version and released together. After changes land on `main`, GitHub Actions opens a version PR. Merging that PR publishes both npm packages and creates a GitHub Release for each package. See [RELEASING.md](./RELEASING.md) for one-time npm and GitHub setup.

## License

MIT

`pi-tool-display-intent` is a modified fork of MIT-licensed [`MasuRii/pi-tool-display`](https://github.com/MasuRii/pi-tool-display) 0.5.0 and adapts the MIT-licensed `displaySummary` mechanism from [`mertdeveci5/pi-tool-display-summary`](https://github.com/mertdeveci5/pi-tool-display-summary) 0.1.0. Full attribution and preserved notices are in [`packages/pi-tool-display-intent/README.md`](./packages/pi-tool-display-intent/README.md), [`LICENSE`](./packages/pi-tool-display-intent/LICENSE), and [`UPSTREAM_LICENSE`](./packages/pi-tool-display-intent/UPSTREAM_LICENSE).

`pi-todo` is forked from MIT-licensed [`@juicesharp/rpiv-todo`](https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-todo) 1.20.0. The exact revision and preserved notices are recorded in [`packages/pi-todo/UPSTREAM_SOURCE.md`](./packages/pi-todo/UPSTREAM_SOURCE.md), [`LICENSE`](./packages/pi-todo/LICENSE), and [`UPSTREAM_LICENSE`](./packages/pi-todo/UPSTREAM_LICENSE).
