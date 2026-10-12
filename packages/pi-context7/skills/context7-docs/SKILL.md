---
name: context7-docs
description: >-
  Fetch up-to-date documentation and code examples for any library, framework,
  SDK, CLI tool, or cloud service. Use whenever the user asks about a specific
  library — even well-known ones like React, Next.js, Prisma, Express, Tailwind,
  Django, or Spring Boot — because training data may not reflect recent API
  changes or version updates.

  Always use for: API syntax questions, configuration options, version migration
  issues, "how do I" questions mentioning a library name, debugging that involves
  library-specific behavior, setup instructions, and CLI tool usage.

  Use even when you think you know the answer. Do not rely on training data for
  API details, signatures, or configuration options — they are frequently out of
  date. Prefer this over web search for library documentation.
license: MIT
---

# Context7 Documentation Lookup

Retrieve current documentation and code examples from [Context7](https://context7.com) using the Context7 tools actually available in this session.

## Choose the available tools

- **Legacy extension:** when loaded, this package provides `resolve-library-id` and `query-docs`.
- **Native MCP:** use the exact names and input schemas declared by the user's verified Context7 server for library resolution and documentation queries. Do not invent names, assume a server is connected, or treat a Context7-looking prefix as proof of its source. Declarations may arrive after connection; until verified tools are available, report that limitation instead of guessing.
- Use the user's selected entry point. If both are available and the intended one is unclear, ask which to use; do not issue duplicate queries through both.
- MCP tools exposed as **direct** work without codemode. Scripts are optional when the user has enabled and authorized them; do not enable codemode/tool_search or change tool exposure, mode, or defaultTools to perform a lookup.

In the workflow below, **resolve** and **query** mean the corresponding operations from that selected entry point, not additional tools or aliases.

## When to use

Reach for these tools whenever a question involves a specific library, framework, SDK, CLI tool, or cloud service. Examples:

- "How do I configure caching in Next.js 16?"
- "What's the syntax for Prisma's `findMany` with relations?"
- "Show me a working Tailwind v4 install for a Vite app."
- "How do I rate-limit with `@upstash/ratelimit`?"

## Workflow

1. **Resolve the library ID.** Call the available resolve tool, following its declared schema, with the library name and what to look up in the library's documentation. The tool returns matching libraries with their Context7 IDs (`/org/project` format), descriptions, snippet counts, and quality scores. Pick the best match — prioritize official sources, name match, and high benchmark scores.
2. **Query the docs.** Call the available query tool, following its declared schema, with the chosen library ID and what to look up in the library's documentation, scoped to a single concept — if the question spans multiple distinct concepts, make a separate call per concept with the same library ID, unless the question is about how the concepts interact. The tool returns documentation snippets and code examples.
3. **Answer.** Cite the library ID you used and quote code examples verbatim when relevant.

If the user supplies a library ID in `/org/project` or `/org/project/version` format directly, skip step 1 and use that ID with the available query tool.

## Constraints

- Make at most 3 resolve calls and at most 3 query calls per question, counting across entry points if the user switches. Switching tools does not reset the limits.
- Do not send API keys, passwords, credentials, personal data, or proprietary code in queries or other lookup arguments — they are sent to Context7.
- Legacy authentication prefers `apiKey` in `$PI_CODING_AGENT_DIR/extension-data/pi-context7/config.json` (default agent directory: `~/.pi/agent`), with `CONTEXT7_API_KEY` as an optional fallback. Get a key at https://context7.com/dashboard if needed.
- Native MCP uses the user's configured server authentication, not this extension's config. On a server URL, configuration-source, or authentication-owner conflict, stop and ask; do not overwrite configuration, move keys, or switch accounts/authentication routes.
