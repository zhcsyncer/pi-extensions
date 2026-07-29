---
"@zhcsyncer/pi-extensions": patch
"@zhcsyncer/pi-tool-display-intent": patch
---

Keep path-bearing built-in tool call headers compact at narrow widths. Collapsed `read`, `grep`, `find`, `ls`, `edit`, and `write` calls now abbreviate middle path segments while preserving useful anchors and the basename; expanding tools with `Ctrl+O` restores the complete path.
