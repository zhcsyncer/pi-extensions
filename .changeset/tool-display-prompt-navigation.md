---
"@zhcsyncer/pi-tool-display-intent": patch
"@zhcsyncer/pi-extensions": patch
---

Restore fullscreen prompt navigation (`ctrl+shift+up` / `ctrl+shift+down`) while the extension is loaded. The rebuilt user message box, compact prompt, and aggregate assistant rows now re-emit Pi's OSC 133 prompt-zone markers at the start of the first row and on the last row, so the transcript can find message boundaries again. Rendered rows are otherwise unchanged.
