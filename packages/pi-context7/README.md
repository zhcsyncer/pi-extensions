# @zhcsyncer/pi-context7

[简体中文](./README.zh-CN.md)

Context7 documentation tools for the [Pi coding agent](https://pi.dev). Registers `resolve-library-id` and `query-docs`, and ships the full upstream `context7-docs` skill.

This package is also embedded in the aggregate `@zhcsyncer/pi-extensions` bundle.

## Install

Standalone:

```bash
pi install npm:@zhcsyncer/pi-context7
```

Or install the whole extension bundle:

```bash
pi install npm:@zhcsyncer/pi-extensions
```

Try without installing:

```bash
pi -e npm:@zhcsyncer/pi-context7
```

## Tools

### `resolve-library-id`

Resolves a package or product name to a Context7-compatible library ID and returns ranked candidates with reputation and snippet metadata. Call this first unless the user already provides an ID in `/org/project` or `/org/project/version` form.

### `query-docs`

Fetches up-to-date documentation and code examples for a resolved library ID. Scope each call to a single concept.

## Skill

The `context7-docs` skill teaches the agent when to reach for these tools instead of relying on training data. The full upstream skill text is retained.

## Authentication

The tools work without setup at IP-based rate limits. For higher quotas, create a free key at [context7.com/dashboard](https://context7.com/dashboard) and put it in the extension config file:

```bash
mkdir -p "$PI_CODING_AGENT_DIR/extension-data/pi-context7"
cat > "$PI_CODING_AGENT_DIR/extension-data/pi-context7/config.json" <<'EOF'
{
  "apiKey": "ctx7sk_..."
}
EOF
```

Default location when `PI_CODING_AGENT_DIR` is unset: `~/.pi/agent/extension-data/pi-context7/config.json`.

`CONTEXT7_API_KEY` remains an optional fallback for scripts/CI. The config file wins when both are set.

## Display

Both tools implement their own compact TUI rendering:

- call lines show `Context7 Resolve <libraryName>` or `Context7 Query <libraryId>`;
- collapsed result lines show success status plus a short summary;
- resolve summaries include candidate count and the top library ID;
- query summaries include UTF-8 size, line count, and an expand hint that respects the active keybinding;
- expand reveals the full model-facing content via Pi's native Markdown renderer;
- HTTP and execution errors use error styling and are marked as tool errors.

Tool-result `details` store only the small render metadata above. The text sent to the model stays aligned with upstream Context7 output.

## Local development

```bash
pnpm --filter @zhcsyncer/pi-context7 check
pi --no-extensions -e ./packages/pi-context7 --list-models nope
```

## License

MIT. Forked from [`@upstash/context7-pi`](https://github.com/upstash/context7). See [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md), [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE), and [`LICENSE`](./LICENSE).
