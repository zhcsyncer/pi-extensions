# Cursor Wire Protocol & Architecture (upstream snapshot)

> Preserved from `@rahularya01/pi-cursor` v1.4.25 as a transport reference. Cursor Ask keeps this wire behavior but uses the standalone identities and catalog recorded in [`UPSTREAM_SOURCE.md`](../../providers/pi-provider-cursor-ask/UPSTREAM_SOURCE.md).

This document describes the reverse-engineered wire protocol, HTTP/2 streaming architecture, authentication cascade, and payload structure used by `@rahularya01/pi-cursor`.

## Overview

Unlike OpenAI or Anthropic API providers that use standard REST/SSE endpoints, Cursor uses a custom **Connect / Protobuf protocol over HTTP/2**:

```text
Pi Coding Agent (Extension, Node.js)
    ↓ (streamSimple)
In-process node:http2 transport
    ↓ (HTTP/2 POST with Connect framing & Protobuf payloads)
https://agentn.us.api5.cursor.sh / https://api2.cursor.sh
```

## Protocol Specifications

- **Protocol:** Connect RPC v1 (Protobuf binary framing over HTTP/2)
- **Base Endpoint:** `https://agentn.us.api5.cursor.sh` (or overridden via `PI_CURSOR_AGENT_URL`)
- **Auxiliary Endpoint:** `https://api2.cursor.sh` (OAuth, polling, model discovery, usage)
- **Protobuf Schemas:** `src/proto/agent_pb.ts` (generated via `@bufbuild/protobuf`)

## Runtime RPC Endpoints

| RPC Path                                                   | Transport        | Description                                                                                     |
| ---------------------------------------------------------- | ---------------- | ----------------------------------------------------------------------------------------------- |
| `POST /agent.v1.AgentService/Run`                          | HTTP/2 Streaming | Primary conversational RPC. Sends `AgentClientMessage` and streams `AgentServerMessage` frames. |
| `POST /agent.v1.AgentService/GetUsableModels`              | HTTP/2 Unary     | Model discovery. Returns available account models and capabilities.                             |
| `POST /aiserver.v1.AiService/AvailableModels`              | HTTP/2 Unary     | Legacy parameterized model discovery.                                                           |
| `POST /aiserver.v1.DashboardService/GetCurrentPeriodUsage` | HTTP/2 Unary     | Usage quota endpoint. Returns plan spend, percentage used, and reset timestamps.                |

## Authentication Cascade

`pi-cursor` resolves credentials using a 4-tier fallback:

```text
1. CURSOR_ACCESS_TOKEN env var
2. Pi OAuth credentials store (~/.pi/agent/auth.json via PKCE deep-link flow)
3. macOS Keychain (cursor-access-token / cursor-refresh-token via security CLI)
4. Cursor IDE local SQLite DB (globalStorage/state.vscdb; WSL uses the current Windows user only)
```

If an access token is expired or close to expiry, `refreshCursorToken()` sends a refresh request to `POST https://api2.cursor.sh/auth/exchange_user_api_key`.

## Context-Mode Normalization

When using extensions like `context-mode`, trailing context injections (such as `<session_state>` or routing blocks) are appended as user messages. Cursor's message parser maps conversation history into turns and treats the _last_ user message as the active prompt.

To prevent Cursor models from being derailed by side-channel injections:

1. `isContextModeSideChannelText()` identifies side-channel user messages.
2. `normalizeMessagesForCursor()` folds side-channel messages into the `system` prompt framed inside `<provider_context source="context-mode">`.
3. The user's actual prompt is preserved as `userText` for the active turn.

## In-process HTTP/2 transport

Cursor Ask is Node-only and manages streaming and unary RPCs directly with `node:http2`; normal operation does not launch a transport subprocess. Chat turns reuse one HTTP/2 session across sequential `/AgentService/Run` streams, preserving the existing active/idle bridge lifecycle while avoiding another process and TLS handshake.

- **Request:** Serialized `AgentClientMessage` binary frame.
- **Headers:** `x-cursor-client-version` (default: `cli-2026.05.01-eea359f`), `authorization: Bearer <token>`, `connect-protocol-version: 1`.
- **Response:** Streaming binary Connect frames parsed via `@bufbuild/protobuf` `fromBinary()`.
- **Session liveness:** HTTP/2 PING runs every 20s. Completed streams leave the session reusable; idle sessions are unreferenced and active streams are referenced when the runtime supports it.
- **Idle safety net:** Connect timeout defaults to 30s (handshake only). **Activity idle is disabled by default** so long agent turns are not killed. Parent heartbeats every 15s reset the activity timer when it is enabled via `PI_CURSOR_H2_IDLE_TIMEOUT_MS`.

