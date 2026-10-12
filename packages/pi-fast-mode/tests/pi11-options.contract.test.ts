import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import { zstdDecompressSync } from "node:zlib";
import type {
	Api, AssistantMessage, AssistantMessageEventStream, Context, Model,
	OpenAIResponsesOptions, SimpleStreamOptions, UserMessage,
} from "@earendil-works/pi-ai";
import { normalizeContext, streamOpenAIResponses } from "@earendil-works/pi-ai/compat";
// Test-process oracles only: these deep paths are NOT safe product loader imports.
import { buildBaseOptions } from "@earendil-works/pi-ai/api/simple-options";
import { estimateContextTokens } from "@earendil-works/pi-ai/utils/estimate";
import { streamSimple as officialResponses } from "@earendil-works/pi-ai/api/openai-responses";
import { stream as officialCodex } from "@earendil-works/pi-ai/api/openai-codex-responses";
import { stream as officialCompletions } from "@earendil-works/pi-ai/api/openai-completions";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { buildStreamOptions } from "../extensions/fast-mode.ts";

const model: Model<"openai-responses"> = {
	id: "offline-fixture", name: "Offline contract fixture", provider: "openai",
	api: "openai-responses", baseUrl: "https://responses.invalid/v1",
	reasoning: true, input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 20_000, maxTokens: 16_000,
	samplingParams: { temperature: 1 },
	samplingParamsByThinkingLevel: {
		high: { temperature: 0.3, top_k: 20 }, off: { temperature: 0.7 },
	},
};
const user = (length: number, timestamp = 1): UserMessage => ({
	role: "user", content: "x".repeat(length), timestamp,
});
// The public builder has a wider string return type than the Responses adapter.
// Check that boundary without rewriting or pre-merging any returned option.
function responsesOptions(...args: Parameters<typeof buildStreamOptions>): OpenAIResponsesOptions {
	const options = buildStreamOptions(...args);
	assert.ok(options.reasoningEffort === undefined || ["minimal", "low", "medium", "high", "xhigh", "max"].includes(options.reasoningEffort));
	return options as OpenAIResponsesOptions;
}
const context: Context = { messages: [user(32_000)] };
const shortContext = normalizeContext({ messages: [user(7)] });
function assistant(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text: "a".repeat(350) }],
		api: model.api, provider: model.provider, model: model.id,
		stopReason: "stop", timestamp: 2,
		usage: {
			input: 7_000, output: 500, cacheRead: 1_000, cacheWrite: 500, totalTokens: 9_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		...overrides,
	};
}

