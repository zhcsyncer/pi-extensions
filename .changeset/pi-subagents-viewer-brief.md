---
"@zhcsyncer/pi-subagents": minor
---

Add a maintained fork of `@tintinweb/pi-subagents@0.14.3` with a ConversationViewer that defaults to dispatch prompt, one-line tool step summaries, and final/current result instead of full tool-result dumps. Failed or cancelled bash executions show as error steps. Compact collapsible TUI for Agent / get_subagent_result / steer_subagent (Markdown when expanded), with model and effort chips on tool call/result rows. Honesty fixes: queued status/activity, failure `isError` shell mapping, resume chips from stored invocation, steered/stopped overlay chrome, dangling-step settle, stricter header peel and failure heuristics.
