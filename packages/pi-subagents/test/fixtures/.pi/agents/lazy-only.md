---
description: Select a session_start tool without exposing eager extension tools.
tools: read, ext:ext-lazy.mjs
extensions: ./ext-alpha.mjs, ./ext-beta.mjs, ./ext-lazy.mjs
skills: false
prompt_mode: replace
expect_tools_present: read, lazy_tool
expect_tools_absent: bash, edit, write, grep, find, ls, alpha_read, alpha_write, beta_tool
expect_prompt_contains: LAZY_ONLY_MARKER
expect_prompt_absent: PARENT_PROMPT_MARKER
---
LAZY_ONLY_MARKER