const usage = assistant().usage;
const budgetCases: Array<{
	name: string; context: Context; tokens: number; budget: number;
	model?: Model<"openai-responses">; options?: SimpleStreamOptions;
}> = [
	{ name: "32000 characters use 3.5 chars/token", context, tokens: 9143, budget: 6761 },
	{ name: "reliable usage replaces the prefix, then adds trailing text", context: {
		messages: [user(32_000), assistant(), user(350, 3)],
	}, tokens: 9100, budget: 6804 },
	{ name: "zero total falls back to usage components without double counting", context: {
		messages: [user(32_000), assistant({ usage: { ...usage, totalTokens: 0 } }), user(350, 3)],
	}, tokens: 9100, budget: 6804 },
	{ name: "latest valid usage supersedes older usage", context: {
		messages: [user(32_000), assistant(), user(350, 3), assistant({
			timestamp: 4, usage: { ...usage, totalTokens: 10_000 },
		}), user(350, 5)],
	}, tokens: 10_100, budget: 5804 },
	...(["error", "aborted"] as const).map((stopReason) => ({
		name: `${stopReason} usage is not a reliable prefix`,
		context: { messages: [user(32_000), assistant({ stopReason }), user(350, 3)] },
		tokens: 9343, budget: 6561,
	})),
	{ name: "failed trailing response does not displace earlier valid usage", context: {
		messages: [user(32_000), assistant(), user(350, 3), assistant({
			timestamp: 4, stopReason: "error", usage: { ...usage, totalTokens: 19_999 },
		}), user(350, 5)],
	}, tokens: 9300, budget: 6604 },
	{ name: "newer inserted prefix invalidates stale assistant usage", context: {
		messages: [user(32_000, 10), assistant(), user(350, 11)],
	}, tokens: 9343, budget: 6561 },
	{ name: "zero usage falls back to transcript estimation", context: {
		messages: [user(32_000), assistant({ usage: {
			...usage, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
		} }), user(350, 3)],
	}, tokens: 9343, budget: 6561 },
	{ name: "negative usage is not an accounting anchor", context: {
		messages: [user(32_000), assistant({ usage: { ...usage, totalTokens: -1 } }), user(350, 3)],
	}, tokens: 9343, budget: 6561 },
	{ name: "explicit output cap is respected", context, options: { maxTokens: 1234 }, tokens: 9143, budget: 1234 },
	{ name: "safety margin exhaustion leaves one legal output token", context: { messages: [user(70_000)] }, tokens: 20_000, budget: 1 },
	{ name: "unknown context window does not invent a cap", context, model: { ...model, contextWindow: 0 }, tokens: 9143, budget: 16_000 },
	{ name: "empty transcript retains safety margin", context: { messages: [] }, tokens: 0, budget: 15_904 },
	{ name: "system sections and tool results are included", context: { messages: [
		{ role: "system", content: "s".repeat(350), sections: { rule: "r".repeat(350) }, timestamp: 0 },
		user(32_000),
		{ role: "toolResult", toolCallId: "call_1", toolName: "fixture", content: [{ type: "text", text: "t".repeat(350) }], isError: false, timestamp: 3 },
	] }, tokens: 9444, budget: 6460 },
];

test("SDK control: all numeric budget fixtures match exact 1.1", () => {
	for (const row of budgetCases) {
		const transcript = normalizeContext(row.context);
		assert.equal(estimateContextTokens(transcript).tokens, row.tokens, row.name);
		assert.equal(buildBaseOptions(row.model ?? model, transcript, row.options).maxTokens, row.budget, row.name);
	}
});
for (const row of budgetCases) {
	test(`T0 budget: ${row.name}`, () => {
		assert.equal(buildStreamOptions(row.model ?? model, normalizeContext(row.context), row.options, undefined).maxTokens, row.budget);
	});
}

