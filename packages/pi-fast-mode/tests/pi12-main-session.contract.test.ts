import assert from "node:assert/strict";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { zstdDecompressSync } from "node:zlib";
import {
	createAgentSession, DefaultResourceLoader, initTheme, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";

// Integration contracts: real SDK loader, AgentSession, Agent loop and provider serializers.
// Only the HTTP transport is synthetic. Run through scripts/run-isolated.mjs as a second
// network boundary; never use a developer profile or a live provider credential.
const extensionPath = fileURLToPath(new URL("../extensions/fast-mode.ts", import.meta.url));
const cases = [
	["openai", "openai-responses", "contract-responses"],
	["openai-codex", "openai-codex-responses", "contract-codex"],
	["xai", "openai-responses", "contract-xai-responses"],
	["xai", "openai-completions", "contract-xai-completions"],
] as const;
const syntheticKey = `test.${Buffer.from(JSON.stringify({
	"https://api.openai.com/auth": { chatgpt_account_id: "offline-contract-account" },
})).toString("base64url")}.not-a-signature`;
type Wire = { url: string; headers: Headers; body: Record<string, unknown> };

function response(completions: boolean): Response {
	const usage = { input_tokens: 2, output_tokens: 1, total_tokens: 3 };
	const frames = completions ? [
		{ id: "chat-offline", object: "chat.completion.chunk", choices: [{ index: 0, delta: { role: "assistant", content: "ok" }, finish_reason: null }] },
		{ id: "chat-offline", object: "chat.completion.chunk", choices: [{ index: 0, delta: {}, finish_reason: "stop" }] },
	] : [
		{ type: "response.created", response: { id: "resp-offline", status: "in_progress", output: [] } },
		{ type: "response.output_item.added", output_index: 0, item: { id: "msg-offline", type: "message", role: "assistant", content: [], status: "in_progress" } },
		{ type: "response.content_part.added", output_index: 0, content_index: 0, item_id: "msg-offline", part: { type: "output_text", text: "", annotations: [] } },
		{ type: "response.output_text.delta", output_index: 0, content_index: 0, item_id: "msg-offline", delta: "ok" },
		{ type: "response.output_item.done", output_index: 0, item: { id: "msg-offline", type: "message", role: "assistant", status: "completed", content: [{ type: "output_text", text: "ok", annotations: [] }] } },
		{ type: "response.completed", response: { id: "resp-offline", status: "completed", output: [], usage } },
	];
	return new Response(frames.map((frame) => `data: ${JSON.stringify(frame)}\n\n`).join("") + (completions ? "data: [DONE]\n\n" : ""), {
		headers: { "content-type": "text/event-stream" },
	});
}

async function fixture() {
	initTheme("dark", false);
	const root = await mkdtemp(join(tmpdir(), "pi12-fast-contract-"));
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	const originalFetch = globalThis.fetch;
	const wire: Wire[] = [];
	globalThis.fetch = async (input, init) => {
		const request = new Request(input, init);
		assert.equal(new URL(request.url).hostname, "127.0.0.1", "fixture must never contact a real provider");
		const bytes = Buffer.from(await request.arrayBuffer());
		const body = JSON.parse((request.headers.get("content-encoding") === "zstd" ? zstdDecompressSync(bytes) : bytes).toString());
		wire.push({ url: request.url, headers: request.headers, body });
		return response(request.url.endsWith("/chat/completions"));
	};
	const runtime = await ModelRuntime.create({
		authPath: join(root, "auth.json"), modelsPath: join(root, "models.json"),
		modelsStorePath: join(root, "models-cache.json"), refreshOnCreate: false,
	});
	for (const provider of ["openai", "openai-codex", "xai", "unrelated"]) {
		const models: Array<{ api: typeof cases[number][1]; id: string }> = cases.filter(([p]) => p === provider).map(([, api, id]) => ({ api, id }));
		if (provider === "openai") models.push({ api: "openai-responses", id: "contract-second" });
		if (provider === "unrelated") models.push({ api: "openai-responses", id: "contract-responses" });
		runtime.registerProvider(provider, {
			baseUrl: `http://127.0.0.1:1/${provider}/v1`, apiKey: syntheticKey,
			headers: { "x-contract-channel": provider },
			models: models.map((model) => ({ ...model, name: model.id, reasoning: false,
				input: ["text"], contextWindow: 32000, maxTokens: 1024,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } })),
		});
	}
	// Observe a public operation, not a private registry or loader implementation.
	const registrations: string[] = [];
	const registerProvider = runtime.registerProvider.bind(runtime);
	runtime.registerProvider = (name, config) => { registrations.push(name); registerProvider(name, config); };
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false }, transport: "sse" });
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: true, additionalExtensionPaths: [extensionPath],
		noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
		systemPrompt: "Reply ok. No tools.",
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const model = (provider: string, id: string) => {
		const found = runtime.getModel(provider, id);
		assert.ok(found, `${provider}/${id} must exist in the fixture catalog`);
		return found;
	};
	const { session } = await createAgentSession({
		cwd: root, agentDir: root, modelRuntime: runtime, resourceLoader: loader,
		model: model("openai", "contract-responses"), settingsManager: settings,
		sessionManager: SessionManager.inMemory(root), tools: [], thinkingLevel: "off",
	});
	const errors: unknown[] = [];
	session.extensionRunner.onError((error) => errors.push(error));
	const terminalHandlers = new Set<Parameters<ExtensionUIContext["onTerminalInput"]>[0]>();
	await session.bindExtensions({ mode: "tui", uiContext: {
		...session.extensionRunner.getUIContext(),
		onTerminalInput(handler) { terminalHandlers.add(handler); return () => { terminalHandlers.delete(handler); }; },
	} });
	return {
		async ctrlF() {
			const shortcut = session.extensionRunner.getShortcuts({}).get("ctrl+f");
			if (shortcut) await shortcut.handler(session.extensionRunner.createContext());
			else {
				assert.ok(terminalHandlers.size, "Ctrl+F requires a shortcut or terminal-input handler");
				for (const handler of terminalHandlers) handler("\u0006");
			}
		},
		session, loader, runtime, registrations, root, model, wire,
		async select(provider: string, id: string) { await session.setModel(model(provider, id)); },
		async request() {
			const before = wire.length;
			await session.prompt("Reply ok.");
			assert.deepEqual(errors, [], "extension errors must not be silently swallowed");
			const last = session.messages.at(-1);
			assert.equal(wire.length, before + 1, `one normal Agent request must reach the controlled transport: ${JSON.stringify(last)}`);
			assert.equal(last?.role, "assistant");
			assert.equal(last && "stopReason" in last ? last.stopReason : undefined, "stop", JSON.stringify(last));
			assert.equal(session.getLastAssistantText(), "ok");
			return wire.at(-1)!;
		},
		async close() {
			session.dispose();
			globalThis.fetch = originalFetch;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			await rm(root, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
		},
	};
}

