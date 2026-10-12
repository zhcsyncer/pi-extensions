import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { zstdDecompressSync } from "node:zlib";
import { buildBaseOptions as installedBuildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { estimateContextTokens as installedEstimate } from "@earendil-works/pi-ai/utils/estimate";
import { streamSimple as installedStreamSimple } from "@earendil-works/pi-ai/api/openai-responses";
import { streamSimple as installedCodexStreamSimple } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { DefaultResourceLoader, SettingsManager } from "@earendil-works/pi-coding-agent";
import {
	normalizeContext,
	streamOpenAIResponses,
	streamOpenAICodexResponses,
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
	migrateFastModeSettings,
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
import { buildBaseOptions, estimateContextTokens } from "../extensions/stream-options.ts";

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
		name: "Offline Responses fixture",
		baseUrl: "https://responses.invalid/v1",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 16000,
		...overrides,
	};
}

const emptyContext = { messages: [] } as Context;
const emptyTranscript = normalizeContext(emptyContext);

test("real Pi 1.1 loader cannot import the SDK helpers but loads Fast and streams offline", async () => {
	await withSettingsDir(async (agentDir) => {
		async function load(extensionPath: string) {
			const loader = new DefaultResourceLoader({
				cwd: agentDir, agentDir, settingsManager: SettingsManager.inMemory(),
				noExtensions: true, additionalExtensionPaths: [extensionPath],
				noSkills: true, noPromptTemplates: true, noThemes: true,
			});
			await loader.reload();
			return loader.getExtensions();
		}
		for (const [subpath, symbol] of [["api/simple-options", "buildBaseOptions"], ["utils/estimate", "estimateContextTokens"]]) {
			const file = join(agentDir, `${symbol}.ts`);
			await writeFile(file, `import { ${symbol} } from '@earendil-works/pi-ai/${subpath}'; export default function() { if (typeof ${symbol} !== 'function') throw new Error('missing helper'); }`);
			const result = await load(file);
			assert.equal(result.extensions.length, 0);
			assert.equal(result.errors.length, 1);
			assert.match(result.errors[0]!.error, /compat\.js\/(api\/simple-options|utils\/estimate)/);
		}
		const result = await load(fileURLToPath(new URL("../extensions/fast-mode.ts", import.meta.url)));
		assert.deepEqual(result.errors, []);
		assert.equal(result.extensions.length, 1);
		for (const provider of ["openai", "openai-codex", "xai"]) {
			const registration = result.runtime.pendingProviderRegistrations.find(({ name }) => name === provider);
			assert.ok(registration?.config.streamSimple);
			const observed: string[] = [];
			const model = openaiModel({ provider, api: provider === "openai-codex" ? "openai-codex-responses" : "openai-responses" });
			const { payload, message, headers, url } = await captureResponses(model, emptyContext, {
				headers: { "x-fixture": "preserved" },
				onPayload: (data) => { observed.push("payload"); return { ...data as object, fixture: true }; },
				onResponse: () => { observed.push("response"); },
				onProviderStreamEvent: async (_data, receivedModel) => {
					await Promise.resolve();
					assert.equal(receivedModel.provider, provider);
					observed.push("event");
				},
			}, (model, context, options) => registration.config.streamSimple!(model, normalizeContext(context), options));
			assert.equal(payload.model, "gpt-5.6");
			assert.equal(payload.service_tier, undefined);
			assert.equal(payload.fixture, true);
			assert.equal(headers.get("x-fixture"), "preserved");
			assert.equal(new URL(url).hostname, "responses.invalid");
			assert.equal(message.provider, provider);
			assert.deepEqual(observed, ["payload", "response", "event"]);
		}
	});
});

test("estimateContextTokens accepts transcript system string messages", () => {
	const context = {
		messages: [
			{ role: "system", content: "You are Pi. ".repeat(80), timestamp: 1 },
			{ role: "user", content: "hi", timestamp: 2 },
		],
	} as Context;
	assert.doesNotThrow(() => estimateContextTokens(context));
	assert.ok(estimateContextTokens(context) > 20);
});

