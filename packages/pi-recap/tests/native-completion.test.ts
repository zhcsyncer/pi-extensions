import assert from "node:assert/strict";
import childProcess from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { syncBuiltinESMExports } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import test, { type TestContext } from "node:test";
import { fauxAssistantMessage, fauxProvider, getCurrentSystemPrompt, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type ExtensionAPI, type ExtensionContext, type ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import recapExtension, { createRecapState, DEFAULT_CONFIG, runRecap, type RecapConfig } from "../extensions/recap.ts";

// Real SDK registration and completion; only transport/UI are synthetic. Never inject completeModel.
async function fixture(t: TestContext) {
	for (const method of ["exec", "execFile", "execSync", "execFileSync", "spawn", "spawnSync"] as const) {
		t.mock.method(childProcess, method, () => { throw new Error(`External execution blocked: ${method}`); });
	}
	syncBuiltinESMExports();
	t.after(() => { t.mock.restoreAll(); syncBuiltinESMExports(); });
	t.mock.method(globalThis, "fetch", () => { throw new Error("Unexpected network request"); });
	const root = await mkdtemp(path.join(tmpdir(), "recap-native-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	t.after(async () => {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		await rm(root, { recursive: true, force: true });
	});
	const config: RecapConfig = structuredClone(DEFAULT_CONFIG);
	config.recap.auto = false;
	config.recap.language = "zh-CN";
	config.multiplexer.enabled = false;
	await mkdir(path.join(root, "extension-data/pi-recap"), { recursive: true });
	await writeFile(path.join(root, "extension-data/pi-recap/config.json"), JSON.stringify(config));
	const current = fauxProvider({ provider: "recap-current" });
	const fixed = fauxProvider({ provider: "opencode-go" });
	const runtime = await ModelRuntime.create({ authPath: path.join(root, "auth.json"), modelsPath: null, refreshOnCreate: false });
	const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	let pi!: ExtensionAPI;
	let ctx!: ExtensionContext;
	const notifications: string[] = [];
	const widgets: unknown[] = [];
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir: root, settingsManager: settings,
		noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [(api) => {
			pi = api;
			api.registerProvider(current.provider);
			api.registerProvider({ ...fixed.provider, auth: { apiKey: {
				name: "Offline fixture auth",
				resolve: async () => ({ auth: { apiKey: "offline-fixture", headers: { "x-fixture-auth": "fixed" } } }),
			} } });
			api.on("session_start", (_event, context) => { ctx = context; });
			recapExtension(api);
		}],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const manager = SessionManager.inMemory(root);
	manager.appendMessage({ role: "user", content: "Fix the parser and its regression tests", timestamp: 1 });
	const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: runtime, model: current.getModel(), resourceLoader: loader, settingsManager: settings, sessionManager: manager, tools: [] });
	t.after(() => session.dispose());
	await session.bindExtensions({ mode: "tui", uiContext: {
		notify: (message: string) => notifications.push(message),
		setStatus() {}, setTitle() {},
		setWidget: (_key: string, value: unknown) => widgets.push(value),
	} as unknown as ExtensionUIContext });
	assert.ok(ctx);
	return { pi, ctx, session, manager, sourceId: manager.getLeafId(), config, current, fixed, notifications, widgets };
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

const reply = () => fauxAssistantMessage('{"recap":"Fixed the parser.","title":"Parser fix"}');

test("native registry preserves selected model, instructions, options and recap watermark", async (t) => {
	const f = await fixture(t);
	for (const selection of ["current", `opencode-go/${f.fixed.getModel().id}`]) {
		f.config.recap.model = selection;
		const provider = selection === "current" ? f.current : f.fixed;
		let received = false;
		provider.setResponses([(context, options, _state, model) => {
			received = true;
			assert.equal(model.provider, provider.getModel().provider);
			assert.equal(model.id, provider.getModel().id);
			assert.equal(context.messages[0]?.role, "system");
			assert.match(getCurrentSystemPrompt(context.messages), /Return ONLY valid JSON/);
			assert.match(getCurrentSystemPrompt(context.messages), /Write the recap in zh-CN/);
			assert.match(JSON.stringify(context.messages.find((message) => message.role === "user")), /Fix the parser/);
			assert.equal(options?.apiKey, selection === "current" ? undefined : "offline-fixture");
			assert.equal(options?.headers?.["x-fixture-auth"], selection === "current" ? undefined : "fixed");
			assert.equal(options?.maxTokens, 300);
			assert.equal(options?.sessionId, f.manager.getSessionId());
			assert.equal(options?.signal, controller.signal);
			assert.equal(options?.headers?.["x-opencode-session"], selection === "current" ? undefined : f.manager.getSessionId());
			assert.equal(options?.headers?.["x-opencode-client"], selection === "current" ? undefined : "pi");
			return reply();
		}]);
		const controller = new AbortController();
		const state = createRecapState(f.config);
		const result = await runRecap(f.pi, f.ctx, f.config, state, "manual", { force: true, signal: controller.signal });
		assert.ok(received);
		assert.equal(result?.recap, "Fixed the parser.");
		assert.equal(result?.model, `${provider.getModel().provider}/${provider.getModel().id}`);
		assert.equal(result?.source.toEntryId, f.sourceId);
		assert.equal(f.manager.getSessionName(), undefined, "off must not rename");
		const calls = provider.state.callCount;
		assert.equal(await runRecap(f.pi, f.ctx, f.config, state, "manual", { force: true }), undefined);
		assert.equal(provider.state.callCount, calls, "no new activity must not request completion");
	}
	assert.equal(f.manager.getBranch().filter((entry) => entry.type === "custom" && entry.customType === "recap").length, 2);
});

test("native registry control: missing fixed model only falls back when allowed", async (t) => {
	const f = await fixture(t);
	f.config.recap.model = "missing/model";
	f.config.recap.fallbackToCurrentModel = false;
	assert.equal(await runRecap(f.pi, f.ctx, f.config, createRecapState(f.config), "manual", { force: true }), undefined);
	assert.equal(f.current.state.callCount, 0);
	assert.equal(f.fixed.state.callCount, 0);
	f.config.recap.fallbackToCurrentModel = true;
	f.config.title.applyPolicy = "always";
	f.current.setResponses([reply()]);
	const result = await runRecap(f.pi, f.ctx, f.config, createRecapState(f.config), "manual", { force: true });
	assert.equal(result?.model, `${f.current.getModel().provider}/${f.current.getModel().id}`);
	assert.equal(f.manager.getSessionName(), "Parser fix");
	assert.ok(f.notifications.some((message) => message.includes("falling back")));
	assert.equal(f.fixed.state.callCount, 0);
});

test("native registry ignores a completion released after manual cancellation", async (t) => {
	const f = await fixture(t);
	f.config.title.applyPolicy = "always";
	const started = deferred<void>();
	const released = deferred<ReturnType<typeof reply>>();
	const response: FauxResponseFactory = (_context, options) => {
		assert.equal(options?.signal, controller.signal);
		started.resolve();
		return released.promise;
	};
	f.current.setResponses([response]);
	const controller = new AbortController();
	const state = createRecapState(f.config);
	const pending = runRecap(f.pi, f.ctx, f.config, state, "manual", { force: true, signal: controller.signal });
	await started.promise;
	controller.abort();
	released.resolve(reply());
	assert.equal(await pending, undefined);
	assert.equal(state.lastRecapSourceToEntryId, undefined);
	assert.equal(f.manager.getSessionName(), undefined);
	assert.equal(f.manager.getBranch().filter((entry) => entry.type === "custom").length, 0);
	assert.equal(f.widgets.at(-1), undefined);
});
