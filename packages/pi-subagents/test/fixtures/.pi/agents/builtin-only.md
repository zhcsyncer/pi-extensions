---
description: Only selected builtins; extension loading is disabled.
tools: read, grep
extensions: false
skills: false
prompt_mode: replace
expect_tools_present: read, grep
expect_tools_absent: bash, edit, write, find, ls, alpha_read, alpha_write, beta_tool, lazy_tool
expect_prompt_contains: BUILTIN_ONLY_MARKER
expect_prompt_absent: PARENT_PROMPT_MARKER
---
BUILTIN_ONLY_MARKER
