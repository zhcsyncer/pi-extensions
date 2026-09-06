---
"@zhcsyncer/pi-tool-display-intent": patch
---

Preserve credential values in the read-only inspector, render Markdown files as Markdown, and highlight Bash command arguments. Edit/Write inspectors now follow shared diff settings exposed in aggregate mode; Write explicitly shows written content as additions rather than an inferred overwrite delta. Long Bash commands stay out of ledger parentheses unless the entire target fits one row, and ordinary replies no longer receive context-growth footers. Terminal-control filtering and bounded viewing remain in place.