// Actual adapter transport, not an onPayload-only spy. No request can leave this fixture.
const rawEvents = [
	{ type: "response.created", response: { id: "resp_contract", status: "in_progress" } },
	{ type: "response.output_item.added", output_index: 0, item: { type: "message", id: "msg_contract", role: "assistant", content: [], status: "in_progress" } },
	{ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg_contract", part: { type: "output_text", text: "", annotations: [] } },
	{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg_contract", delta: "offline answer" },
	{ type: "response.output_text.done", output_index: 0, content_index: 0, item_id: "msg_contract", text: "offline answer" },
	{ type: "response.output_item.done", output_index: 0, item: { type: "message", id: "msg_contract", role: "assistant", content: [{ type: "output_text", text: "offline answer", annotations: [] }], status: "completed" } },
	{ type: "response.completed", response: { id: "resp_contract", status: "completed", service_tier: "default", output: [], usage: { input_tokens: 10, output_tokens: 3, total_tokens: 13, input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } } },
];
function offlineTransport(status = 200, returnedTier = "default") {
	const requests: Array<{ url: string; headers: Headers; body: Record<string, unknown> & { reasoning?: { effort: string } } }> = [];
	const fetch: typeof globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(new URL(request.url).hostname, "responses.invalid", "unexpected transport destination");
		const bytes = Buffer.from(await request.arrayBuffer());
		const body = request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes).toString() : bytes.toString();
		requests.push({ url: request.url, headers: request.headers, body: JSON.parse(body) });
		if (status !== 200) return new Response(JSON.stringify({ error: { message: "offline rejected", type: "invalid_request_error" } }), { status, headers: { "content-type": "application/json" } });
		const completions = request.url.endsWith("/chat/completions");
		const events = completions ? [
			{ id: "chat_contract", choices: [{ index: 0, delta: { role: "assistant", content: "offline answer" }, finish_reason: null }] },
			{ id: "chat_contract", choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 3, total_tokens: 13 } },
		] : rawEvents.map((event) => event.type === "response.completed"
			? { ...event, response: { ...event.response, service_tier: returnedTier } } : event);
		return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + (completions ? "data: [DONE]\n\n" : ""), {
			headers: { "content-type": "text/event-stream", "x-request-id": "offline-contract" },
		});
	};
	return { fetch, requests };
}
async function consume(stream: AssistantMessageEventStream) {
	const events = [];
	for await (const event of stream) events.push(event);
	return { events, result: await stream.result() };
}
async function samplingPayload(fixture: Model<"openai-responses">, options: SimpleStreamOptions, official = false) {
	const transport = offlineTransport();
	const requestOptions = { ...options, apiKey: "offline-only", fetch: transport.fetch, maxRetries: 0 };
	const stream = official
		? officialResponses(fixture, shortContext, requestOptions)
		: streamOpenAIResponses(fixture, shortContext, responsesOptions(fixture, shortContext, requestOptions, undefined));
	const { result } = await consume(stream);
	assert.equal(result.stopReason, "stop", result.errorMessage);
	assert.equal(transport.requests.length, 1);
	const payload = transport.requests[0].body;
	return { temperature: payload.temperature, top_k: payload.top_k };
}
const samplingCases: Array<{
	name: string; model?: Model<"openai-responses">; options: SimpleStreamOptions;
	expected: { temperature: number | undefined; top_k: number | undefined };
}> = [
	{ name: "high defaults beat model defaults", options: { reasoning: "high" }, expected: { temperature: 0.3, top_k: 20 } },
	{ name: "explicit arbitrary sampling overrides only its own key", options: { reasoning: "high", samplingParams: { temperature: 0.2 } }, expected: { temperature: 0.2, top_k: 20 } },
	{ name: "partial request sampling retains the other thinking default", options: { reasoning: "high", samplingParams: { top_k: 9 } }, expected: { temperature: 0.3, top_k: 9 } },
	{ name: "omitted reasoning selects off sampling", options: {}, expected: { temperature: 0.7, top_k: undefined } },
	{ name: "absent thinking defaults fall back to model defaults", model: { ...model, samplingParamsByThinkingLevel: undefined }, options: { reasoning: "high" }, expected: { temperature: 1, top_k: undefined } },
	{ name: "thinking defaults need no model defaults", model: { ...model, samplingParams: undefined }, options: { reasoning: "high" }, expected: { temperature: 0.3, top_k: 20 } },
	{ name: "no defaults leave fields absent", model: { ...model, samplingParams: undefined, samplingParamsByThinkingLevel: undefined }, options: {}, expected: { temperature: undefined, top_k: undefined } },
	{ name: "explicit zero is not treated as absent", model: { ...model, samplingParams: undefined, samplingParamsByThinkingLevel: undefined }, options: { samplingParams: { temperature: 0, top_k: 0 } }, expected: { temperature: 0, top_k: 0 } },
	// Named temperature is serialized before arbitrary sampling; it is NOT the same override surface.
	{ name: "named temperature does not override arbitrary thinking defaults", options: { reasoning: "high", temperature: 0.2 }, expected: { temperature: 0.3, top_k: 20 } },
];
test("SDK control: all sampling fixtures produce the contracted wire payload", async () => {
	for (const row of samplingCases) assert.deepEqual(await samplingPayload(row.model ?? model, row.options, true), row.expected, row.name);
});
for (const row of samplingCases) {
	test(`T0 sampling wire: ${row.name}`, async () => {
		assert.deepEqual(await samplingPayload(row.model ?? model, row.options), row.expected);
	});
}
test("T0 off is omission, not a provider reasoning effort", () => {
	assert.equal(buildStreamOptions(model, shortContext, {}, undefined).reasoningEffort, undefined);
});

