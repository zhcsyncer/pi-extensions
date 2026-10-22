import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { fileURLToPath } from "node:url";
import { InMemoryCredentialStore, InMemoryModelsStore, type ApiKeyCredential } from "@earendil-works/pi-ai/compat";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";

const providerId = "volcengine-agent-plan";
const baseUrl = "https://ark.cn-beijing.volces.com/api/plan/v3";
const responsesUrl = `${baseUrl}/responses`;
const completionsUrl = `${baseUrl}/chat/completions`;
const envNames = ["ARK_AGENT_PLAN_API_KEY", "VOLCENGINE_ARK_PLAN_API_KEY", "ARK_AGENT_PLAN_TIER", "OPENAI_API_KEY", "MOONSHOT_API_KEY"];

type Body = Record<string, any>;
type CapturedRequest = { url: string; headers: Headers; body: Body };

// HTTP/SSE fixtures only: adapters, message conversion, auth and extension dispatch stay real.
function sse(events: unknown[]): string {
	return events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("");
}

function responseEvents(complete = true): unknown[] {
	const item = { type: "message", id: "msg_fixture", role: "assistant", status: "in_progress", content: [] };
	const events: unknown[] = [
		{ type: "response.created", response: { id: "resp_fixture", status: "in_progress" } },
		{ type: "response.output_item.added", output_index: 0, item },
		{ type: "response.content_part.added", output_index: 0, content_index: 0, part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, delta: "fixture answer" },
	];
	if (complete) events.push(
		{ type: "response.output_text.done", output_index: 0, content_index: 0, text: "fixture answer" },
		{ type: "response.output_item.done", output_index: 0, item: { ...item, status: "completed", content: [{ type: "output_text", text: "fixture answer", annotations: [] }] } },
		{ type: "response.completed", response: { id: "resp_fixture", status: "completed", usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12 } } },
	);
	return events;
}

function completionEvents(complete = true, thinking = true): unknown[] {
	const chunk = { id: "chat_fixture", object: "chat.completion.chunk", created: 1, model: "kimi-k2.7-code" };
	const events: unknown[] = [{ ...chunk, choices: [{ index: 0, delta: {
		role: "assistant", ...(thinking ? { reasoning_content: "fixture reasoning" } : {}), content: "fixture answer",
	}, finish_reason: null }] }];
	if (complete) events.push({ ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } });
	return events;
}

function success(url: string, thinking = true): Response {
	return new Response(sse(url === responsesUrl ? responseEvents() : completionEvents(true, thinking)), {
		headers: { "content-type": "text/event-stream" },
	});
}