for (const [provider, api, id] of cases) {
	test(`normal Agent requests: ${provider}/${api} sends priority only while on`, async () => {
		const f = await fixture();
		try {
			await f.select(provider, id);
			await f.session.prompt("/fast off");
			const off = await f.request();
			assert.equal(off.body.service_tier, undefined);
			assert.ok(off.url.startsWith(`http://127.0.0.1:1/${provider}/v1/`));
			await f.session.prompt("/fast on");
			const on = await f.request();
			assert.equal(on.body.service_tier, "priority");
			assert.equal(on.body.model, id);
			assert.equal(on.url, off.url, "Fast must not change endpoint/account channel");
			assert.equal(on.headers.get("authorization"), `Bearer ${syntheticKey}`);
			assert.equal(on.headers.get("x-contract-channel"), provider);
			assert.equal(on.headers.get("chatgpt-account-id"), off.headers.get("chatgpt-account-id"));
			await f.session.prompt("/fast off");
			assert.equal((await f.request()).body.service_tier, undefined);
		} finally { await f.close(); }
	});
}

test("switches are scoped by provider/model; unrelated requests stay untouched", async () => {
	const f = await fixture();
	try {
		await f.session.prompt("/fast on");
		await f.select("openai", "contract-second");
		assert.equal((await f.request()).body.service_tier, undefined);
		await f.select("unrelated", "contract-responses");
		await f.session.prompt("/fast on");
		assert.equal((await f.request()).body.service_tier, undefined);
		await f.select("openai", "contract-responses");
		assert.equal((await f.request()).body.service_tier, "priority");
	} finally { await f.close(); }
});

