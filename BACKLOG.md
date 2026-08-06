# Backlog

Repository-level follow-up work that should remain discoverable across sessions.

## Next root bundle release

- [x] Refresh the root bundle and Search Hub documentation before the next release of `@zhcsyncer/pi-extensions`.

  Acceptance criteria:

  - Documentation is bilingual, with English as the default:
    - root: `README.md` in English and `README.zh-CN.md` in Simplified Chinese;
    - Search Hub: `packages/pi-search-hub/README.md` in English and `packages/pi-search-hub/README.zh-CN.md` in Simplified Chinese.
  - The root README clearly explains that the bundle includes the private Search Hub extension and links to its documentation.
  - The Search Hub README explains the local customization relative to upstream, including:
    - integration with `pi-tool-display-intent` and model-written `displaySummary` intents;
    - semantic call lines that display the search query or shortened URL instead of `(N args)`;
    - backend, reader, result-count, combine-health, content-length, and truncation status;
    - inherited global `results.mode` and shared `previewRows` behavior;
    - `web_read.objective` being a Jina CSS selector rather than a natural-language question.
  - Both language versions stay structurally aligned and link to one another.
  - Package file lists and pack checks include both language versions where applicable.
  - Add an appropriate changeset if the documentation update accompanies user-visible behavior changes.

- [ ] Make `@zhcsyncer/pi-ask-user-question` documentation bilingual with English as the default before the next root bundle release.

  Acceptance criteria:

  - Replace the current Chinese-only `packages/pi-ask-user-question/README.md` with:
    - `README.md` in English as the npm/GitHub default;
    - `README.zh-CN.md` in Simplified Chinese.
  - Keep both README heading structures aligned and add reciprocal language links.
  - Preserve upstream documentation separately as `UPSTREAM_README.md`; do not treat it as the maintained English README.
  - Include both maintained README files in the standalone package and root bundle manifests and require both in `scripts/check-pack.mjs`.
  - Add the Ask User Question pair to the bilingual parity check so a missing or structurally divergent translation fails CI.
  - Add an explicit repository-wide rule to `AGENTS.md`: maintained user-facing package documentation is bilingual, with English in `README.md` and Simplified Chinese in `README.zh-CN.md`, unless a documented exception applies.
  - Add the appropriate package and root changeset because the corrected README is user-visible in both npm artifacts.
