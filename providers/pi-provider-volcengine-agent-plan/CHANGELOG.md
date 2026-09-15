# pi-provider-volcengine-agent-plan

## 0.4.0

### Minor Changes

- 1f888cb: Refresh the Agent Plan catalog with DeepSeek V4.1 Flash (preview), GLM 5.3 Flash, and Doubao Seed 2.1 Turbo, including image input and Responses tool support. Remove the retired Seed 2.0 Code/Pro, MiniMax M2.7, Kimi K2.6, and GLM 5.2 entries; users of those entries should select a replacement with `/model`.

  Update documented context/output limits, including MiniMax M3's 1M context. Add explicit thinking toggles for V4.1 Flash and Seed 2.1 Turbo, and align V4.1 Flash and GLM 5.3 Flash with native-provider `low`/`high`/`max` effort metadata. Hide unsupported `minimal`/`medium`/`xhigh` choices and the off option for GLM 5.3 Flash. Keep Kimi K3 on Medium+ according to the official personal-plan table, yielding 11 Small-tier models and 12 on higher tiers. New-model costs are approximate public API references, not AFP charges.

## 0.3.0

### Minor Changes

- 97d81cf: Add GLM 5.3 to the Volcengine Agent Plan catalog as a Small-tier, text-only Responses model with a 1,024,000-token context window and 128,000 max output tokens. Official Z.ai/Zhipu and Agent Plan docs say thinking cannot be disabled and only `low`/`high`/`max` effort is supported, so the card exposes those Pi thinking levels and copies GLM 5.2's public API reference rates. Live Agent Plan Responses checks accepted OpenAI `reasoning.effort` at `low`/`high`/`max`, streamed output text, and a full tool-result follow-up round through Pi; `thinking.type: disabled` is rejected with `InvalidParameter`. This package does not rewrite the request to Zhipu `thinking.type`. The 1M context window and 128k max output were not live-tested at their limits.

## 0.2.0

### Minor Changes

- 45f8347: Declare image input for the 9 vision-capable Agent Plan models (Doubao Seed 2.0 Mini/Lite/Evolving/Code/Pro, MiniMax M3, Kimi K2.6/K2.7 Code/K3). MiniMax M2.7, GLM 5.2, and DeepSeek V4 Flash/Pro remain text-only because the Agent Plan gateway does not expose a multimodal path for them.

## 0.1.1

### Patch Changes

- da42f35: Correct Agent Plan model metadata by reporting public API reference cost estimates and exposing only the thinking levels supported by Kimi K3.

## 0.1.0

### Minor Changes

- 9f6c91b: Publish the standalone Volcengine Ark Agent Plan provider with native Pi login, tier-aware static models, mixed Responses and Chat routing, reasoning and tool compatibility hooks, and zero-inference API key validation.
