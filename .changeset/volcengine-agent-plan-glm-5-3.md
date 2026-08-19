---
"pi-provider-volcengine-agent-plan": minor
---

Add GLM 5.3 to the Volcengine Agent Plan catalog as a Small-tier, text-only Responses model with a 1,024,000-token context window and 128,000 max output tokens. Official Z.ai/Zhipu and Agent Plan docs say thinking cannot be disabled and only `low`/`high`/`max` effort is supported, so the card exposes those Pi thinking levels and copies GLM 5.2's public API reference rates. Live Agent Plan Responses checks accepted OpenAI `reasoning.effort` at `low`/`high`/`max`, streamed output text, and a full tool-result follow-up round through Pi; `thinking.type: disabled` is rejected with `InvalidParameter`. This package does not rewrite the request to Zhipu `thinking.type`. The 1M context window and 128k max output were not live-tested at their limits.
