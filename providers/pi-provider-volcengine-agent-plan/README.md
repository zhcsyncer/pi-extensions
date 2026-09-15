# pi-provider-volcengine-agent-plan

[简体中文](./README.zh-CN.md)

Unofficial [Pi](https://github.com/earendil-works/pi-mono) provider for [Volcengine Ark Agent Plan](https://www.volcengine.com/docs/82379/2366394). This community package is not affiliated with or endorsed by Volcengine.

## Features

- Native Pi provider registration and `/login`, with API key validation that does not start inference.
- A maintained static catalog of 12 Agent Plan models, including DeepSeek V4.1 Flash (preview), GLM 5.3 Flash, and Doubao Seed 2.1 Turbo.
- Image input for 9 models; GLM 5.3 and DeepSeek V4 Flash/Pro remain text-only.
- Streaming, thinking, and tool calls, with gateway-specific thinking controls.
- OpenAI Responses routing, except Kimi K2.7 Code, which uses Chat Completions.

Unlike the minimal configuration in [Volcengine's Pi guide](https://www.volcengine.com/docs/82379/2666474), this extension provides login validation, reasoning metadata, reference cost estimates, and model-specific compatibility handling.

## Requirements

- Node.js 20 or newer and Pi (tested with 0.84).
- A dedicated **Agent Plan API key**. Regular Ark and Coding Plan keys are not interchangeable with it.

## Install and log in

```bash
pi install npm:pi-provider-volcengine-agent-plan
```

Restart Pi or run `/reload`, then:

```text
/login volcengine-agent-plan
```

Enter your Agent Plan key and subscription tier. Invalid keys are requested again; temporary validation failures allow retrying or explicitly saving without validation. Select a model with `/model`, or inspect the catalog:

```bash
pi --list-models volcengine-agent-plan
```

For automated environments:

```bash
export ARK_AGENT_PLAN_API_KEY='...'
export ARK_AGENT_PLAN_TIER='medium'
```

`VOLCENGINE_ARK_PLAN_API_KEY` is also accepted. Tiers are `small`, `medium`, `large`, and `max`; the default is `medium`.

## Models and tiers

- Doubao Seed 2.0 Mini and Lite
- Doubao Seed 2.1 Turbo and Seed Evolving
- DeepSeek V4 Flash, V4 Pro, and V4.1 Flash (preview)
- MiniMax M3
- GLM 5.3 and GLM 5.3 Flash
- Kimi K2.7 Code and Kimi K3

Small exposes 11 models. Medium, Large, and Max expose all 12. Kimi K3 remains Medium+ according to the official personal-plan availability table; merely seeing its card in the console does not establish Small-tier access.

The retired Seed 2.0 Code/Pro, MiniMax M2.7, Kimi K2.6, and GLM 5.2 entries are no longer offered. If one was selected previously, choose its replacement with `/model`.

## Thinking and compatibility

- DeepSeek V4.1 Flash exposes `off`, `low`, `high`, and `max`; its thinking toggle uses an explicit gateway control. Seed 2.1 Turbo also supports explicit thinking on/off.
- GLM 5.3 Flash, GLM 5.3, and Kimi K3 expose `low`, `high`, and `max`; they do not offer `off`.
- V4.1 Flash and GLM 5.3 Flash follow Pi's native-provider effort metadata; unsupported `minimal`, `medium`, and `xhigh` choices are hidden.
- Kimi K2.7 Code does not support disabling thinking. It retains Chat Completions routing for tool-call compatibility.
- Successful requests do not guarantee that every model implements distinct behavior for every effort level.

## Cost estimates and limitations

Pi displays estimated public API resource costs, **not the Agent Plan bill or AFP consumption**. For the three new models, CNY reference prices are converted using a fixed approximate 7 CNY/USD; DeepSeek V4.1 Flash uses peak-period rates. Hourly cache storage is not included. Actual subscription charges and quota remain controlled by Volcengine.

The catalog is static and may lag console changes. Full context/output limits, concurrency, and quota reporting are not live-tested. Image/video/audio generation requires separate tools or MCP integration, not these chat model cards.

Keep your API key out of source control, issue reports, and chat messages.

## License

MIT