## Stream idle watchdog

`writeNativeStream` arms a silence idle watchdog via `PI_CURSOR_STREAM_IDLE_TIMEOUT_MS`. **Default is `180000` (3 min)**. Set to `0` to disable. The watchdog resets on:

- non-empty text/thinking deltas
- **tokenDelta** (long pure-reasoning turns)
- handled exec round-trips (MCP tools **and** native-tool rejects)
- checkpoints, KV blob get/set, handled interaction queries

Silent retries (`PI_CURSOR_STREAM_IDLE_MAX_RETRIES`, default `5`) recover from silence and transport loss. Blind full-request restarts are blocked once text/thinking was streamed; checkpoint continuation is still allowed so partial output does not force a hard failure.

## Usage and context semantics

Cursor exposes two different token measurements during one agent turn:

- `turnEnded` input/output/cache fields are cumulative billing totals across every internal model invocation, including invocations before and after tool calls.
- `conversationCheckpointUpdate.tokenDetails.usedTokens` is the latest live conversation-context snapshot.

Pi uses usage buckets for cost but `usage.totalTokens` for its context meter and compaction threshold. Cursor Ask temporarily prioritizes context safety: **`totalTokens` is a context observation or estimate, not the sum of billed buckets**. Consumers that sum it (including pi-meter's token-total view) do not get authoritative consumed-token totals. This is an explicit provider compatibility deviation, not a requirement for consumers to special-case Cursor; restoring the standard contract is tracked in [BACKLOG.md](../../BACKLOG.md).

Context and billing have separate lifetimes:

- Positive checkpoint observations replace previous observations, including genuine decreases after upstream summarization. Pending-tool `0/0` placeholders do not erase known context. Missing snapshots never fall back to the cumulative bill.
- Every local reply, including a tool pause, can carry a positive local context estimate without inventing a billing charge. Estimates include the current Pi input and generated content; a validated same-session/model/prompt/tools/history anchor can retain Cursor's hidden prompt overhead. A full-history rebuild invalidates compressed checkpoint anchors. Fresh snapshots remain authoritative; real over-window values are not capped, and Pi's automatic compaction is not disabled.
- The receipt belongs to the upstream Run, not each local tool response. A receipt is consumed once, preserving its original rates. A receipt arriving after a writer closes can be carried to the next same-model reply in that in-memory conversation, even if the old Run already ended. Previously emitted messages are not mutated.
- `tokenDelta` is progress data, not a reliable billed-output counter. When the final receipt is absent, no token classification or cost is invented from it. A partial receipt prices only known buckets; cache-inclusive input is not priced as uncached when its cache split is incomplete.

Pi also has a separate successful-response **silent-overflow** heuristic based on `input + cacheRead`, which can mistake a cumulative Run bill for a single oversized prompt even when `totalTokens` correctly reports context. The Cursor extension narrowly cancels that automatic `overflow` attempt only for a same-model successful Cursor reply with matching **checkpoint-backed** context metadata and a current context below the reserved compaction threshold. Manual/threshold compaction, error/length recovery, missing evidence, estimated-only context, and high context are not cancelled. With no valid checkpoint and a large cumulative bill, Pi may therefore still compact; the provider will not use a possibly low estimate to veto a real overflow. This does not mutate the bill or disable automatic compaction. Pi emits `compaction_start` before the interception hook, so a brief cancelled-compaction indication can remain; no summary request or history replacement occurs when the guard matches. SDK callers loading only the stream function, without the Cursor extension, do not get this hook.

Assistant messages carry Cursor-specific context provenance and billing-completeness metadata. Missing/partial bills and unreported Run receipts also produce sanitized diagnostics. Numeric zero in unknown billing buckets means **no confirmed amount is available**, not that the request was free. Successful receipt-backed costs remain local estimates at the configured model rates, not a reconciliation against Cursor's actual subscription debit.

Limits: context estimates are heuristic and cannot fully reconstruct unreported server-side state. Lost Runs without a final receipt remain unbilled locally; a replacement Run's receipt is not evidence of the lost Run's consumption. Pending late receipts are in-memory only and cannot survive process death or conversation-state eviction. Historical usage records are not rewritten.

## Attributions

Adapted from MIT community research and lineage docs:

- [ephraimduncan/opencode-cursor](https://github.com/ephraimduncan/opencode-cursor)
- [@pi-stef/cursor](https://www.npmjs.com/package/@pi-stef/cursor)
