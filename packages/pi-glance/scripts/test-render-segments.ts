import { strict as assert } from "node:assert";
import { defaultConfig } from "../config.js";
import { stripControls } from "../format.js";
import { renderGlanceLine } from "../status-line.js";
import { testState } from "./helpers.js";
import type { GlanceState } from "../types.js";

function line(
	segmentId: "context" | "cost" | "tokens" | "model",
	stateOverrides: Partial<GlanceState> = {},
	mutateConfig?: (config: ReturnType<typeof defaultConfig>) => void,
	width = 120,
): string {
	const config = defaultConfig();
	config.segments = config.segments.map((segment) => ({ ...segment, enabled: segment.id === segmentId }));
	mutateConfig?.(config);
	return stripControls(renderGlanceLine(testState(stateOverrides), config, width));
}

assert.equal(line("context"), "ctx 23% 47k/200k", "context defaults to percent / tokens");
assert.equal(
	line("context", {}, (config) => {
		config.context.display = "percent";
	}),
	"ctx 23%",
	"context can show percent only",
);
assert.equal(
	line("context", {}, (config) => {
		config.context.display = "tokens";
	}),
	"ctx 47k/200k",
	"context can show tokens only",
);
assert.equal(
	line("context", {}, (config) => {
		config.context.display = "progress";
	}),
	"",
	"context progress mode should leave the top status line for bottom-right rendering",
);
assert.equal(
	line("context", { context: { tokens: null, percent: null, window: 200_000 } }, (config) => {
		config.context.unknown = "show";
	}),
	"ctx ? ?/200k",
	"context unknown defaults to visible unknown values",
);
assert.equal(
	line("context", { context: { tokens: null, percent: null, window: 200_000 } }, (config) => {
		config.context.unknown = "hide";
	}),
	"",
	"context unknown can hide the segment",
);
assert.equal(
	line("context", { context: { tokens: null, percent: 23.4, window: 200_000 } }, (config) => {
		config.context.unknown = "hide";
	}),
	"ctx 23% ?/200k",
	"context unknown hide keeps partial context when percent is known",
);

assert.equal(line("cost"), "$ $0.000", "cost defaults to visible zero");
assert.equal(
	line("cost", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }, (config) => {
		config.cost.hideZero = false;
	}),
	"$ $0.000",
	"cost hideZero false keeps zero visible",
);
assert.equal(
	line("cost", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 } }, (config) => {
		config.cost.hideZero = true;
	}),
	"",
	"cost hideZero true hides zero cost",
);
assert.equal(
	line("cost", { usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0.042 } }, (config) => {
		config.cost.hideZero = true;
	}),
	"$ $0.042",
	"cost hideZero true keeps non-zero cost visible",
);

assert.equal(
	line("tokens", { usage: { input: 12_400, output: 3_100, cacheRead: 800, cacheWrite: 20, cost: 0 } }),
	"tok ↑12k ↓3.1k R800 W20",
	"tokens default input/output shows cache in full width",
);
assert.equal(
	line(
		"tokens",
		{ usage: { input: 12_400, output: 3_100, cacheRead: 800, cacheWrite: 20, cost: 0 } },
		(config) => {
			config.tokens.display = "total";
		},
	),
	"tok total 16k R800 W20",
	"tokens can show total usage",
);
assert.equal(
	line("tokens", { usage: { input: 12_400, output: 3_100, cacheRead: 800, cacheWrite: 20, cost: 0 } }, undefined, 80),
	"tok ↑12k ↓3.1k",
	"tokens cache auto hides cache outside full width",
);
assert.equal(
	line(
		"tokens",
		{ usage: { input: 12_400, output: 3_100, cacheRead: 800, cacheWrite: 20, cost: 0 } },
		(config) => {
			config.tokens.cache = "show";
		},
		80,
	),
	"tok ↑12k ↓3.1k R800 W20",
	"tokens cache show keeps cache outside full width",
);
assert.equal(
	line(
		"tokens",
		{ usage: { input: 12_400, output: 3_100, cacheRead: 800, cacheWrite: 20, cost: 0 } },
		(config) => {
			config.tokens.cache = "hide";
		},
	),
	"tok ↑12k ↓3.1k",
	"tokens cache hide removes cache details",
);

assert.equal(line("model"), "ai GPT 5.5", "model auto hides thinking when off");
assert.equal(
	line("model", { model: { id: "gpt-5.5", provider: "openai", displayName: "GPT 5.5", thinking: "high" } }),
	"ai GPT 5.5 high",
	"model auto shows non-off thinking in full width",
);
assert.equal(
	line("model", { model: { id: "gpt-5.5", provider: "openai", displayName: "GPT 5.5", thinking: "high" } }, undefined, 48),
	"ai GPT 5.5",
	"model auto hides thinking in minimal width",
);
assert.equal(
	line(
		"model",
		{ model: { id: "gpt-5.5", provider: "openai", displayName: "GPT 5.5", thinking: "high" } },
		(config) => {
			config.model.showThinking = "never";
		},
	),
	"ai GPT 5.5",
	"model thinking never hides thinking label",
);
assert.equal(
	line(
		"model",
		{ model: { id: "gpt-5.5", provider: "openai", displayName: "GPT 5.5", thinking: "off" } },
		(config) => {
			config.model.showThinking = "always";
		},
		48,
	),
	"ai GPT 5.5 off",
	"model thinking always shows off even in minimal width",
);
assert.equal(
	line(
		"model",
		{ providers: { availableCount: 1 }, model: { id: "gpt-5.5", provider: "openai", displayName: "GPT 5.5", thinking: "off" } },
		(config) => {
			config.display.showProvider = "always";
		},
		48,
	),
	"ai openai/GPT 5.5",
	"provider always shows provider outside full width",
);

console.log("✓ segment render settings checks passed");
