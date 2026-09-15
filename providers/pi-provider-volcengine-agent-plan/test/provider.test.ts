import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: {
		"@earendil-works/pi-ai/providers/all": fileURLToPath(
			new URL("../node_modules/@earendil-works/pi-ai/dist/providers/all.js", import.meta.url),
		),
		"@earendil-works/pi-ai": fileURLToPath(
			new URL("../node_modules/@earendil-works/pi-ai/dist/compat.js", import.meta.url),
		),
	},
});
const extension = await jiti.import<typeof import("../index.ts")>(
	fileURLToPath(new URL("../index.ts", import.meta.url)),
);
const { getSupportedThinkingLevels, clampThinkingLevel } = await jiti.import<
	typeof import("@earendil-works/pi-ai")
>("@earendil-works/pi-ai");
const {
	default: volcengineAgentPlan,
	createAgentPlanProvider,
	validateAgentPlanKey,
} = extension;

function errorResponse(status: number, code: string): Response {
	return new Response(JSON.stringify({ error: { code } }), {
		status,
		headers: { "Content-Type": "application/json" },
	});
}

test("validates keys without starting inference", async () => {
	const valid = await validateAgentPlanKey("valid", {
		fetchImpl: async (_input, init) => {
			assert.equal(init?.method, "POST");
			assert.equal(init?.body, "{}");
			assert.equal(new Headers(init?.headers).get("Authorization"), "Bearer valid");
			return errorResponse(400, "MissingParameter");
		},
	});
	assert.deepEqual(valid, { status: "valid" });

	const invalid = await validateAgentPlanKey("invalid", {
		fetchImpl: async () => errorResponse(401, "AuthenticationError"),
	});
	assert.deepEqual(invalid, { status: "invalid" });

	const forbidden = await validateAgentPlanKey("forbidden", {
		fetchImpl: async () => errorResponse(403, "Forbidden"),
	});
	assert.deepEqual(forbidden, { status: "invalid" });
});

test("reports temporary validation failures without exposing the key", async () => {
	const result = await validateAgentPlanKey("never-log-this", {
		fetchImpl: async () => {
			throw new Error("network unavailable");
		},
	});
	assert.deepEqual(result, {
		status: "unavailable",
		reason: "network unavailable",
	});
	assert.doesNotMatch(JSON.stringify(result), /never-log-this/);
});

test("re-prompts an invalid key and stores the selected tier", async () => {
	const provider = createAgentPlanProvider({
		fetchImpl: async (_input, init) => {
			const authorization = new Headers(init?.headers).get("Authorization");
			return authorization === "Bearer valid-key"
				? errorResponse(400, "MissingParameter")
				: errorResponse(401, "AuthenticationError");
		},
	});
	const login = provider.auth.apiKey?.login;
	assert.ok(login);

	let secretPrompts = 0;
	const notifications: string[] = [];
	const credential = await login({
		signal: new AbortController().signal,
		async prompt(prompt) {
			if (prompt.type === "secret") {
				secretPrompts += 1;
				return secretPrompts === 1 ? "invalid-key" : "valid-key";
			}
			if (prompt.type === "select") return "medium";
			throw new Error(`Unexpected prompt type: ${prompt.type}`);
		},
		notify(event) {
			if ("message" in event) notifications.push(event.message);
		},
	});

	assert.equal(secretPrompts, 2);
	assert.equal(credential.type, "api_key");
	assert.equal(credential.key, "valid-key");
	assert.equal(credential.env?.ARK_AGENT_PLAN_TIER, "medium");
	assert.ok(notifications.some((message) => message.includes("请重新输入")));
	assert.ok(notifications.some((message) => message.includes("验证通过")));
});

test("allows an explicit save when validation is temporarily unavailable", async () => {
	const provider = createAgentPlanProvider({
		fetchImpl: async () => {
			throw new Error("temporary outage");
		},
	});
	const login = provider.auth.apiKey?.login;
	assert.ok(login);

	const prompts: string[] = [];
	const credential = await login({
		signal: new AbortController().signal,
		async prompt(prompt) {
			prompts.push(prompt.type);
			if (prompt.type === "secret") return "unchecked-key";
			if (prompt.type === "select" && prompt.message.startsWith("暂时无法验证")) return "save";
			if (prompt.type === "select") return "small";
			throw new Error(`Unexpected prompt type: ${prompt.type}`);
		},
		notify() {},
	});

	assert.deepEqual(prompts, ["secret", "select", "select"]);
	assert.equal(credential.key, "unchecked-key");
	assert.equal(credential.env?.ARK_AGENT_PLAN_TIER, "small");
});

