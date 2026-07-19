# Changelog

## 0.2.0

### Minor Changes

- 88a9366: Publish a maintained fork of `@juicesharp/rpiv-todo` 1.20.0 as `@zhcsyncer/pi-todo` and include it in the aggregate bundle. Todo keeps branch-aware tool-result snapshots but hides successful transcript nodes in favor of its persistent widget, while preserving visible errors and intentionally avoiding display-intent metadata.

All notable changes to `@zhcsyncer/pi-todo` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Added the initial public fork of `@juicesharp/rpiv-todo` 1.20.0 with a persistent task overlay and branch-aware state snapshots.
- Kept successful Todo tool nodes visually hidden while preserving model-facing content and structured session details; reducer and execution errors remain visible.
- Kept test fixtures package-local so the published extension has no private workspace dependency.
