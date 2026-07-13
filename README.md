# pi-extensions

A collection of Pi extensions by zhcsyncer.

## Packages

- [`@zhcsyncer/pi-recap`](./packages/pi-recap) — recent activity recap extension with optional session title and tmux window sync.

## Install from Git

Install the whole extension bundle from this repository:

```bash
pi install git:github.com/zhcsyncer/pi-extensions@v0.1.4
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

## Development

Test the root bundle:

```bash
pi -e . --list-models nope
```

Test a package directly:

```bash
pi -e ./packages/pi-recap --list-models nope
```

## Releasing

Add a changeset to each user-facing pull request:

```bash
pnpm changeset
```

The packages are kept on the same version and released together. After changes land on `main`, GitHub Actions opens a version PR. Merging that PR publishes both npm packages and creates a GitHub Release for each package. See [RELEASING.md](./RELEASING.md) for one-time npm and GitHub setup.

## License

MIT
