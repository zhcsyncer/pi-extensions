import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { InMemoryCredentialStore, InMemoryModelsStore, Type, fauxAssistantMessage, fauxProvider, type Usage } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, defineTool, ModelRuntime, SessionManager, SettingsManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../config.js";
import { RuntimeRefreshSession } from "../runtime-refresh-session.js";
import { usageTotalsFromEntries } from "../runtime-snapshot.js";
import { costSegmentFeature } from "../cost-segment-feature.js";
import type { SegmentRenderContext } from "../types.js";

function usage(cost: number): Usage {
	return { input: 1, output: 1, cacheRead: 2, cacheWrite: 3, totalTokens: 7, cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}

const root = mkdtempSync(join(tmpdir(), "glance-recorded-"));
const config = defaultConfig();
let ctx: ExtensionContext | undefined;
let time = 1000;
const refresh = new RuntimeRefreshSession({
	getConfig: () => config, ensureConfig: async () => config,
	getThinkingLevel: () => "off", getAutoCompactionEnabled: () => false,
	nowMs: () => ++time, requestRender: () => {}, scheduleGitRefresh: () => {},
});
const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
const faux = fauxProvider({ provider: "glance-offline", models: [{ id: "fixture", contextWindow: 128000, maxTokens: 4096 }] });
modelRuntime.registerNativeProvider(faux.provider);
await modelRuntime.setRuntimeApiKey("glance-offline", "synthetic-only");
await modelRuntime.refresh({ allowNetwork: false });
const manager = SessionManager.create(root, join(root, "sessions"));
const settings = SettingsManager.inMemory({ packages: [], retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0 }, cacheWarming: "off" });
const errors: unknown[] = [];
let earlyMessageCount = 0;
const loader = new DefaultResourceLoader({
	cwd: root, agentDir: root, settingsManager: settings, noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
	systemPrompt: "Offline usage regression.",
	extensionFactories: [pi => {
		pi.on("session_start", (_event, context) => { ctx = context; refresh.sessionStart(context); });
		pi.on("agent_start", () => refresh.agentStart());
		pi.on("message_update", event => refresh.messageUpdate(event.assistantMessageEvent.type));
		pi.on("message_end", async (event, context) => {
			if (event.message.role === "assistant") {
				earlyMessageCount++;
				assert.equal(manager.getEntries().some(entry => entry.type === "message" && entry.message === event.message), false, "SDK message_end is before persistence");
			}
			await refresh.messageEnd(event.message, context);
		});
		pi.on("turn_end", (event, context) => refresh.turnEnd(event, context));
		pi.on("agent_end", (event, context) => refresh.agentEnd(event, context));
		pi.on("agent_settled", (_event, context) => refresh.agentSettled(context));
		pi.on("session_compact", (_event, context) => refresh.execute("session_compact", context));
		pi.on("session_tree", (_event, context) => refresh.execute("session_tree", context));
		pi.on("session_before_compact", event => ({ compaction: { summary: "summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, usage: usage(0.04) } }));
		pi.registerTool(defineTool({ name: "inner", label: "Inner", description: "offline nested work", parameters: Type.Object({}), async execute() {
			return { content: [{ type: "text", text: "inner" }], details: {}, usage: usage(0.02) };
		} }));
		pi.registerTool(defineTool({ name: "outer", label: "Outer", description: "offline outer work", parameters: Type.Object({}), async execute(_id, _args, _signal, _update, context) {
			await context.executeTool("inner", {});
			manager.appendUsage("future-kind", "glance-offline", "fixture", usage(0.02));
			return { content: [{ type: "text", text: "outer" }], details: {}, usage: usage(0.01) };
		} }));
		// A later extension replaces the event payload. Only its persisted result owns cost.
		pi.on("message_end", event => event.message.role === "assistant" ? { message: { ...event.message, usage: usage(event.message.stopReason === "toolUse" ? 0.01 : 0) } } : undefined);
	}],
});
await loader.reload();
assert.deepEqual(loader.getExtensions().errors, []);
const { session } = await createAgentSession({ cwd: root, agentDir: root, settingsManager: settings, resourceLoader: loader, modelRuntime, model: faux.getModel(), sessionManager: manager, noTools: "builtin" });
try {
	await session.bindExtensions({ mode: "print", onError: error => errors.push(error) });
	faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "outer-1", name: "outer", arguments: {} }], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
	await session.prompt("Run outer.");
	assert.ok(ctx);
	assert.equal(earlyMessageCount, 2);
	assert.ok(Math.abs(refresh.getState()!.usage.cost - 0.06) < 1e-12, "assistant .01 + outer .03 + unknown-kind .02; no nested double count");
	assert.deepEqual(refresh.getState()!.usage, usageTotalsFromEntries(manager.getEntries()));
	assert.deepEqual(
		[refresh.getState()!.usage.input, refresh.getState()!.usage.output, refresh.getState()!.usage.cacheRead, refresh.getState()!.usage.cacheWrite],
		[5, 5, 10, 15], "standalone and outer rollup populate their token buckets exactly once",
	);
	const contextBefore = session.messages;
	const throughputBefore = structuredClone(refresh.getState()!.throughput);
	const shared = usage(0.01);
	const first = manager.appendUsage("cache_warm", "glance-offline", "fixture", shared);
	const second = manager.appendUsage("cache_warm", "glance-offline", "fixture", shared);
	assert.notEqual(first.id, second.id);
	refresh.agentSettled(ctx);
	refresh.agentSettled(ctx);
	assert.ok(Math.abs(refresh.getState()!.usage.cost - 0.08) < 1e-12, "two IDs count separately despite shared payload; repeated boundaries are idempotent");
	assert.deepEqual(session.messages, contextBefore, "standalone usage never enters model context");
	assert.deepEqual(refresh.getState()!.throughput, throughputBefore, "standalone usage never enters throughput");
	assert.equal(usageTotalsFromEntries([first, second, first]).cost, 0.02, "snapshot deduplicates stable IDs too");

	const lastAssistant = fauxAssistantMessage("same response");
	lastAssistant.usage = usage(0.01);
	lastAssistant.responseId = "reused-response";
	manager.appendMessage(lastAssistant);
	manager.appendMessage(lastAssistant);
	await refresh.turnEnd({}, ctx);
	assert.ok(Math.abs(refresh.getState()!.usage.cost - 0.10) < 1e-12, "same assistant payload and responseId still represents two persisted entries");
	await session.compact();
	assert.ok(Math.abs(refresh.getState()!.usage.cost - 0.14) < 1e-12, "real SDK compaction usage is counted");
	assert.equal(refresh.getState()!.context.tokens, null);
	manager.branch(first.id);
	await refresh.execute("session_tree", ctx);
	assert.ok(Math.abs(refresh.getState()!.usage.cost - 0.14) < 1e-12, "tree follows full-session totals, not branch-only cost");
	await refresh.execute("config_save_success", ctx);
	assert.deepEqual(refresh.getState()!.usage, usageTotalsFromEntries(manager.getEntries()));
	manager.branchWithSummary(first.id, "branch summary", undefined, true, usage(0.05));
	await refresh.execute("session_tree", ctx);
	assert.ok(Math.abs(refresh.getState()!.usage.cost - 0.19) < 1e-12, "branch summary usage adds once without dropping abandoned branch costs");
	await session.reload();
	assert.deepEqual(refresh.getState()!.usage, usageTotalsFromEntries(manager.getEntries()), "reload reconstructs the same recorded totals");

	const oldEntryCount = manager.getEntries().length;
	const boundedContext = { ...ctx!, sessionManager: new Proxy(manager, {
		get(target, key) {
			if (key === "getEntries") return () => target.getEntries().map((entry, index) => index < oldEntryCount
				? new Proxy(entry, { get() { throw new Error("Incremental boundary revisited an old record"); } }) : entry);
			const value = Reflect.get(target, key);
			return typeof value === "function" ? value.bind(target) : value;
		},
	}) } as ExtensionContext;
	const { cost: _cost, ...missingCost } = usage(0);
	manager.appendUsage("unknown-price", "glance-offline", "fixture", missingCost as Usage);
	refresh.agentSettled(boundedContext);
	refresh.agentSettled(boundedContext);
	assert.equal(refresh.getState()!.usage.costUnknown, true);
	assert.ok(Math.abs(refresh.getState()!.usage.cost - 0.19) < 1e-12, "unknown does not erase known subtotal");
	const collect = () => costSegmentFeature.collect({ config, state: refresh.getState() } as SegmentRenderContext);
	assert.ok(collect()?.primary.endsWith("?"));
	config.cost.hideZero = true;
	const emptyManager = SessionManager.inMemory(root);
	const emptyContext = { ...ctx!, sessionManager: emptyManager } as ExtensionContext;
	refresh.sessionStart(emptyContext);
	emptyManager.appendUsage("cache_warm", "glance-offline", "fixture", usage(0));
	refresh.agentSettled(emptyContext);
	assert.equal(refresh.getState()!.usage.costUnknown, undefined);
	assert.equal(collect(), undefined, "confirmed zero obeys hideZero");
	emptyManager.appendUsage("unknown", "glance-offline", "fixture", missingCost as Usage);
	refresh.agentSettled(emptyContext);
	assert.equal(collect()?.primary, "$0.000?", "unknown zero is visible even with hideZero");
	for (const invalid of [NaN, Infinity, -1]) {
		const entry = emptyManager.appendUsage("invalid", "glance-offline", "fixture", { ...usage(0), cost: { ...usage(0).cost, total: invalid } });
		assert.equal(usageTotalsFromEntries([entry]).costUnknown, true);
	}
	assert.deepEqual(errors, []);
	console.log("✓ recorded usage: real SDK lifecycle, nested rollup, IDs, reload/tree/compact, context/throughput and unknown-cost checks passed");
} finally {
	await session.abort();
	session.dispose();
	rmSync(root, { recursive: true, force: true });
}
