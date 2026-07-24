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

## Next related package release

- [ ] Refresh npm / Pi Package Gallery discoverability alongside the next otherwise-needed package change; do not cut a standalone release only to force reindexing.

  Acceptance criteria:

  - Expand `@zhcsyncer/pi-todo` metadata with broader Pi and task-planning search terms such as `pi`, `pi-coding-agent`, `task-management`, and `planning`.
  - Recheck `@zhcsyncer/pi-glance` and include equivalent metadata improvements if its npm search score is still zero.
  - Publish the metadata update through the normal Changesets version PR flow together with the next related user-visible release.
  - After publishing, verify exact-package and keyword queries through the npm registry search API and the `pi.dev/packages` catalog, while retaining working direct package pages and install commands.
  - If either package remains absent after npm has reindexed the new version, report the indexing issue upstream with the observed zero search score and direct-page evidence.
