# Changelog

## Unreleased

- Reviewer `invalid-output` routes receive one same-route, tool-free format-repair attempt only after a no-model host preflight proves the source already contains exactly one complete ReviewReport. Host-side provenance validation accepts framing-only re-emission, both attempts remain audited, and an opt-in `persistRouteSessions` user config retains parent-linked route sessions and their audit paths while defaulting to memory-only.

Initial public release will be cut by Changesets.
