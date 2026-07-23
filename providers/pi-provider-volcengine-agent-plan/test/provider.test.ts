import assert from "node:assert/strict";
import test from "node:test";
import { fileURLToPath } from "node:url";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createJiti } from "jiti";

const jiti = createJiti(import.meta.url, {
	moduleCache: false,
	alias: {
		"@earendil-works/pi-ai": fileURLToPath(
			new URL("../node_modules/@earendil-works/pi-ai/dist/compat.js", import.meta.url),
		),
	},
});
const extension = await jiti.import<typeof import("../index.ts")>(
	fileURLToPath(new URL("../index.ts", import.meta.url)),
);
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
	assert.equal(models.length, 13);
	assert.equal(models.filter((model) => model.api === "openai-completions").length, 2);
	assert.equal(models.filter((model) => model.api === "openai-responses").length, 11);

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
	assert.equal(smallModels.length, 12);
	assert.equal(smallModels.some((model) => model.id === "kimi-k3"), false);
	assert.equal(mediumModels.length, 13);

	const ctx = {
		async env() { return undefined; },
		async fileExists() { return false; },
	};
	const auth = await provider.auth.apiKey?.resolve({ ctx, credential: mediumCredential });
	assert.equal(auth?.auth.apiKey, "stored-key");
	assert.equal(auth?.env?.ARK_AGENT_PLAN_TIER, "medium");
	assert.equal(auth?.source, "Pi auth.json");
	assert.equal(await provider.auth.apiKey?.check?.({ ctx }), undefined);
});

test("applies MiniMax and Kimi request compatibility hooks", () => {
	let requestHook: ((event: any, ctx: any) => unknown) | undefined;
	const pi = {
		registerProvider() {},
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			if (event === "before_provider_request") requestHook = handler;
		},
		getThinkingLevel() { return "off"; },
	} as unknown as ExtensionAPI;
	volcengineAgentPlan(pi);
	assert.ok(requestHook);

	const minimax = requestHook(
		{
			payload: {
				reasoning: { effort: "high" },
				include: ["reasoning.encrypted_content", "message.output_text.logprobs"],
			},
		},
		{ model: { provider: "volcengine-agent-plan", id: "minimax-m2.7" } },
	) as Record<string, unknown>;
	assert.equal("reasoning" in minimax, false);
	assert.deepEqual(minimax.include, ["message.output_text.logprobs"]);
	assert.deepEqual(minimax.thinking, { type: "disabled" });

	const kimi = requestHook(
		{ payload: { reasoning_effort: "minimal" } },
		{ model: { provider: "volcengine-agent-plan", id: "kimi-k2.6" } },
	) as Record<string, unknown>;
	assert.deepEqual(kimi.thinking, { type: "disabled" });
});
