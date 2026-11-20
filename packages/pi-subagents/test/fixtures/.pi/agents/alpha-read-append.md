---
description: Select one extension tool and append role instructions to the parent.
tools: read, ext:ext-alpha.mjs/alpha_read
extensions: ./ext-alpha.mjs, ./ext-beta.mjs, ./ext-lazy.mjs
skills: false
prompt_mode: append
expect_tools_present: read, alpha_read
expect_tools_absent: bash, edit, write, grep, find, ls, alpha_write, beta_tool, lazy_tool
expect_prompt_contains: PARENT_PROMPT_MARKER, ALPHA_READ_APPEND_MARKER
expect_prompt_absent: ALPHA_ONLY_MARKER
---
ALPHA_READ_APPEND_MARKER
