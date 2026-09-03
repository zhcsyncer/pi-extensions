import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { buildBaseOptions as installedBuildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import {
	streamOpenAIResponses,
	type Api,
	type AssistantMessage,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import {
	applyXaiPriorityPayload,
	buildStreamOptions,
	footerStatusLabel,
	loadDefaultEnabled,
	modelKey,
	readEnabledModelList,
	resolveServiceTier,
	resolveSettingsPath,
	SERVICE_TIER,
	STATUS_OFF,
	STATUS_ON,
	shouldReloadEnabledFromSettings,
	supportsApi,
	writeDefaultEnabled,
	type FastModeModel,
} from "../extensions/fast-mode.ts";
import { buildBaseOptions } from "../extensions/stream-options.ts";

function model(provider: string, api: string): FastModeModel {
	return { provider, api };
}

async function withSettingsDir<T>(run: (agentDir: string) => Promise<T>): Promise<T> {
	const root = await mkdtemp(path.join(tmpdir(), "pi-fast-mode-"));
	const agentDir = path.join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	try {
		return await run(agentDir);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	}
}

test("supportsApi accepts only the hardcoded OpenAI and xAI surfaces", () => {
	assert.equal(supportsApi(undefined), false);
	assert.equal(supportsApi(model("openai", "openai-responses")), true);
	assert.equal(supportsApi(model("openai-codex", "openai-codex-responses")), true);
	assert.equal(supportsApi(model("xai", "openai-responses")), true);
	assert.equal(supportsApi(model("xai", "openai-completions")), true);
	assert.equal(supportsApi(model("openai", "openai-completions")), false);
	assert.equal(supportsApi(model("openai-codex", "openai-responses")), true);
	assert.equal(supportsApi(model("anthropic", "openai-responses")), false);
	assert.equal(supportsApi(model("google", "google-generative-ai")), false);
});

test("footerStatusLabel is a short on/off badge and hides unsupported models", () => {
	assert.equal(footerStatusLabel(true, true), STATUS_ON);
	assert.equal(footerStatusLabel(false, true), STATUS_OFF);
	assert.equal(footerStatusLabel(true, false), undefined);
	assert.equal(footerStatusLabel(false, false), undefined);
});

test("resolveServiceTier injects priority only when the in-memory switch is on", () => {
	const gpt = model("openai", "openai-responses");
	assert.equal(resolveServiceTier(false, gpt), undefined);
	assert.equal(resolveServiceTier(true, undefined), undefined);
	assert.equal(resolveServiceTier(true, model("anthropic", "anthropic-messages")), undefined);
	assert.equal(resolveServiceTier(true, gpt), SERVICE_TIER);
	assert.equal(resolveServiceTier(true, model("xai", "openai-completions")), SERVICE_TIER);
});

function openaiModel(overrides: Partial<Model<Api>> = {}): Model<Api> {
	return {
		provider: "openai",
		id: "gpt-5.6",
		api: "openai-responses",
		contextWindow: 128000,
		maxTokens: 16000,
		...overrides,
	} as Model<Api>;
}

const emptyContext = { messages: [] } as Context;

function importedSpecifiers(source: string): string[] {
	return Array.from(
		source.matchAll(/from\s+["']([^"']+)["']/g),
		(match) => match[1] ?? "",
	).filter(Boolean);
}

test("extension runtime stays on loader-safe pi-ai specifiers", () => {
	const source = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "../extensions/fast-mode.ts"),
		"utf8",
	);
	const helper = readFileSync(
		join(dirname(fileURLToPath(import.meta.url)), "../extensions/stream-options.ts"),
		"utf8",
	);
	const specifiers = [...importedSpecifiers(source), ...importedSpecifiers(helper)];
	assert.equal(
		specifiers.some((specifier) => specifier.startsWith("@earendil-works/pi-ai/api/")),
		false,
		"Pi aliases @earendil-works/pi-ai to compat.js, so /api/* imports fail at load time.",
	);
	assert.ok(specifiers.includes("@earendil-works/pi-ai/compat"));
});

