---
"@zhcsyncer/pi-extensions": minor
"@zhcsyncer/pi-recap": minor
"@zhcsyncer/pi-glance": minor
"@zhcsyncer/pi-tool-display-intent": minor
"@zhcsyncer/pi-plan-mode": minor
---

Unify bundle extension configuration and state under `$PI_CODING_AGENT_DIR/extension-data/<extension-id>/`. Existing global and trusted-project files are migrated and upgraded automatically, unmappable fields are discarded with user-visible warnings, malformed files are preserved, and Plan artifacts remain at `$PI_CODING_AGENT_DIR/plans/`. Search Hub now reads refreshed configuration through Jiti-safe accessors so reader selection, credentials, and round-robin state take effect immediately.
