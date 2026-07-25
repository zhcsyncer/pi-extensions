# Changelog

## 0.2.0

### Minor Changes

- 88a9366: Publish a maintained fork of `@juicesharp/rpiv-todo` 1.20.0 as `@zhcsyncer/pi-todo` and include it in the aggregate bundle. Todo keeps branch-aware tool-result snapshots but hides successful transcript nodes in favor of its persistent widget, while preserving visible errors and intentionally avoiding display-intent metadata.

All notable changes to `@zhcsyncer/pi-todo` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Added atomic `batch` create/update/delete operations and expandable transcript audit summaries.

### Changed

- Restricted Todo guidance to meaningful multi-stage work instead of single-step actions.
- Enforced one in-progress task, required `activeForm`, dependency readiness, and the documented pending → in-progress → completed lifecycle.
- Reported reducer validation failures as real Pi tool errors.

### Fixed

- Isolated live Todo state per extension runtime so concurrent SDK AgentSessions in one process cannot overwrite each other.
- Versioned and structurally validated replay snapshots while retaining compatibility with legacy snapshots.
