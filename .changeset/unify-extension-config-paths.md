---
"@zhcsyncer/pi-extensions": patch
"@zhcsyncer/pi-todo": patch
"@zhcsyncer/pi-ask-user-question": patch
"@zhcsyncer/pi-subagents": patch
---

Unify Todo, Ask User Question, and Subagents configuration under each extension's `extension-data/<extension-id>/` directory. Existing global and project files migrate atomically with canonical-path precedence, semantic verification, retained conflicts, and de-duplicated warnings; Subagents runtime resources remain in their existing locations, and Todo now ships aligned English and Simplified Chinese documentation.