test("T0 options: retain the SDK request envelope while adapting budget and reasoning", () => {
	const transport = offlineTransport();
	const options: SimpleStreamOptions = {
		reasoning: "high", temperature: 0, samplingParams: { top_k: 9 }, maxTokens: 100,
		apiKey: "offline-only", fetch: transport.fetch, signal: new AbortController().signal,
		headers: { "x-contract": "preserved", "x-remove": null }, env: { PI_CACHE_RETENTION: "long" },
		transport: "sse", cacheRetention: "long", sessionId: "offline-session",
		timeoutMs: 2000, websocketConnectTimeoutMs: 500, maxRetries: 0, maxRetryDelayMs: 10,
		metadata: { user_id: "offline-user" },
		telemetryContext: { startSpan: async () => { throw new Error("builder must not start telemetry"); } },
		onPayload: (payload) => payload, onResponse: async () => {}, onProviderStreamEvent: async () => {},
	};
	const actual = buildStreamOptions(model, shortContext, options, "priority");
	const expected = buildBaseOptions(model, shortContext, options);
	// Sampling is deliberately NOT compared here: defaults belong to the final adapter.
	for (const key of Object.keys(expected) as Array<keyof typeof expected>) {
		if (key !== "samplingParams") assert.equal(actual[key], expected[key], `lost SDK option: ${key}`);
	}
	assert.equal(transport.requests.length, 0);
});

// Use the real loader and runtime registration, never a fake ExtensionAPI registry.
async function loadedFast(selectedModel: Model<Api> = model) {
	const root = mkdtempSync(join(tmpdir(), "pi11-fast-contract-"));
	const agentDir = join(root, "agent");
	mkdirSync(agentDir);
	const modelsPath = join(agentDir, "models.json");
	writeFileSync(modelsPath, JSON.stringify({ providers: { [selectedModel.provider]: {
		baseUrl: selectedModel.baseUrl, models: [selectedModel],
	} } }));
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../extensions/fast-mode.ts", import.meta.url))],
	});
	try {
		await loader.reload();
		assert.deepEqual(loader.getExtensions().errors, [], "real 1.1 loader must load Fast without errors");
		assert.equal(loader.getExtensions().extensions.length, 1);
		const runtime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath, refreshOnCreate: false, allowModelNetwork: false });
		const fixture = runtime.getModel(selectedModel.provider, selectedModel.id);
		assert.ok(fixture, runtime.getError());
		const { session } = await createAgentSession({
			cwd: root, agentDir, modelRuntime: runtime, model: fixture, thinkingLevel: "high",
			resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root), tools: [],
		});
		try {
			await session.bindExtensions({});
		} catch (error) {
			session.dispose();
			throw error;
		}
		return { runtime, session, fixture, dispose: () => { session.dispose(); rmSync(root, { recursive: true, force: true }); } };
	} catch (error) {
		rmSync(root, { recursive: true, force: true });
		throw error;
	}
}

