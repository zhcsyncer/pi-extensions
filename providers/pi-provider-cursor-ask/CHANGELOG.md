# pi-provider-cursor-ask

## 0.1.5

### Patch Changes

- 5453edf: Add Opus 5.5 to the curated Cursor Ask catalog with 1M context and all five effort levels at normal speed, without sending an unsupported thinking parameter.

## 0.1.4

### Patch Changes

- 2f97f4c: Cursor quota labels now use Include and Other, matching Cursor's own wording. Composer and Grok still read the Include pool; Claude and other rows still read Other. Meter registration ids changed from `cursor-auto` / `cursor-api` to `cursor-include` / `cursor-other` because those ids appear in the footer brand; a `/reload` after upgrade starts a fresh snapshot under the new ids.
- 2f97f4c: Successful Cursor recoveries and protocol noise no longer print a Warning in the chat transcript, and incomplete billing no longer occupies the footer. Those events still go to the lifecycle log; `/cursor usage` and `/cursor doctor` are unchanged.

## 0.1.3

### Patch Changes

- 1192e34: Read system prompt and tools from the Pi 0.86 transcript so Cursor still receives project instructions and tool declarations.
- 1192e34: Require Pi 0.86 or later. These packages follow the 0.86 transcript and no longer support 0.85.

## 0.1.2

### Patch Changes

- ff0eb57: Billing display and diagnostics for turns whose Cursor billing receipt never arrives. Missing receipts are now filled with a local estimate — marked `billing.status: "estimated"` in message metadata — computed from the live context snapshot, accumulated output deltas, and the conversation's previous-context anchor, priced at the model's configured rates. `usage.totalTokens` still carries the context observation and compaction behavior is unchanged. Billing incompleteness no longer writes warnings into the chat transcript: unconsumed receipts show a short footer status, and a normal tool-pause transport close no longer surfaces any warning.
- ff0eb57: Report xAI's documented 500K context window for Cursor's Grok 4.6 rows instead of the 200K fallback. Cursor's model metadata carries no window value, so the provider takes the upstream ceiling; before this change every `cursor-grok-4.6*` row (including effort/fast variants) reported 200K, halving the effective context meter for those models.

## 0.1.1

### Patch Changes

- 082898a: Fix Grok 4.6 and Grok 4.6 Fast quota display to use the Cursor Models pool alongside Composer instead of the Other Models pool.
- 082898a: Recognize Cursor step-start and step-complete events as generation progress instead of reporting spurious wire-protocol drift.

## 0.1.0

### Minor Changes

- 98e7df4: Publish the standalone Cursor Ask provider independently. It replaces `@rahularya01/pi-cursor` under the same `cursor` login, keeps tool execution in Pi, and maps only a curated subset of models: five always-thinking 1M Claude rows, Composer 2.5 / Fast, and Grok 4.6 / Fast when the live account catalog includes them. Other Cursor families are not registered. If Cursor asks for history that is no longer in the local blob store, the current generation fails instead of returning empty history; retry rebuilds from Pi.

Release entries are maintained by Changesets.
