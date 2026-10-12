# @zhcsyncer/pi-context7

[简体中文](./README.zh-CN.md)

Context7 documentation tools for the [Pi coding agent](https://pi.dev), supporting Pi 1.1+. Forked from [`@upstash/context7-pi`](https://github.com/upstash/context7), with compact result previews, config-file authentication, and a `context7-docs` skill that supports either this package's REST tools or a user-configured native Context7 MCP server.

The REST extension remains the default, including in the `@zhcsyncer/pi-extensions` bundle. It does not require MCP or codemode.

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

## Tools and skill

- `resolve-library-id` finds a Context7 library ID and ranked candidates. Call it first unless the user supplies `/org/project` or `/org/project/version`.
- `query-docs` retrieves documentation and examples for that ID. Keep each call focused on one concept.
- `context7-docs` guides lookups using the actual available legacy or verified native MCP tools. It keeps the resolve-before-query workflow, a limit of three calls per operation per question, and the rule against sending sensitive information.

Results have compact previews; expand to read the full returned text. Errors are reported as tool errors.

## REST authentication

The REST tools support keyless requests subject to IP-based rate limits. For higher quotas, obtain a key at [context7.com/dashboard](https://context7.com/dashboard) and save it as `apiKey`:

```bash
agent_dir="${PI_CODING_AGENT_DIR:-$HOME/.pi/agent}"
mkdir -p "$agent_dir/extension-data/pi-context7"
cat > "$agent_dir/extension-data/pi-context7/config.json" <<'EOF'
{
  "apiKey": "ctx7sk_..."
}
EOF
```

`CONTEXT7_API_KEY` is an optional fallback; the config file wins when both are set. Native MCP authentication is configured separately in Pi; it does not automatically reuse this file.

## Optional native MCP entry point

1. In your chosen Pi profile (agent directory), configure the official Context7 server using its [current setup instructions](https://github.com/upstash/context7#installation) and Pi's [MCP guide](https://github.com/earendil-works/pi/blob/v1.1.0/packages/coding-agent/docs/mcp.md). Keep personal credentials in user configuration. Stop for confirmation if an existing same-name server has a different URL, configuration source, or authentication owner; do not overwrite it or move keys into a project.
2. Verify the connection and the actual library-resolution/query tool names and schemas. Use `direct` exposure for those two verified tools; keep any unapproved tools hidden. Native MCP direct works without codemode. Scripts are optional; this package does not enable codemode/tool_search or change mode/defaultTools.
3. Once verified, disable **only the legacy Context7 extension entry** in that profile with `pi config`. Keep its skill enabled. Do not disable the whole bundle or delete the package, REST config, or credentials.

Alternatively, edit the existing package entry in that profile's settings, preserving any version pin and unrelated filters. For a standalone install, exclude `extensions/context7.ts`; for the bundle, exclude `packages/pi-context7/extensions/context7.ts`. For example, a bundle package entry can be:

```json
{
  "source": "npm:@zhcsyncer/pi-extensions",
  "extensions": ["!packages/pi-context7/extensions/context7.ts"]
}
```

Omit `skills` to keep the package's skills enabled. Run `/reload` after the change. Use a single active query entry point; if both remain visible, check for another explicit extension load before querying.

To roll back, disable the new server in the same profile, restore the legacy extension entry, and reload. No package removal or credential deletion is needed. These are opt-in instructions, not a claim that your server's connection, tools, or account have already been verified.

## License

MIT. See [`UPSTREAM_SOURCE.md`](./UPSTREAM_SOURCE.md), [`UPSTREAM_LICENSE`](./UPSTREAM_LICENSE), and [`LICENSE`](./LICENSE).