for (const enabled of [false, true]) {
	test(`T2 real loader: Fast ${enabled ? "on" : "off"} preserves route, options and awaited callback`, async () => {
		const loaded = await loadedFast();
		try {
			await loaded.session.prompt(`/fast ${enabled ? "on" : "off"}`);
			const transport = offlineTransport();
			const seen: string[] = [];
			const callbacks: string[] = [];
			const { result } = await consume(loaded.runtime.streamSimple(loaded.fixture, shortContext, {
				apiKey: "offline-only", fetch: transport.fetch, reasoning: "high", maxTokens: 100,
				headers: { "x-contract": "preserved" }, sessionId: "offline-session", transport: "sse",
				env: { PI_CACHE_RETENTION: "long" }, timeoutMs: 2000, maxRetries: 0,
				onPayload: async (payload) => { callbacks.push("payload"); return { ...(payload as object), metadata: { contract: "replacement" } }; },
				onResponse: async (response) => { assert.equal(response.headers["x-request-id"], "offline-contract"); callbacks.push("response"); },
				onProviderStreamEvent: async (event, actualModel) => {
					assert.equal(actualModel.id, model.id);
					assert.equal(actualModel.provider, model.provider);
					await Promise.resolve();
					seen.push((event as { type: string }).type);
				},
			}));
			assert.equal(result.stopReason, "stop", result.errorMessage);
			assert.equal(result.content.find((block) => block.type === "text")?.text, "offline answer");
			assert.equal(transport.requests.length, 1);
			const request = transport.requests[0];
			assert.equal(request.url, "https://responses.invalid/v1/responses");
			assert.equal(request.body.model, model.id);
			assert.equal(request.headers.get("authorization"), "Bearer offline-only");
			assert.equal(request.headers.get("x-contract"), "preserved");
			assert.equal(request.body.service_tier, enabled ? "priority" : undefined);
			assert.equal(request.body.reasoning?.effort, "high");
			assert.equal(request.body.max_output_tokens, 100);
			assert.equal(request.body.prompt_cache_key, "offline-session");
			assert.deepEqual(request.body.metadata, { contract: "replacement" });
			assert.deepEqual(callbacks, ["payload", "response"]);
			assert.deepEqual(seen, rawEvents.map((event) => event.type), "provider events must reach and await the caller");
		} finally { loaded.dispose(); }
	});
}

test("SDK control: provider observers run in order and rejection fails the stream", async () => {
	for (const fail of [false, true]) {
		const transport = offlineTransport();
		const seen: unknown[] = [];
		const { result } = await consume(officialResponses(model, shortContext, {
			apiKey: "offline-only", fetch: transport.fetch, maxRetries: 0,
			onProviderStreamEvent: async (event) => {
				await Promise.resolve();
				if (fail) throw new Error("contract observer failed");
				seen.push(event);
			},
		}));
		assert.equal(transport.requests.length, 1);
		assert.equal(result.stopReason, fail ? "error" : "stop", result.errorMessage);
		if (fail) assert.match(result.errorMessage ?? "", /contract observer failed/);
		else assert.deepEqual(seen, rawEvents);
	}
});

test("T2 callback failure remains a stream error instead of silently disappearing", async () => {
	const transport = offlineTransport();
	const { result } = await consume(streamOpenAIResponses(model, shortContext, responsesOptions(model, shortContext, {
		apiKey: "offline-only", fetch: transport.fetch, maxRetries: 0,
		onProviderStreamEvent: async () => { throw new Error("contract observer failed"); },
	}, "priority")));
	assert.equal(transport.requests.length, 1);
	assert.equal(result.stopReason, "error");
	assert.match(result.errorMessage ?? "", /contract observer failed/);
});

test("T2 cancellation and non-retryable provider errors keep their terminal semantics", async () => {
	const controller = new AbortController();
	const transport = offlineTransport();
	controller.abort();
	const cancelled = await consume(streamOpenAIResponses(model, shortContext, responsesOptions(model, shortContext, {
		apiKey: "offline-only", fetch: transport.fetch, signal: controller.signal, maxRetries: 0,
	}, "priority")));
	assert.equal(cancelled.result.stopReason, "aborted");
	assert.equal(transport.requests.length, 0);
	const rejected = offlineTransport(400);
	const failed = await consume(streamOpenAIResponses(model, shortContext, responsesOptions(model, shortContext, {
		apiKey: "offline-only", fetch: rejected.fetch, maxRetries: 0,
	}, undefined)));
	assert.equal(failed.result.stopReason, "error");
	assert.match(failed.result.errorMessage ?? "", /offline rejected/);
	assert.equal(rejected.requests.length, 1);
});

