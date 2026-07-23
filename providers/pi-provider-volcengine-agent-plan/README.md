# pi-provider-volcengine-agent-plan

[简体中文](./README.zh-CN.md)

Unofficial [Pi](https://github.com/badlogic/pi-mono) provider extension for Volcengine Ark Agent Plan at `https://ark.cn-beijing.volces.com/api/plan/v3`.

This community package is not affiliated with or endorsed by Volcengine.

## Features

- Native Pi provider registration and `/login` integration.
- Static catalog for the 13 current Agent Plan text models.
- Tier-aware availability for Small, Medium, Large, and Max plans.
- OpenAI Responses by default, with Chat Completions routing for Kimi K2.6 and Kimi K2.7 Code.
- Streaming, reasoning, and tool-call support tested through the Agent Plan gateway.
- Request compatibility handling for MiniMax M2.7 and Kimi K2.6 thinking controls.
- Zero-inference API key validation before Pi persists a login credential.

## Requirements

- Node.js 20 or newer.
- Pi and `@earendil-works/pi-ai` 0.81.1 or a compatible 0.81 release.
- A dedicated Ark Agent Plan API key. A regular Volcengine Ark API key does not work with the Plan endpoint.

## Install

```bash
pi install npm:pi-provider-volcengine-agent-plan
```

Restart Pi or run `/reload`, then verify the catalog:

```bash
pi --list-models volcengine-agent-plan
```

## Login and credentials

### Interactive login

Run:

```text
/login volcengine-agent-plan
```

Pi prompts for the dedicated Agent Plan API key and the subscribed tier. The login flow sends an authenticated, intentionally incomplete Responses request. A valid key reaches `MissingParameter`; an invalid or unauthorized key returns 401/403 and is requested again. This validation does not start model inference.

Pi stores the API key and selected tier in its standard credential file, normally `~/.pi/agent/auth.json`. The package does not read a custom key file.

### Environment variables

Interactive login is recommended. Ambient credentials remain available for automated environments:

```bash
export ARK_AGENT_PLAN_API_KEY='...'
export ARK_AGENT_PLAN_TIER='medium'
```

`VOLCENGINE_ARK_PLAN_API_KEY` is also accepted as an API key fallback. Supported tier values are `small`, `medium`, `large`, and `max`; the default is `medium` when no tier is configured.

## Models and tiers

The current catalog contains:

- Doubao Seed 2.0 Mini, Lite, Code, and Pro
- Doubao Seed Evolving
- DeepSeek V4 Flash and Pro
- MiniMax M2.7 and M3
- GLM 5.2
- Kimi K2.6, Kimi K2.7 Code, and Kimi K3

Small exposes 12 models. Kimi K3 currently requires Medium or higher. Medium, Large, and Max expose all 13 current text models.

## Compatibility

Kimi K2.6 and Kimi K2.7 Code use Chat Completions because their Agent Plan Responses tool-call path returned repeated server errors during compatibility testing. Other catalog entries use Responses.

Kimi K2.7 Code does not support disabling thinking through the current gateway. Selecting Pi's `off` level therefore avoids sending an unsupported disable control but cannot guarantee that the model stops internal reasoning.

## Security

Pi's standard `auth.json` is protected by filesystem permissions but is not an operating-system keychain. Do not commit credentials, paste them into issue reports, or place them in project configuration.

The API key validation request never logs the key or response body. Temporary network or service failures let the user retry, cancel, or explicitly save without validation.

## Development

From the repository root:

```bash
pnpm --filter pi-provider-volcengine-agent-plan check
pi --no-extensions -e ./providers/pi-provider-volcengine-agent-plan --list-models volcengine-agent-plan
npm pack --dry-run --json ./providers/pi-provider-volcengine-agent-plan
```

Unit tests use mocked credentials and fetch responses. Real-key contract tests are intentionally excluded from normal CI.

## Limitations

Agent Plan does not expose a usable `/models` endpoint, so the catalog and model metadata are versioned statically. Volcengine may change aliases, protocol behavior, limits, or tier availability before this package is updated.

The package currently declares text input only. Image input, extreme context windows, maximum-length output, concurrency, rate limits, and subscription quota reporting are not covered.

## License

MIT
