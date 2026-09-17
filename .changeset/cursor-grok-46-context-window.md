---
"pi-provider-cursor-ask": patch
---

Report xAI's documented 500K context window for Cursor's Grok 4.6 rows instead of the 200K fallback. Cursor's model metadata carries no window value, so the provider takes the upstream ceiling; before this change every `cursor-grok-4.6*` row (including effort/fast variants) reported 200K, halving the effective context meter for those models.