test("Fast owns no provider registration and does not alter a third-party direct call", async () => {
	const f = await fixture();
	try {
		await f.session.prompt("/fast on");
		assert.equal((await f.request()).body.service_tier, "priority");
		const ctx = f.session.extensionRunner.createContext();
		const result = await ctx.modelRegistry.streamSimple(f.session.model!, {
			messages: [{ role: "user", content: "A third-party side call", timestamp: 0 }],
		}, { transport: "sse" }).result();
		assert.equal(result.stopReason, "stop");
		assert.deepEqual({ sideCallTier: f.wire.at(-1)!.body.service_tier, registrations: f.registrations },
			{ sideCallTier: undefined, registrations: [] }, "Fast is a main-session hook, not a provider-wide override");
	} finally { await f.close(); }
});

test("request hook shallow-copies only supported ON payloads, preserving existing fields", async () => {
	const f = await fixture();
	try {
		const runner = f.session.extensionRunner;
		assert.ok(runner.hasHandlers("before_provider_request"), "Fast must use the public main-session request hook");
		const payload = Object.freeze({ model: "contract-responses", service_tier: "default", metadata: { sentinel: true }, input: [{ role: "user", content: "keep" }] });
		await f.session.prompt("/fast off");
		assert.equal(await runner.emitBeforeProviderRequest(payload), payload);
		await f.session.prompt("/fast on");
		const changed = await runner.emitBeforeProviderRequest(payload) as typeof payload;
		assert.notEqual(changed, payload);
		assert.deepEqual(changed, { ...payload, service_tier: "priority" });
		assert.equal(changed.metadata, payload.metadata);
		assert.equal(changed.input, payload.input);
		for (const input of [null, undefined, "payload", 42, false]) {
			assert.equal(await runner.emitBeforeProviderRequest(input), input);
		}
		await f.select("unrelated", "contract-responses");
		assert.equal(await runner.emitBeforeProviderRequest(payload), payload);
		// Missing-model is not reachable in a valid Agent run, so exercise the loaded
		// public handler with the real context except for this explicit boundary value.
		const context = { ...runner.createContext(), model: undefined } as ExtensionContext;
		for (const extension of f.loader.getExtensions().extensions) {
			for (const handler of extension.handlers.get("before_provider_request") ?? []) {
				const result = await handler({ type: "before_provider_request", payload }, context);
				assert.ok(result === undefined || result === payload);
			}
		}
	} finally { await f.close(); }
});

test("Ctrl+F toggles and /fast default persists only the selected model", async () => {
	const f = await fixture();
	try {
		await f.session.prompt("/fast off");
		await f.ctrlF();
		await f.ctrlF(); // An immediate held-key repeat must not flip the switch back.
		assert.equal((await f.request()).body.service_tier, "priority");
		await f.session.prompt("/fast default off");
		assert.equal((await f.request()).body.service_tier, undefined);
		await f.session.prompt("/fast default on");
		assert.equal((await f.request()).body.service_tier, "priority");
		const settings = JSON.parse(await readFile(join(f.root, "settings.json"), "utf8"));
		assert.deepEqual(settings["fast-mode"].models, ["openai/contract-responses"]);
		await f.session.prompt("/fast off");
		await f.session.reload();
		assert.equal((await f.request()).body.service_tier, "priority", "reload must restore the saved per-model default");
		await f.select("openai", "contract-second");
		assert.equal((await f.request()).body.service_tier, undefined);
		await assert.rejects(readFile(join(f.root, "models.json")), { code: "ENOENT" });
	} finally { await f.close(); }
});
