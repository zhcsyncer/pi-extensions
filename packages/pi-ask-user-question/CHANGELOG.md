# Changelog

All notable changes to `@zhcsyncer/pi-ask-user-question` are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project follows [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## Unreleased

### Added

- Added `1`–`4` shortcuts for selecting single-choice options and toggling multi-select options.
- Added readable tool call/result renderers that show questions, option descriptions, answers, notes, errors, and bounded expanded previews.

### Changed

- Render the questionnaire as Pi's normal active custom component instead of a bottom-anchored full-screen overlay. It temporarily replaces the editor in the normal layout, restores the saved editor draft afterward, and leaves the footer separately visible.
- Keep collapse as an in-component one-line mode without overlay visibility side effects.