test("filters the static catalog by tier and resolves standard auth", async () => {
	const provider = createAgentPlanProvider();
	const models = provider.getModels();
	assert.deepEqual(models.map((model) => model.id).sort(), [
		"doubao-seed-2.0-mini", "doubao-seed-2.0-lite", "doubao-seed-2.1-turbo",
		"doubao-seed-evolving", "deepseek-v4-flash", "deepseek-v4-pro",
		"deepseek-v4.1-flash", "minimax-m3", "glm-5.3", "glm-5.3-flash",
		"kimi-k2.7-code", "kimi-k3",
	].sort());
	for (const model of models) {
		assert.equal(model.api, model.id === "kimi-k2.7-code" ? "openai-completions" : "openai-responses");
	}

	const smallCredential = {
		type: "api_key" as const,
		key: "stored-key",
		env: { ARK_AGENT_PLAN_TIER: "small" },
	};
	const mediumCredential = {
		type: "api_key" as const,
		key: "stored-key",
		env: { ARK_AGENT_PLAN_TIER: "medium" },
	};
	const smallModels = provider.filterModels?.(models, smallCredential) ?? [];
	const mediumModels = provider.filterModels?.(models, mediumCredential) ?? [];
	assert.equal(smallModels.length, 11);
	assert.equal(smallModels.some((model) => model.id === "kimi-k3"), false);
	assert.equal(smallModels.some((model) => model.id === "glm-5.3"), true);
	assert.equal(mediumModels.length, 12);
	for (const id of ["deepseek-v4.1-flash", "glm-5.3-flash", "doubao-seed-2.1-turbo"]) {
		assert.ok(smallModels.some((model) => model.id === id), `${id} must be visible on Small`);
	}

	const ctx = {
		async env() { return undefined; },
		async fileExists() { return false; },
	};
	const signal = new AbortController().signal;
	const auth = await provider.auth.apiKey?.resolve({ ctx, credential: mediumCredential, signal });
	assert.equal(auth?.auth.apiKey, "stored-key");
	assert.equal(auth?.env?.ARK_AGENT_PLAN_TIER, "medium");
	assert.equal(auth?.source, "Pi auth.json");
	assert.equal(await provider.auth.apiKey?.check?.({ ctx, signal }), undefined);
});

test("provides public API cost estimates for every model", () => {
	for (const model of createAgentPlanProvider().getModels()) {
		assert.ok(model.cost.input > 0, `${model.id} must estimate input cost`);
		assert.ok(model.cost.output > 0, `${model.id} must estimate output cost`);
	}
});

test("normalizes new-model CNY reference prices without treating hourly storage as token writes", () => {
	const models = createAgentPlanProvider().getModels();
	const cnyRates: Record<string, [number, number, number]> = {
		"deepseek-v4.1-flash": [2, 8, 0.04],
		"doubao-seed-2.1-turbo": [3, 15, 0.6],
		"glm-5.3-flash": [0.8, 2.8, 0.23],
	};
	for (const [id, [input, output, cacheRead]] of Object.entries(cnyRates)) {
		const model = models.find((entry) => entry.id === id);
		assert.ok(model);
		assert.deepEqual(model.cost, { input: input / 7, output: output / 7, cacheRead: cacheRead / 7, cacheWrite: 0 }, id);
	}
});

test("declares image input only for vision-capable models", () => {
	const models = createAgentPlanProvider().getModels();
	const visionIds = [
		"doubao-seed-2.0-mini",
		"doubao-seed-2.0-lite",
		"doubao-seed-evolving",
		"doubao-seed-2.1-turbo",
		"deepseek-v4.1-flash",
		"glm-5.3-flash",
		"minimax-m3",
		"kimi-k2.7-code",
		"kimi-k3",
	];
	const textOnlyIds = ["glm-5.3", "deepseek-v4-flash", "deepseek-v4-pro"];

	for (const id of visionIds) {
		const model = models.find((entry) => entry.id === id);
		assert.ok(model, `${id} should be in the catalog`);
		assert.deepEqual(model.input, ["text", "image"], `${id} should accept image input`);
	}
	for (const id of textOnlyIds) {
		const model = models.find((entry) => entry.id === id);
		assert.ok(model, `${id} should be in the catalog`);
		assert.deepEqual(model.input, ["text"], `${id} should remain text-only`);
	}
});

