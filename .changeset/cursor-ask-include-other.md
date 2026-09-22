---
"pi-provider-cursor-ask": patch
---

Cursor quota labels now use Include and Other, matching Cursor's own wording. Composer and Grok still read the Include pool; Claude and other rows still read Other. Meter registration ids changed from `cursor-auto` / `cursor-api` to `cursor-include` / `cursor-other` because those ids appear in the footer brand; a `/reload` after upgrade starts a fresh snapshot under the new ids.
