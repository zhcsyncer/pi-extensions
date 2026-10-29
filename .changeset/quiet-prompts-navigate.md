---
"@zhcsyncer/pi-tool-display-intent": patch
"@zhcsyncer/pi-extensions": patch
---

Add the persisted User message box setting to use native user-message rendering without changing aggregate steer behavior. Preserve message navigation in styled prompts and avoid removing newer renderer wrappers during reload. Only a leading OSC 133 prompt-start marker is treated as a boundary, so a reply that quotes the sequence no longer invents a prompt stop.
