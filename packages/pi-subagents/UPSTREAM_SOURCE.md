# Upstream source

This package was forked from `@tintinweb/pi-subagents` 0.14.3.

- Repository: https://github.com/tintinweb/pi-subagents
- Tag: `v0.14.3`
- Commit: `c10b1836256e760da75296ccd4e57a77ada1325e`
- npm package: `@tintinweb/pi-subagents@0.14.3`
- License: MIT

The production source and upstream tests were copied from that tag before local modifications. The local install under `~/.pi/agent/npm/node_modules/@tintinweb/pi-subagents` was used as the primary version pin; the GitHub tag matched that tree.

## Local differences

- ConversationViewer default overlay shows a **brief progress view** instead of a full conversation dump:
  - **Prompt** — first meaningful user message (long prompts truncated with a note)
  - **Steps** — one-line tool-call summaries with status icons; tool results folded by default
  - **Result** — last non-empty assistant text, or a running indicator while still in flight
- Intermediate assistant chatter is omitted from the default view to reduce noise.
- Optional `o` toggles expanded tool argument/result detail for all steps.
- Pure `messages → brief view model` helpers live in `src/ui/conversation-brief.ts` with unit tests.
- `agent-runner` skips a null parent `modelRuntime` when constructing `createAgentSession` options so typecheck passes against stricter Pi `ModelRuntime` typings.