test("local buildBaseOptions matches the installed pi-ai recipe", () => {
	const gpt = openaiModel();
	const options: SimpleStreamOptions = { maxTokens: 64000, temperature: 0.2, apiKey: "test-key" };
	assert.deepEqual(
		buildBaseOptions(gpt, emptyContext, options, options.apiKey),
		installedBuildBaseOptions(gpt, emptyContext, options, options.apiKey),
	);

	const longContext = {
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "x".repeat(18000) }],
			},
		],
	} as Context;
	const tight = openaiModel({ contextWindow: 20000, maxTokens: 16000 });
	assert.deepEqual(
		buildBaseOptions(tight, longContext, { maxTokens: 64000, apiKey: "test-key" }, "test-key"),
		installedBuildBaseOptions(tight, longContext, { maxTokens: 64000, apiKey: "test-key" }, "test-key"),
	);
});

test("buildStreamOptions copies Pi streamSimple options and only adds serviceTier", () => {
	const gpt = openaiModel();
	const options: SimpleStreamOptions = {
		maxTokens: 64000,
		temperature: 0.2,
		apiKey: "test-key",
		toolChoice: "none",
	};
	const expected = {
		...buildBaseOptions(gpt, emptyContext, options, options.apiKey),
		toolChoice: "none",
		reasoningEffort: undefined,
	};

	assert.deepEqual(buildStreamOptions(gpt, emptyContext, options, undefined), expected);
	assert.deepEqual(buildStreamOptions(gpt, emptyContext, options, SERVICE_TIER), {
		...expected,
		serviceTier: SERVICE_TIER,
	});
});

async function runXaiResponses(responseServiceTier: "priority" | "default") {
	const payloads: Array<Record<string, unknown>> = [];
	const fakeFetch = (async (_input: string | URL | Request, init?: RequestInit) => {
		const requestBody = init?.body;
		if (typeof requestBody !== "string") throw new Error("Expected a JSON request body");
		payloads.push(JSON.parse(requestBody) as Record<string, unknown>);
		const response = {
			id: "resp_test",
			status: "completed",
			output: [],
			service_tier: responseServiceTier,
			usage: {
				input_tokens: 10,
				output_tokens: 20,
				total_tokens: 30,
				input_tokens_details: { cached_tokens: 0 },
				output_tokens_details: { reasoning_tokens: 0 },
			},
		};
		return new Response(
			`data: ${JSON.stringify({ type: "response.completed", response })}\n\ndata: [DONE]\n\n`,
			{ status: 200, headers: { "content-type": "text/event-stream" } },
		);
	}) as typeof fetch;
	const xai = openaiModel({
		provider: "xai",
		id: "grok-4.6",
		baseUrl: "https://api.x.ai/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
	});
	const options = buildStreamOptions(
		xai,
		emptyContext,
		{ apiKey: "test-key", fetch: fakeFetch, toolChoice: "none" },
		SERVICE_TIER,
	);
	let completed: AssistantMessage | undefined;
	let errorMessage: string | undefined;
	for await (const event of streamOpenAIResponses(
		xai as Model<"openai-responses">,
		emptyContext,
		options as never,
	)) {
		if (event.type === "done") completed = event.message;
		if (event.type === "error") errorMessage = event.error.errorMessage;
	}
	assert.ok(completed, errorMessage);
	return { payload: payloads[0], cost: completed.usage.cost };
}

test("xAI Responses priority uses the returned service tier for local cost", async () => {
	const priority = await runXaiResponses("priority");
	assert.equal(priority.payload?.service_tier, SERVICE_TIER);
	assert.equal(priority.payload?.tool_choice, "none");
	assert.equal(priority.cost.total, 0.00028);

	const fallback = await runXaiResponses("default");
	assert.equal(fallback.payload?.service_tier, SERVICE_TIER);
	assert.equal(fallback.cost.total, 0.00014);
});

test("buildStreamOptions keeps Pi maxTokens defaulting and context clamping", () => {
	const gpt = openaiModel({ contextWindow: 20000, maxTokens: 16000 });
	const shortContext = { messages: [] } as Context;
	const longContext = {
		messages: [
			{
				role: "user",
				content: [{ type: "text", text: "x".repeat(18000) }],
			},
		],
	} as Context;

	const withoutCallerCap = buildStreamOptions(gpt, shortContext, { apiKey: "test-key" }, undefined);
	assert.equal(
		withoutCallerCap.maxTokens,
		buildBaseOptions(gpt, shortContext, { apiKey: "test-key" }, "test-key").maxTokens,
	);

	const oversized = { maxTokens: 64000, apiKey: "test-key" };
	const clamped = buildStreamOptions(gpt, longContext, oversized, SERVICE_TIER);
	assert.ok((clamped.maxTokens ?? 0) < 64000);
	assert.equal(
		clamped.maxTokens,
		buildBaseOptions(gpt, longContext, oversized, oversized.apiKey).maxTokens,
	);
	assert.equal(clamped.serviceTier, SERVICE_TIER);
});

