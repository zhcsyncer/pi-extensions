# pi-extensions

A collection of Pi extensions by zhcsyncer.

## Packages

- [`@zhcsyncer/pi-recap`](./packages/pi-recap) — recent activity recap extension with optional session title and tmux window sync.

## Install from Git

Install the whole extension bundle from this repository:

```bash
pi install git:github.com/zhcsyncer/pi-extensions@v0.1.0
```

Try without installing:

```bash
pi -e git:github.com/zhcsyncer/pi-extensions
```

## Install individual npm packages

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

## License

MIT