test("T2 real loader: xAI Responses and custom Completions keep their own serialization and Fast tier", async (t) => {
	for (const api of ["openai-responses", "openai-completions"] as const) {
		const pricedModel = { ...model, provider: "xai", cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } };
		const loaded = await loadedFast({ ...pricedModel, api });
		try {
			await loaded.runtime.setRuntimeApiKey("xai", "offline-only");
			for (const enabled of [false, true]) {
				await loaded.session.prompt(`/fast ${enabled ? "on" : "off"}`);
				const transport = offlineTransport(200, enabled ? "priority" : "default");
				const fetchMock = t.mock.method(globalThis, "fetch", transport.fetch);
				try {
					// Custom Completions' payload hook belongs to the host event chain.
					await loaded.session.prompt("Return the offline fixture response.");
				} finally { fetchMock.mock.restore(); }
				const result = loaded.session.messages.at(-1);
				assert.equal(result?.role, "assistant");
				assert.ok(result?.role === "assistant");
				assert.equal(result.stopReason, "stop", result.errorMessage);
				assert.equal(result.provider, "xai");
				assert.equal(result.model, model.id);
				const control = offlineTransport(200, enabled ? "priority" : "default");
				const controlOptions = { apiKey: "offline-only", fetch: control.fetch, maxRetries: 0 };
				const official = await consume(api === "openai-responses"
					? streamOpenAIResponses({ ...pricedModel, api }, shortContext, controlOptions)
					: officialCompletions({ ...pricedModel, api }, shortContext, controlOptions));
				assert.equal(official.result.stopReason, "stop", official.result.errorMessage);
				assert.ok(official.result.usage.cost.total > 0, "pricing control must be non-vacuous");
				assert.deepEqual(result.usage.cost, official.result.usage.cost, "returned tier pricing must stay owned by the official adapter");
				assert.equal(transport.requests.length, 1);
				const request = transport.requests[0];
				assert.equal(request.url, `https://responses.invalid/v1/${api === "openai-responses" ? "responses" : "chat/completions"}`);
				assert.equal(request.body.service_tier, enabled ? "priority" : undefined, `${api}, Fast=${enabled}`);
				assert.equal(request.body[api === "openai-responses" ? "messages" : "input"], undefined);
			}
		} finally { loaded.dispose(); }
	}
});

test("T2 real loader: Codex keeps its account, tier and intentional arbitrary-sampling omission", async () => {
	const codex: Model<"openai-codex-responses"> = { ...model, provider: "openai-codex", api: "openai-codex-responses" };
	// Synthetic, unsigned, offline-only claim. No login or credential store is involved.
	const apiKey = `e30.${Buffer.from(JSON.stringify({ "https://api.openai.com/auth": { chatgpt_account_id: "offline-account" } })).toString("base64")}.offline`;
	const loaded = await loadedFast(codex);
	try {
		for (const enabled of [false, true]) {
			await loaded.session.prompt(`/fast ${enabled ? "on" : "off"}`);
			const control = offlineTransport();
			const transport = offlineTransport();
			const options: SimpleStreamOptions = { apiKey, transport: "sse", maxRetries: 0, reasoning: "high", samplingParams: { temperature: 0.2, top_k: 9 } };
			const official = await consume(officialCodex(codex, shortContext, {
				...options, fetch: control.fetch, reasoningEffort: "high", serviceTier: enabled ? "priority" : undefined,
			}));
			assert.equal(official.result.stopReason, "stop", official.result.errorMessage);
			const provider = loaded.runtime.getProvider(codex.provider);
			assert.ok(provider);
			// Provider entry accepts already-resolved auth; no OAuth login/refresh in an offline test.
			const actual = await consume(provider.streamSimple(loaded.fixture, shortContext, { ...options, fetch: transport.fetch }));
			assert.equal(actual.result.stopReason, "stop", actual.result.errorMessage);
			assert.equal(transport.requests.length, 1);
			assert.equal(control.requests.length, 1);
			const request = transport.requests[0];
			assert.equal(request.url, control.requests[0].url);
			assert.equal(request.headers.get("chatgpt-account-id"), "offline-account");
			assert.equal(request.headers.get("authorization"), `Bearer ${apiKey}`);
			assert.equal(request.body.model, model.id);
			assert.equal(request.body.service_tier, enabled ? "priority" : undefined);
			assert.equal(request.body.reasoning?.effort, "high");
			for (const key of ["temperature", "top_k"]) {
				assert.equal(control.requests[0].body[key], undefined);
				assert.equal(request.body[key], undefined);
			}
		}
	} finally { loaded.dispose(); }
});
