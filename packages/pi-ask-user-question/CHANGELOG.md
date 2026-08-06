# Changelog

## 0.1.0

### Minor Changes

- 992463b: Publish a maintained structured-question fork with a non-overlay TUI layout, context-aware number-key selection, centered preview columns, and readable expandable post-interaction result rendering, and include it in the aggregate extension bundle.

All notable changes to `@zhcsyncer/pi-ask-user-question` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Added context-aware number shortcuts: `1`–`N` selects or toggles authored options, `N+1` focuses `Type something.`, and later digits become input text.
- Added a readable result renderer that shows answers, notes, errors, and bounded expanded previews after interaction completes.

### Changed

- Render the questionnaire as Pi's normal active custom component instead of a bottom-anchored full-screen overlay. It temporarily replaces the editor in the normal layout, restores the saved editor draft afterward, and leaves the footer separately visible.
- Keep collapse as an in-component one-line mode without overlay visibility side effects.
- Hide the pending tool-call node while the interactive questionnaire is active.
- Center content-sized preview boxes within the right-side preview column instead of aligning them to the terminal edge.
