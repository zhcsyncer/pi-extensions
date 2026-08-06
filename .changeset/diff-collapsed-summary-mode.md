---
"@zhcsyncer/pi-extensions": minor
"@zhcsyncer/pi-tool-display-intent": minor
---

Add `diff.collapsedMode` to `pi-tool-display-intent`. When set to `summary`, edit and write diffs collapse to a single `↳ diff +N -M • H hunks • F files` stats line (plus a `Ctrl+O to expand` hint) before expansion, instead of the first `diff.collapsedRows` rows. The default `body` keeps the existing preview. The setting is exposed in the `/tool-display-intent` inspector as "Diff collapsed style" and rounds-trips through the v2 config; invalid values fall back to `body`.