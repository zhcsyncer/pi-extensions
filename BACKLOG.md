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

## Future packages

- [ ] `pi-herdr-blocked`: companion extension that emits `herdr:blocked` events so HerdR shows `blocked` (not `working`) while Pi waits on ask-question / permission / plan-review prompts.

  Requirement and design source: [`herdr-blocked-extension-design.md`](./herdr-blocked-extension-design.md).

  Acceptance criteria: see the design doc's 验收标准 section (blocked visible via `herdr agent explain`, no stuck-blocked after interrupts, full `idle → working → blocked → working → idle` chain reproducible).

## Next related package release

- [ ] Fix npm / Pi Package Gallery search discoverability alongside the next otherwise-needed package change; do not cut a standalone release only to force reindexing.

  Observed failure mode (2026-07-29):

  - Direct pages and install commands already work, e.g. `https://pi.dev/packages/@zhcsyncer/pi-plan-mode` and `pi install npm:@zhcsyncer/pi-plan-mode`.
  - Pi gallery search depends on the npm search API filtered by `keywords:pi-package`. A package with npm search `score.final = 0` is effectively invisible there even when the registry package and direct page exist.
  - `@zhcsyncer/pi-plan-mode@0.3.0` and `@zhcsyncer/pi-context7@0.1.0` currently return search score `0` (author query `zhcsyncer`); they do not appear in `plan-mode` / `keywords:pi-package plan-mode` top results.
  - For `@zhcsyncer/pi-plan-mode`, the published tarball contains `README.md`, but registry metadata has empty `readmeFilename` / no `readme` body. Search-index download counts also disagree with the downloads API. Treat this as broken search/README ingestion, not “unpublished”.
  - Sibling packages such as `@zhcsyncer/pi-todo`, `@zhcsyncer/pi-recap`, and `@zhcsyncer/pi-extensions` currently have non-zero search scores and remain findable.

  Acceptance criteria:

  - While touching the affected packages for a real user-visible change, also repair discoverability signals:
    - ensure publish leaves npm registry metadata with a non-empty root `README.md` (`readmeFilename` + `readme` body);
    - keep/repair `keywords` including `pi-package` plus package-specific search terms;
    - expand `@zhcsyncer/pi-todo` metadata with broader Pi/task-planning terms such as `pi`, `pi-coding-agent`, `task-management`, and `planning` if still thin;
    - recheck `@zhcsyncer/pi-glance` and apply the same metadata/README fixes if its search score is zero or weak.
  - Prioritize restoring non-zero search score for `@zhcsyncer/pi-plan-mode` and `@zhcsyncer/pi-context7`.
  - Publish through the normal Changesets version PR flow together with the next related user-visible release; do not release solely to poke the npm indexer.
  - After npm has had time to reindex the new versions, verify for each touched public package:
    1. registry package metadata includes README;
    2. npm search API returns the exact package with `score.final > 0` for author/name queries;
    3. `keywords:pi-package <distinctive-term>` can surface it;
    4. `pi.dev/packages/<name>` still works and gallery search can find it;
    5. direct install commands still work.
  - If a package still has search score `0` after reindexing evidence is solid, report upstream (npm and/or Pi gallery) with direct-page + score-0 evidence rather than repeatedly bumping versions.
