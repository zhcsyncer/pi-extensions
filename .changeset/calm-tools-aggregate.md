---
"@zhcsyncer/pi-tool-display-intent": minor
"@zhcsyncer/pi-extensions": minor
---

Add the optional `toolCalls.layout: "aggregate"` Tools view. Every registered built-in, custom, MCP, and late-loaded tool now contributes to one branch-aware summary per user request; successful calls remain as replaceable `done` rows before a settled grace-period fold, collapsed failures stay count-only, and mid-turn assistant narration stays hidden until `Ctrl+O` restores the original timeline of notes plus one target/status summary per call. `Agent` keeps its original renderer by default, images fail open, collapsed `Thinking...` placeholders are stripped, no file-change statistics are inferred or persisted, and switching back to `individual` restores the original renderers over unchanged raw session calls/results.
