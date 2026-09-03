# Changelog

## 0.2.0

### Minor Changes

- 82238c7: Make Fast Mode defaults per model. `/fast default` sets only the current model's startup default and turns this session's switch to match. Unconfigured models start off. Switching models follows that model's in-memory switch. Old global `enabled` and boolean maps are migrated on startup with a warning; a former global ON does not enable every model.

### Patch Changes

- 82238c7: Stop Fast Mode toggles from adding a chat notification. The footer now shows only `⚡ FAST` or dim `fast`.

## 0.1.3

### Patch Changes

- e1cbae6: Keep Fast Mode aligned with Pi 0.84.3: preserve tool choices in Responses wrappers and use response-aware priority billing for built-in xAI models.

## 0.1.2

### Patch Changes

- 1768c9d: Stop Ctrl+F from turning Fast Mode off when the key is released or the terminal loses focus.

## 0.1.1

### Patch Changes

- 2d59426: Load Fast Mode without importing `@earendil-works/pi-ai/api/simple-options`, which Pi's extension loader cannot resolve.

## 0.1.0

### Minor Changes

- 981974e: Add same-model Fast / Priority scheduling for OpenAI and xAI. `/fast` and Ctrl+F toggle an in-memory switch only; `/fast default` writes `settings.json` without changing the current switch. The extension is also embedded in the root bundle.

## Unreleased

Initial public release will be cut by Changesets from `0.0.0`.
