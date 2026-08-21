# Upstream source

This package is a standalone full-source fork of `@rahularya01/pi-cursor`.

- Repository: https://github.com/Rahularya01/pi-cursor
- Tag: `v1.4.25`
- Commit: `5f8e775279f5e41cdd06791a036be4c7141097c3`
- Upstream npm package: `@rahularya01/pi-cursor@1.4.25`
- License: MIT

The production source, generated protobuf bindings, protocol schema, build tooling, tests, smoke scripts, and upstream protocol notes were copied from that revision. Upstream release history is preserved as [`UPSTREAM_CHANGELOG.md`](./UPSTREAM_CHANGELOG.md).

## Local differences

- Published independently as the unscoped `pi-provider-cursor-ask` package; it is not embedded in the repository's root bundle.
- Keeps the upstream `cursor` provider/login identity and `cursor-native` stream API so existing Pi credentials continue to work. OAuth label is `Cursor Ask`, and diagnostics stay `/cursor` subcommands.
- Filters the processed Cursor catalog in `src/models/ask-catalog.ts` to four 1M Claude rows plus Composer 2.5 / Composer 2.5 Fast; all other families are removed and upstream `processModels` remains unchanged.
- Keeps thinking enabled for Claude rows and maps supported Pi levels to explicit Cursor `requestedModelId` plus `thinking`, `context`, `effort`, and `fast` parameters. Composer 2.5 maps Pi `off`/`max` to Cursor Max Mode instead of inventing an effort parameter.
- Accepts both current folded Claude ids and legacy bundled-catalog spellings such as `claude-4.6-opus-thinking`.
- Replaces the upstream user README and changelog with fork-specific bilingual usage documentation and release history.

Future upstream updates are reviewed and merged into this package explicitly rather than inherited through a runtime dependency.
