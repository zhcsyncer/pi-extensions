---
"pi-provider-volcengine-agent-plan": minor
---

Refresh the Agent Plan catalog with DeepSeek V4.1 Flash (preview), GLM 5.3 Flash, and Doubao Seed 2.1 Turbo, including image input and Responses tool support. Remove the retired Seed 2.0 Code/Pro, MiniMax M2.7, Kimi K2.6, and GLM 5.2 entries; users of those entries should select a replacement with `/model`.

Update documented context/output limits, including MiniMax M3's 1M context. Add explicit thinking toggles for V4.1 Flash and Seed 2.1 Turbo, and align V4.1 Flash and GLM 5.3 Flash with native-provider `low`/`high`/`max` effort metadata. Hide unsupported `minimal`/`medium`/`xhigh` choices and the off option for GLM 5.3 Flash. Keep Kimi K3 on Medium+ according to the official personal-plan table, yielding 11 Small-tier models and 12 on higher tiers. New-model costs are approximate public API references, not AFP charges.
