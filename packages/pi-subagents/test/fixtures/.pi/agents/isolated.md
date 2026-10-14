---
description: Isolation removes explicitly selected extensions but retains the builtin view.
tools: read, ext:ext-alpha.mjs, ext:ext-lazy.mjs
extensions: ./ext-alpha.mjs, ./ext-beta.mjs, ./ext-lazy.mjs
isolated: true
skills: false
prompt_mode: replace
expect_tools_present: read
expect_tools_absent: bash, edit, write, grep, find, ls, alpha_read, alpha_write, beta_tool, lazy_tool
expect_prompt_contains: ISOLATED_MARKER
expect_prompt_absent: PARENT_PROMPT_MARKER
---
ISOLATED_MARKER
