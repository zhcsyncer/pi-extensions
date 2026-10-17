---
description: Select a whole extension while other loaded extensions stay hidden.
tools: read, ext:ext-alpha.mjs
extensions: ./ext-alpha.mjs, ./ext-beta.mjs, ./ext-lazy.mjs
skills: false
prompt_mode: replace
expect_tools_present: read, alpha_read, alpha_write
expect_tools_absent: bash, edit, write, grep, find, ls, beta_tool, lazy_tool
expect_prompt_contains: ALPHA_ONLY_MARKER
expect_prompt_absent: PARENT_PROMPT_MARKER
---
ALPHA_ONLY_MARKER