test("OpenAI streamSimple wrappers still match the installed pi-ai recipe", () => {
	const openaiSource = readInstalledApiSource("openai-responses.js");
	const codexSource = readInstalledApiSource("openai-codex-responses.js");
	const recipe =
		/export const streamSimple = \(model, context, options\) => \{[\s\S]*?const base = \{\s*\.\.\.buildBaseOptions\(model, context, options, options\?\.apiKey\),\s*toolChoice: options\?\.toolChoice,\s*\};[\s\S]*?clampThinkingLevel\(model, options\.reasoning\)[\s\S]*?return stream\(model, context, \{\s*\.\.\.base,\s*reasoningEffort,\s*\}\);/;
	const codexRecipe =
		/export const streamSimple = \(model, context, options\) => \{[\s\S]*?const base = \{\s*\.\.\.buildBaseOptions\(model, context, options, apiKey\),\s*toolChoice: options\?\.toolChoice,\s*\};[\s\S]*?clampThinkingLevel\(model, options\.reasoning\)[\s\S]*?return stream\(model, context, \{\s*\.\.\.base,\s*reasoningEffort,\s*\}\);/;

	assert.match(
		openaiSource,
		recipe,
		"pi-ai openai-responses streamSimple changed. Re-read it and update buildStreamOptions if the recipe gained new fields.",
	);
	assert.match(
		codexSource,
		codexRecipe,
		"pi-ai openai-codex-responses streamSimple changed. Re-read it and update buildStreamOptions if the recipe gained new fields.",
	);
});

function readInstalledApiSource(fileName: string): string {
	const simpleOptionsUrl = import.meta.resolve("@earendil-works/pi-ai/api/simple-options");
	return readFileSync(join(dirname(fileURLToPath(simpleOptionsUrl)), fileName), "utf8");
}

test("applyXaiPriorityPayload only mutates custom xAI Completions payloads when enabled", () => {
	const payload = { model: "grok-4.6", max_tokens: 8000 };
	assert.equal(
		applyXaiPriorityPayload({ enabled: false, model: model("xai", "openai-completions"), payload }),
		undefined,
	);
	assert.equal(
		applyXaiPriorityPayload({ enabled: true, model: model("openai", "openai-responses"), payload }),
		undefined,
	);
	assert.equal(
		applyXaiPriorityPayload({ enabled: true, model: model("xai", "anthropic-messages"), payload }),
		undefined,
	);
	assert.equal(
		applyXaiPriorityPayload({ enabled: true, model: model("xai", "openai-completions"), payload: "raw" }),
		undefined,
	);
	assert.deepEqual(
		applyXaiPriorityPayload({ enabled: true, model: model("xai", "openai-completions"), payload }),
		{ model: "grok-4.6", max_tokens: 8000, service_tier: SERVICE_TIER },
	);
	assert.equal(
		applyXaiPriorityPayload({ enabled: true, model: model("xai", "openai-responses"), payload }),
		undefined,
	);
	assert.deepEqual(payload, { model: "grok-4.6", max_tokens: 8000 });
});

test("new, resume, and fork keep the current switch; startup and reload reread settings", () => {
	assert.equal(shouldReloadEnabledFromSettings("startup"), true);
	assert.equal(shouldReloadEnabledFromSettings("reload"), true);
	assert.equal(shouldReloadEnabledFromSettings("new"), false);
	assert.equal(shouldReloadEnabledFromSettings("resume"), false);
	assert.equal(shouldReloadEnabledFromSettings("fork"), false);
	assert.equal(shouldReloadEnabledFromSettings(undefined), false);
});

test("readEnabledModelList keeps unique string ids and ignores the rest", () => {
	assert.deepEqual(readEnabledModelList(undefined), []);
	assert.deepEqual(readEnabledModelList({ models: { "openai/gpt-5.6": true } }), []);
	assert.deepEqual(
		readEnabledModelList({ models: ["openai/gpt-5.6", "", 1, "openai/gpt-5.6", "xai/grok-4.6"] }),
		["openai/gpt-5.6", "xai/grok-4.6"],
	);
});

test("modelKey uses provider/id and ignores incomplete models", () => {
	assert.equal(modelKey(undefined), undefined);
	assert.equal(modelKey({ provider: "openai" }), undefined);
	assert.equal(modelKey({ id: "gpt-5.6" }), undefined);
	assert.equal(modelKey({ provider: "openai", id: "gpt-5.6" }), "openai/gpt-5.6");
	assert.equal(modelKey({ provider: "openai-codex", id: "gpt-5.6" }), "openai-codex/gpt-5.6");
});

test("loadDefaultEnabled reads only the named model's default and ignores the old global flag", async () => {
	await withSettingsDir(async (agentDir) => {
		const gpt = "openai/gpt-5.6";
		const grok = "xai/grok-4.6";
		assert.equal(resolveSettingsPath(), path.join(agentDir, "settings.json"));
		assert.equal(loadDefaultEnabled(gpt), false);

		await writeFile(
			path.join(agentDir, "settings.json"),
			`${JSON.stringify({ "fast-mode": { enabled: true }, other: 1 })}\n`,
			"utf8",
		);
		assert.equal(loadDefaultEnabled(gpt), false);

		await writeFile(
			path.join(agentDir, "settings.json"),
			`${JSON.stringify({ "fast-mode": { models: [gpt] } })}\n`,
			"utf8",
		);
		assert.equal(loadDefaultEnabled(gpt), true);
		assert.equal(loadDefaultEnabled(grok), false);
		assert.equal(loadDefaultEnabled("openai-codex/gpt-5.6"), false);

		await writeFile(
			path.join(agentDir, "settings.json"),
			`${JSON.stringify({ "fast-mode": { models: { [gpt]: true } } })}\n`,
			"utf8",
		);
		assert.equal(loadDefaultEnabled(gpt), false);

		await writeFile(
			path.join(agentDir, "settings.json"),
			`${JSON.stringify({ "fast-mode": { models: [] } })}\n`,
			"utf8",
		);
		assert.equal(loadDefaultEnabled(gpt), false);

		await writeFile(path.join(agentDir, "settings.json"), "{not-json", "utf8");
		assert.equal(loadDefaultEnabled(gpt), false);
	});
});

test("writeDefaultEnabled atomically updates only the named model default", async () => {
	await withSettingsDir(async (agentDir) => {
		const settingsPath = path.join(agentDir, "settings.json");
		const gpt = "openai/gpt-5.6";
		const grok = "xai/grok-4.6";
		await writeFile(
			settingsPath,
			`${JSON.stringify({ theme: "dark", "fast-mode": { extra: "keep-me", enabled: true } }, null, 2)}\n`,
			"utf8",
		);

		writeDefaultEnabled(gpt, true);
		const afterOn = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(afterOn, {
			theme: "dark",
			"fast-mode": { extra: "keep-me", models: [gpt] },
		});
		assert.equal(loadDefaultEnabled(gpt), true);
		assert.equal(loadDefaultEnabled(grok), false);

		writeDefaultEnabled(gpt, true);
		writeDefaultEnabled(grok, true);
		writeDefaultEnabled(gpt, false);
		const afterOff = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
		assert.deepEqual(afterOff, {
			theme: "dark",
			"fast-mode": { extra: "keep-me", models: [grok] },
		});
		assert.equal(loadDefaultEnabled(gpt), false);
		assert.equal(loadDefaultEnabled(grok), true);
	});
});

test("writing the default does not imply a current-switch change", async () => {
	await withSettingsDir(async () => {
		const gpt = "openai/gpt-5.6";
		let current = true;
		writeDefaultEnabled(gpt, false);
		assert.equal(current, true);
		assert.equal(loadDefaultEnabled(gpt), false);
		current = !current;
		assert.equal(current, false);
		assert.equal(loadDefaultEnabled(gpt), false);
	});
});
