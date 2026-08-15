# Changelog

## 0.5.0

### Minor Changes

- 4099afa: Bound Todo to the current execution cycle: use mutation-only V2 replay checkpoints, automatically roll terminal cycles forward without reusing IDs, keep default lists focused on active work, and inject a compact active-state summary into each agent run.

  Move destructive reset out of the model tool and into the confirmed `/todo` TUI flow, with active-work warnings, branch-scoped persistence, legacy V1 replay compatibility, and immediate widget refresh.

  Reject singleton Todo cycles at runtime: an empty or terminal cycle must start with an atomic multi-item batch. Risk, duration, or importance cannot justify a one-task plan; one-milestone work runs directly without filler tasks.

  Remove dependency-graph fields, validation, deletion guards, and UI from the current Todo contract. Todo is now an ordered serial execution focus for surviving context growth and compaction; legacy checkpoints remain replay-compatible while retired dependency data is discarded.

## Unreleased

### Minor Changes

- Bound Todo to the current execution cycle: mutation-only V2 replay checkpoints, automatic rollover without reusing IDs, default lists focused on active work, and a compact active-state summary on each agent run.
- Move destructive reset out of the model tool and into the confirmed `/todo` TUI flow, with active-work warnings, branch-scoped persistence, legacy V1 replay compatibility, and immediate widget refresh.
- Reject singleton Todo cycles: an empty or terminal cycle must start with an atomic multi-item batch. One-milestone work runs directly without filler tasks.
- Remove dependency-graph fields, validation, deletion guards, and UI from the current contract. Legacy checkpoints remain replay-compatible while retired dependency data is discarded.

## 0.4.0

### Minor Changes

- 1d5ad9e: Replace the duplicate `/todos` list command with a `/todo` visual-settings TUI, add atomically persisted widget icon and maximum-height controls, and keep active work visible through priority-aware overflow rendering.

## 0.3.3

### Patch Changes

- 9b1a137: Unify Todo, Ask User Question, and Subagents configuration under each extension's `extension-data/<extension-id>/` directory. Existing global and project files migrate atomically with canonical-path precedence, semantic verification, retained conflicts, and de-duplicated warnings; Subagents runtime resources remain in their existing locations, and Todo now ships aligned English and Simplified Chinese documentation.

## 0.3.2

### Patch Changes

- 44c7eee: Declare and verify compatibility with Pi 0.84 across the bundled extensions.

## 0.3.1

### Patch Changes

- 101d68c: Allow Todo batches to create and start their first task in one operation, accept pending-to-completed reconciliation, remove the redundant activeForm field with legacy replay compatibility, add configurable ASCII, Unicode, and animated Nerd Font icons with static Todo headings and status-aware theme styling, and improve npm/Pi catalog discovery metadata.

## 0.3.0

### Minor Changes

- da42f35: Make Todo reliable for multi-stage work: isolate state per SDK session runtime, enforce lifecycle and dependency contracts, add atomic batch mutations, report validation failures as tool errors, and expose hidden successful calls in expanded audit views. Single-step work is now explicitly excluded from Todo guidance.

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