async function setup(t: TestContext, options: {
	credential?: ApiKeyCredential | null;
	env?: Record<string, string>;
} = {}) {
	const root = await mkdtemp(join(tmpdir(), "agent-plan-sdk-"));
	const previousEnv = envNames.map((name) => [name, process.env[name]] as const);
	for (const name of envNames) delete process.env[name];
	Object.assign(process.env, { OPENAI_API_KEY: "synthetic-wrong-openai", MOONSHOT_API_KEY: "synthetic-wrong-moonshot", ...options.env });
	const requests: CapturedRequest[] = [];
	const blocked: string[] = [];
	let reply = async (request: Request) => success(request.url);
	const originalFetch = globalThis.fetch;
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		if (![responsesUrl, completionsUrl].includes(request.url) || request.method !== "POST") {
			blocked.push(`${request.method} ${request.url}`);
			throw new Error("Request outside exact Agent Plan fixture allowlist");
		}
		requests.push({ url: request.url, headers: request.headers, body: await request.clone().json() as Body });
		return reply(request);
	};
	t.after(async () => {
		globalThis.fetch = originalFetch;
		for (const [name, value] of previousEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		await rm(root, { recursive: true, force: true });
		assert.deepEqual(blocked, [], "no login, catalog, account or cross-channel network calls");
	});
	const credentials = new InMemoryCredentialStore();
	const credential = options.credential === undefined
		? { type: "api_key" as const, key: "synthetic-stored-plan", env: { ARK_AGENT_PLAN_TIER: "medium" } }
		: options.credential;
	if (credential) await credentials.modify(providerId, async () => credential);
	const runtime = await ModelRuntime.create({
		credentials, modelsPath: null, modelsStore: new InMemoryModelsStore(), refreshOnCreate: false,
	});
	const settings = SettingsManager.inMemory({
		defaultProvider: providerId, defaultModel: "doubao-seed-2.0-mini",
		compaction: { enabled: false }, retry: { enabled: false },
	});
	const observed: Body[] = [];
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../index.ts", import.meta.url))],
		extensionFactories: [(pi) => {
			pi.on("before_provider_request", (event) => { observed.push(structuredClone(event.payload) as Body); });
		}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const { session } = await createAgentSession({
		cwd: root, agentDir: root, modelRuntime: runtime, resourceLoader: loader,
		settingsManager: settings, sessionManager: SessionManager.inMemory(root), tools: [],
	});
	t.after(() => session.dispose());
	await session.bindExtensions({});
	assert.ok(runtime.getRegisteredNativeProvider(providerId), "registered through the actual extension loader");
	for (const model of runtime.getModels(providerId)) {
		assert.equal(model.provider, providerId);
		assert.equal(model.baseUrl, baseUrl);
		assert.equal(model.api, model.id === "kimi-k2.7-code" ? "openai-completions" : "openai-responses");
	}
	assert.equal(requests.length, 0, "loading and binding must not validate keys or infer");
	return { runtime, session, requests, observed, setReply(fn: typeof reply) { reply = fn; } };
}

function assertSuccessfulReply(session: Awaited<ReturnType<typeof createAgentSession>>["session"]) {
	assert.equal(session.getLastAssistantText(), "fixture answer");
	const message = session.messages.at(-1);
	assert.equal(message?.role, "assistant");
	if (message?.role !== "assistant") throw new Error("Expected an assistant reply");
	assert.equal(message.stopReason, "stop");
	assert.equal(message.provider, providerId);
	assert.equal(message.usage.input, 10);
	assert.equal(message.usage.output, 2);
	assert.equal(message.usage.totalTokens, 12);
}

function assertRequest(request: CapturedRequest, url: string, key: string) {
	assert.equal(request.url, url);
	assert.equal(request.headers.get("authorization"), `Bearer ${key}`);
	assert.match(request.headers.get("content-type") ?? "", /^application\/json/);
	assert.equal(request.body.stream, true);
}

const authCases: { name: string; credential: ApiKeyCredential | null; env: Record<string, string>; key: string; tier: string; source: string }[] = [
	{ name: "stored credential and tier win over both environment keys", credential: { type: "api_key" as const, key: " synthetic-stored ", env: { ARK_AGENT_PLAN_TIER: "small" } }, env: { ARK_AGENT_PLAN_API_KEY: "synthetic-primary", VOLCENGINE_ARK_PLAN_API_KEY: "synthetic-secondary", ARK_AGENT_PLAN_TIER: "max" }, key: "synthetic-stored", tier: "small", source: "Pi auth.json" },
	{ name: "primary environment key wins; environment small hides K3", credential: null, env: { ARK_AGENT_PLAN_API_KEY: " synthetic-primary ", VOLCENGINE_ARK_PLAN_API_KEY: "synthetic-secondary", ARK_AGENT_PLAN_TIER: "small" }, key: "synthetic-primary", tier: "small", source: "ARK_AGENT_PLAN_API_KEY" },
	{ name: "secondary key and missing tier use medium", credential: null, env: { VOLCENGINE_ARK_PLAN_API_KEY: "synthetic-secondary" }, key: "synthetic-secondary", tier: "medium", source: "VOLCENGINE_ARK_PLAN_API_KEY" },
	{ name: "blank stored and primary keys fall through; invalid tier uses medium", credential: { type: "api_key" as const, key: " ", env: { ARK_AGENT_PLAN_TIER: "invalid" } }, env: { ARK_AGENT_PLAN_API_KEY: " ", VOLCENGINE_ARK_PLAN_API_KEY: "synthetic-secondary", ARK_AGENT_PLAN_TIER: "invalid" }, key: "synthetic-secondary", tier: "medium", source: "VOLCENGINE_ARK_PLAN_API_KEY" },
	...(["large", "max"] as const).map((tier) => ({ name: `stored ${tier} exposes K3 despite small environment`, credential: { type: "api_key" as const, key: "synthetic-stored", env: { ARK_AGENT_PLAN_TIER: tier } }, env: { ARK_AGENT_PLAN_TIER: "small" }, key: "synthetic-stored", tier, source: "Pi auth.json" })),
];
for (const row of authCases) {
	test(row.name, async (t) => {
		const h = await setup(t, row);
		const check = await h.runtime.checkAuth(providerId);
		assert.equal(check?.type, "api_key");
		const auth = await h.runtime.getAuth(providerId);
		assert.equal(auth?.source, row.source);
		assert.equal(auth?.env?.ARK_AGENT_PLAN_TIER, row.tier);
		const available = await h.runtime.getAvailable(providerId);
		assert.equal(available.length, row.tier === "small" ? 11 : 12);
		assert.equal(available.some((model) => model.id === "kimi-k3"), row.tier !== "small");
		assert.equal(h.requests.length, 0, "auth check/resolve and tier filtering are local");
		await h.session.setModel(available.find((model) => model.id === "doubao-seed-2.0-mini")!);
		await h.session.prompt("fixture question");
		assertSuccessfulReply(h.session);
		assert.equal(h.requests.length, 1);
		assertRequest(h.requests[0], responsesUrl, row.key);
	});
}

test("unrelated provider keys cannot authenticate Agent Plan", async (t) => {
	const h = await setup(t, { credential: null });
	assert.equal(await h.runtime.checkAuth(providerId), undefined);
	assert.equal(await h.runtime.getAuth(providerId), undefined);
	assert.deepEqual(await h.runtime.getAvailable(providerId), []);
	assert.equal(h.requests.length, 0);
});

for (const id of ["deepseek-v4.1-flash", "doubao-seed-2.1-turbo"]) {
	test(`${id} keeps native reasoning and include while toggling Plan thinking`, async (t) => {
		const h = await setup(t);
		const model = h.runtime.getModel(providerId, id);
		assert.ok(model);
		await h.session.setModel(model);
		for (const level of ["off", "high"] as const) {
			h.session.setThinkingLevel(level);
			await h.session.prompt(`fixture ${level}`);
			assertSuccessfulReply(h.session);
			const request = h.requests.at(-1)!;
			assertRequest(request, responsesUrl, "synthetic-stored-plan");
			assert.equal(request.body.model, id);
			assert.deepEqual(request.body.thinking, { type: level === "off" ? "disabled" : "enabled" });
			assert.deepEqual(request.body.reasoning, level === "off" ? { effort: "none" } : { effort: "high", summary: "auto" });
			assert.deepEqual(request.body.include, level === "off" ? undefined : ["reasoning.encrypted_content"]);
			assert.deepEqual(request.body, JSON.parse(JSON.stringify(h.observed.at(-1))), "the public request event reaches the HTTP adapter intact");
		}
		assert.equal(h.requests.length, 2);
	});
}

test("Kimi uses chat completions and replays reasoning_content, including empty reasoning", async (t) => {
	const h = await setup(t);
	const model = h.runtime.getModel(providerId, "kimi-k2.7-code");
	assert.ok(model);
	await h.session.setModel(model);
	h.session.setThinkingLevel("high");
	// First reply has reasoning, the second deliberately has only text.
	h.setReply(async (request) => success(request.url, h.requests.length === 1));
	for (let turn = 0; turn < 3; turn++) {
		await h.session.prompt("fixture question");
		assertSuccessfulReply(h.session);
		const request = h.requests.at(-1)!;
		assertRequest(request, completionsUrl, "synthetic-stored-plan");
		assert.equal(request.body.model, "kimi-k2.7-code");
		assert.equal(request.body.messages[0].role, "system");
		assert.equal(request.body.reasoning_effort, "high");
		assert.equal(request.body.max_completion_tokens, model.maxTokens);
		assert.equal(request.body.max_tokens, undefined);
		assert.equal(request.body.thinking, undefined);
		assert.deepEqual(request.body.stream_options, { include_usage: true });
	}
	const assistants = h.requests[2].body.messages.filter((message: Body) => message.role === "assistant");
	assert.deepEqual(assistants.map((message: Body) => message.reasoning_content), ["fixture reasoning", ""]);
});

for (const [id, url] of [["doubao-seed-2.0-mini", responsesUrl], ["kimi-k2.7-code", completionsUrl]]) {
	test(`${id} preserves terminal server errors without cross-channel retry`, async (t) => {
		const h = await setup(t);
		h.setReply(async () => new Response(JSON.stringify({ error: { message: "synthetic gateway outage", type: "server_error", code: "InternalError" } }), { status: 500, headers: { "content-type": "application/json" } }));
		const model = h.runtime.getModel(providerId, id)!;
		const stream = h.runtime.streamSimple(model, { messages: [{ role: "user", content: "fixture", timestamp: 1 }] }, { maxRetries: 0 });
		const events = [];
		for await (const event of stream) events.push(event.type);
		const result = await stream.result();
		assert.equal(result.stopReason, "error");
		assert.match(result.errorMessage ?? "", /synthetic gateway outage/);
		assert.deepEqual(events, ["error"]);
		assert.equal(h.requests.length, 1);
		assertRequest(h.requests[0], url, "synthetic-stored-plan");
	});

	test(`${id} cancels an active HTTP stream without becoming success`, async (t) => {
		const h = await setup(t);
		h.setReply(async (request) => new Response(new ReadableStream<Uint8Array>({
			start(controller) {
				controller.enqueue(new TextEncoder().encode(sse(url === responsesUrl ? responseEvents(false) : completionEvents(false))));
				request.signal.addEventListener("abort", () => controller.error(new DOMException("Fixture aborted", "AbortError")), { once: true });
			},
		}), { headers: { "content-type": "text/event-stream" } }));
		const controller = new AbortController();
		const stream = h.runtime.streamSimple(h.runtime.getModel(providerId, id)!, {
			messages: [{ role: "user", content: "fixture", timestamp: 1 }],
		}, { signal: controller.signal, maxRetries: 0 });
		const events = [];
		for await (const event of stream) {
			events.push(event.type);
			if (event.type === "text_delta") controller.abort();
		}
		const result = await stream.result();
		assert.equal(result.stopReason, "aborted");
		assert.ok(result.errorMessage);
		assert.ok(events.includes("text_delta"));
		assert.equal(events.at(-1), "error");
		assert.equal(events.includes("done"), false);
		assert.equal(h.requests.length, 1);
		assertRequest(h.requests[0], url, "synthetic-stored-plan");
	});
}
