---
"@zhcsyncer/pi-tool-display-intent": minor
"@zhcsyncer/pi-extensions": minor
---

Add the optional `toolCalls.layout: "aggregate"` Tools view. Every registered built-in, custom, MCP, and late-loaded tool now contributes to one branch-aware summary per user request. The collapsed header shows call and assistant-turn counts. While the turn is running, the latest assistant note stays pinned under the header, above the tool rows, without using a tool slot; after the turn settles, every assistant note hides and a muted receipt under the header shows duration, tokens, cache, and local completion time. Successful calls remain as replaceable `done` rows before a settled grace-period fold, collapsed failures stay count-only, and `Ctrl+O` restores the original timeline of notes plus one target/status summary per call. Aggregate also keeps the user-message box but drops its extra spacer and inner padding. `Agent` keeps its original renderer by default, images fail open, collapsed `Thinking...` placeholders are stripped, no file-change statistics are inferred or persisted, and switching back to `individual` restores the original renderers over unchanged raw session calls/results.
