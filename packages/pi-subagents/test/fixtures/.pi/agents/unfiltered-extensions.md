---
description: Explicit extensions remain visible without an ext selector.
tools: read
extensions: ./ext-alpha.mjs, ./ext-beta.mjs, ./ext-lazy.mjs
skills: false
prompt_mode: replace
expect_tools_present: read, alpha_read, alpha_write, beta_tool, lazy_tool
expect_tools_absent: bash, edit, write, grep, find, ls
expect_prompt_contains: UNFILTERED_EXTENSIONS_MARKER
expect_prompt_absent: PARENT_PROMPT_MARKER
---
UNFILTERED_EXTENSIONS_MARKER