test("local budget matches the installed SDK, including the exact 32000-character regression", () => {
	const context: Context = { messages: [{ role: "user", content: "x".repeat(32000), timestamp: 1 }] };
	const tight = openaiModel({ contextWindow: 20000, maxTokens: 16000 });
	assert.equal(buildStreamOptions(tight, context, undefined, undefined).maxTokens, 6761);
	for (const contextWindow of [0, -1, 1, 4096, 20000, 128000]) {
		for (const maxTokens of [undefined, 1, 512, 64000]) {
			const model = { ...tight, contextWindow };
			assert.equal(
				buildStreamOptions(model, context, { maxTokens }, SERVICE_TIER).maxTokens,
				installedBuildBaseOptions(model, normalizeContext(context), { maxTokens }).maxTokens,
			);
		}
	}
});

test("all stream options survive without promoting model defaults to request overrides", () => {
	const options: SimpleStreamOptions = {
		apiKey: "offline-key", temperature: 0, samplingParams: { temperature: 0.2 },
		signal: new AbortController().signal, fetch: async () => new Response(),
		transport: "sse", cacheRetention: "long", sessionId: "offline-session",
		headers: { "x-test": "header" }, metadata: { test: true }, env: { PI_CACHE_RETENTION: "long" },
		onPayload: () => undefined, onResponse: () => {}, onProviderStreamEvent: () => {},
		telemetryContext: { startSpan() { throw new Error("Identity-only telemetry fixture"); } },
		timeoutMs: 123, websocketConnectTimeoutMs: 456, maxRetries: 0, maxRetryDelayMs: 789,
		toolChoice: "none", reasoning: "high",
	};
	const gpt = openaiModel({ samplingParams: { temperature: 1, top_p: 0.9 } });
	const actual = buildStreamOptions(gpt, emptyContext, options, SERVICE_TIER);
	for (const [key, value] of Object.entries(options)) {
		assert.equal((actual as Record<string, unknown>)[key], value, key);
	}
	assert.equal(buildStreamOptions(gpt, emptyContext, undefined, undefined).samplingParams, undefined);
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
		emptyTranscript,
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

type ResponsesStream = (model: Model<Api>, context: Context, options: SimpleStreamOptions) => ReturnType<typeof streamOpenAIResponses>;

function fastResponses(model: Model<Api>, context: Context, options: SimpleStreamOptions, tier?: typeof SERVICE_TIER) {
	const built = buildStreamOptions(model, context, options, tier);
	return model.api === "openai-codex-responses"
		? streamOpenAICodexResponses(model as Model<"openai-codex-responses">, normalizeContext(context), built)
		: streamOpenAIResponses(model as Model<"openai-responses">, normalizeContext(context), built);
}

async function captureResponses(
	model: Model<Api>, context: Context, options: SimpleStreamOptions,
	stream: ResponsesStream = fastResponses,
) {
	let payload: Record<string, unknown> | undefined;
	let headers = new Headers();
	let url = "";
	const fetch: typeof globalThis.fetch = async (input, init) => {
		headers = new Headers(init?.headers);
		url = String(input);
		const body = init?.body;
		assert.ok(typeof body === "string" || body instanceof Uint8Array);
		payload = JSON.parse(typeof body === "string" ? body : zstdDecompressSync(body).toString());
		return new Response(`data: ${JSON.stringify({ type: "response.completed", response: {
			id: "offline-response", status: "completed", output: [], service_tier: "default",
			usage: { input_tokens: 10, output_tokens: 20, total_tokens: 30 },
		} })}\n\ndata: [DONE]\n\n`, { headers: { "content-type": "text/event-stream" } });
	};
	// Deliberately unsigned fixture; only the SDK's local account-id extraction runs.
	const apiKey = model.api === "openai-codex-responses"
		? `offline.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-account" } })).toString("base64url")}.fixture`
		: "offline-key";
	const message = await stream(model, normalizeContext(context), { apiKey, transport: "sse", ...options, fetch }).result();
	assert.equal(message.stopReason, "stop", message.errorMessage);
	assert.ok(payload);
	return { payload, message, headers, url };
}

test("sampling on the wire matches official model < thinking < request semantics", async () => {
	const defaults = {
		samplingParams: { temperature: 1 },
		samplingParamsByThinkingLevel: { high: { temperature: 0.3, top_k: 20 }, off: { temperature: 0.7 } },
	};
	const cases: Array<{ model: Model<Api>; options: SimpleStreamOptions; temperature?: number; top_k?: number }> = [
		{ model: openaiModel(defaults), options: { reasoning: "high" }, temperature: 0.3, top_k: 20 },
		{ model: openaiModel(defaults), options: { reasoning: "high", samplingParams: { temperature: 0.2 } }, temperature: 0.2, top_k: 20 },
		{ model: openaiModel(defaults), options: {}, temperature: 0.7 },
		{ model: openaiModel(defaults), options: { reasoning: "high", samplingParams: { temperature: undefined } }, top_k: 20 },
		{ model: openaiModel(), options: {} },
		{ model: openaiModel(), options: { temperature: 0 }, temperature: 0 },
		{ model: openaiModel(), options: { samplingParams: { temperature: 0.2 } }, temperature: 0.2 },
		{ model: openaiModel({ ...defaults, reasoning: false }), options: { reasoning: "high" }, temperature: 0.7 },
		{ model: openaiModel(defaults), options: { reasoning: "xhigh" }, temperature: 0.3, top_k: 20 },
		{ model: openaiModel({ samplingParams: { temperature: 1 } }), options: { reasoning: "high" }, temperature: 1 },
		{ model: openaiModel({ samplingParamsByThinkingLevel: defaults.samplingParamsByThinkingLevel }), options: { reasoning: "high" }, temperature: 0.3, top_k: 20 },
	];
	for (const fixture of cases) {
		const actual = await captureResponses(fixture.model, emptyContext, fixture.options);
		const official = await captureResponses(fixture.model, emptyContext, fixture.options, (m, c, o) => installedStreamSimple(m as Model<"openai-responses">, normalizeContext(c), o));
		assert.deepEqual(actual.payload, official.payload);
		assert.equal(actual.payload.temperature, fixture.temperature);
		assert.equal(actual.payload.top_k, fixture.top_k);
	}
});

test("Codex preserves the official channel, thinking and sampling serialization with Fast on or off", async () => {
	const model = openaiModel({ provider: "openai-codex", api: "openai-codex-responses", samplingParams: { temperature: 1 } });
	const options: SimpleStreamOptions = { reasoning: "high", temperature: 0.2, toolChoice: "none", samplingParams: { top_k: 20 } };
	const official = await captureResponses(model, emptyContext, options, (m, c, o) => installedCodexStreamSimple(m as Model<"openai-codex-responses">, normalizeContext(c), o));
	for (const tier of [undefined, SERVICE_TIER]) {
		const actual = await captureResponses(model, emptyContext, options, (m, c, o) => fastResponses(m, c, o, tier));
		assert.equal(actual.headers.get("chatgpt-account-id"), "offline-account");
		assert.equal(actual.payload.temperature, 0.2);
		assert.equal(actual.payload.top_k, undefined, "Codex does not serialize arbitrary samplingParams in the target SDK");
		assert.deepEqual(actual.payload, { ...official.payload, ...(tier ? { service_tier: tier } : {}) });
	}
});

test("budget parity covers reliable usage, invalid receipts, images and system deltas", () => {
	const assistant: AssistantMessage = {
		role: "assistant", api: "openai-responses", provider: "openai", model: "fixture", timestamp: 2,
		content: [{ type: "thinking", thinking: "think" }, { type: "toolCall", id: "call", name: "read", arguments: { path: "file" } }],
		stopReason: "toolUse",
		usage: { input: 100, output: 20, cacheRead: 30, cacheWrite: 40, totalTokens: 190,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
	};
	const user: Context["messages"][number] = { role: "user", content: "x".repeat(32000), timestamp: 1 };
	const trailing: Context["messages"] = [
		{ role: "system", content: [{ type: "text", text: "rules" }], sections: { add: "extra", remove: null }, toolsAdded: [], toolsRemoved: [{ name: "read" }], timestamp: 3 },
		{ role: "toolResult", toolCallId: "call", toolName: "read", content: [{ type: "image", data: "AA==", mimeType: "image/png" }], isError: false, timestamp: 4 },
	];
	const fixtures: Context[] = [
		{ messages: [user, assistant, ...trailing] },
		{ messages: [user, { ...assistant, stopReason: "error" }, ...trailing] },
		{ messages: [user, { ...assistant, stopReason: "aborted" }, ...trailing] },
		{ messages: [{ ...user, timestamp: 10 }, assistant, ...trailing] },
		{ messages: [user, { ...assistant, usage: { ...assistant.usage, totalTokens: 0 } }, ...trailing] },
		{ systemPrompt: "shorthand".repeat(100), messages: [user], tools: [{ name: "read", description: "fixture", parameters: { type: "object", properties: {} } }] },
	];
	for (const fixture of fixtures) {
		const transcript = normalizeContext(fixture);
		assert.equal(estimateContextTokens(transcript), installedEstimate(transcript).tokens);
		assert.equal(buildStreamOptions(openaiModel(), fixture, undefined, undefined).maxTokens,
			installedBuildBaseOptions(openaiModel(), transcript).maxTokens);
	}
});

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

test("migrateFastModeSettings rewrites legacy shapes and only notices behavior changes", async () => {
	await withSettingsDir(async (agentDir) => {
		const settingsPath = path.join(agentDir, "settings.json");
		const gpt = "openai/gpt-5.6";
		const grok = "xai/grok-4.6";

		assert.deepEqual(migrateFastModeSettings(), { migrated: false });

		await writeFile(
			settingsPath,
			`${JSON.stringify({ theme: "dark", "fast-mode": { extra: "keep-me", enabled: false } })}\n`,
			"utf8",
		);
		assert.deepEqual(migrateFastModeSettings(), { migrated: true });
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			theme: "dark",
			"fast-mode": { extra: "keep-me" },
		});
		assert.deepEqual(migrateFastModeSettings(), { migrated: false });

		await writeFile(
			settingsPath,
			`${JSON.stringify({ "fast-mode": { enabled: true } })}\n`,
			"utf8",
		);
		const globalOn = migrateFastModeSettings();
		assert.equal(globalOn.migrated, true);
		assert.match(String(globalOn.notice), /no longer has a global ON default/);
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), { "fast-mode": {} });
		assert.equal(loadDefaultEnabled(gpt), false);

		await writeFile(
			settingsPath,
			`${JSON.stringify({ "fast-mode": { models: { [gpt]: true, [grok]: false, extra: 1 } } })}\n`,
			"utf8",
		);
		const fromMap = migrateFastModeSettings();
		assert.equal(fromMap.migrated, true);
		assert.match(String(fromMap.notice), /allowlist/);
		assert.match(String(fromMap.notice), /openai\/gpt-5\.6/);
		assert.equal(String(fromMap.notice).includes(grok), false);
		assert.deepEqual(JSON.parse(await readFile(settingsPath, "utf8")), {
			"fast-mode": { models: [gpt] },
		});
		assert.equal(loadDefaultEnabled(gpt), true);
		assert.equal(loadDefaultEnabled(grok), false);

		await writeFile(
			settingsPath,
			`${JSON.stringify({ "fast-mode": { models: [gpt] } })}\n`,
			"utf8",
		);
		assert.deepEqual(migrateFastModeSettings(), { migrated: false });
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