test("exposes only Kimi K3's supported thinking levels", () => {
	const kimiK3 = createAgentPlanProvider()
		.getModels()
		.find((model) => model.id === "kimi-k3");
	assert.ok(kimiK3);
	assert.deepEqual(kimiK3.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
});

test("exposes only GLM 5.3's supported thinking levels", () => {
	const glm53 = createAgentPlanProvider()
		.getModels()
		.find((model) => model.id === "glm-5.3");
	assert.ok(glm53);
	assert.equal(glm53.api, "openai-responses");
	assert.deepEqual(glm53.input, ["text"]);
	assert.deepEqual(glm53.thinkingLevelMap, {
		off: null,
		minimal: null,
		low: "low",
		medium: null,
		high: "high",
		xhigh: null,
		max: "max",
	});
});

test("uses documented route limits rather than rounded decimal token counts", () => {
	const models = createAgentPlanProvider().getModels();
	const limits: Record<string, [number, number]> = {
		"deepseek-v4.1-flash": [1_048_576, 393_216],
		"deepseek-v4-flash": [1_048_576, 393_216],
		"deepseek-v4-pro": [1_048_576, 393_216],
		"glm-5.3-flash": [1_048_576, 128_000],
		"doubao-seed-2.1-turbo": [262_144, 256_000],
		"minimax-m3": [1_048_576, 128_000],
		"kimi-k2.7-code": [262_144, 32_768],
	};
	for (const [id, expected] of Object.entries(limits)) {
		const model = models.find((entry) => entry.id === id);
		assert.ok(model);
		assert.deepEqual([model.contextWindow, model.maxTokens], expected, id);
	}
});

test("exposes the native DeepSeek V4.1 Flash effort levels with Plan's off control", () => {
	const model = createAgentPlanProvider().getModels().find((entry) => entry.id === "deepseek-v4.1-flash");
	assert.ok(model);
	assert.deepEqual(getSupportedThinkingLevels(model), ["off", "low", "high", "max"]);
	assert.equal(clampThinkingLevel(model, "medium"), "high");
	assert.equal(model.thinkingLevelMap?.max, "max");
});

test("exposes the native GLM 5.3 Flash effort levels without an off control", () => {
	const model = createAgentPlanProvider().getModels().find((entry) => entry.id === "glm-5.3-flash");
	assert.ok(model);
	assert.equal(model.reasoning, true);
	assert.deepEqual(getSupportedThinkingLevels(model), ["low", "high", "max"]);
	assert.equal(clampThinkingLevel(model, "off"), "low");
	assert.equal(clampThinkingLevel(model, "medium"), "high");
	assert.equal(model.thinkingLevelMap?.max, "max");
});

function captureRequestHook(level: string) {
	let requestHook: ((event: any, ctx: any) => unknown) | undefined;
	volcengineAgentPlan({
		registerProvider() {},
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			if (event === "before_provider_request") requestHook = handler;
		},
		getThinkingLevel() { return level; },
	} as unknown as ExtensionAPI);
	assert.ok(requestHook);
	return requestHook;
}

for (const id of ["deepseek-v4.1-flash", "doubao-seed-2.1-turbo"]) {
	for (const level of id === "deepseek-v4.1-flash" ? ["off", "low", "high", "max"] : ["off", "low", "high"]) {
		test(`${id} sends an explicit thinking toggle for ${level} without damaging replay`, () => {
			const requestHook = captureRequestHook(level);
			const payload = {
				reasoning: { effort: level === "off" ? "none" : level },
				include: ["reasoning.encrypted_content"],
				input: [{ type: "function_call_output", call_id: "call-1", output: "ok" }],
			};
			const original = structuredClone(payload);
			const result = requestHook({ payload }, { model: { provider: "volcengine-agent-plan", id } });
			assert.deepEqual(result, {
				...original,
				thinking: { type: level === "off" ? "disabled" : "enabled" },
			});
			assert.deepEqual(payload, original, "must not mutate the caller's request");
		});
	}
}

test("leaves unrelated providers, models and invalid payloads untouched", () => {
	const hook = captureRequestHook("off");
	const payload = { reasoning: { effort: "high" } };
	assert.equal(hook({ payload }, { model: { provider: "deepseek", id: "deepseek-v4.1-flash" } }), undefined);
	assert.equal(hook({ payload }, {}), undefined);
	for (const invalid of [null, [], "invalid"]) {
		assert.equal(hook({ payload: invalid }, { model: { provider: "volcengine-agent-plan", id: "deepseek-v4.1-flash" } }), undefined);
	}
	for (const model of createAgentPlanProvider().getModels()) {
		if (["deepseek-v4.1-flash", "doubao-seed-2.1-turbo"].includes(model.id)) continue;
		assert.deepEqual(hook({ payload }, { model }), payload, `${model.id} must not get the toggle`);
	}
});
