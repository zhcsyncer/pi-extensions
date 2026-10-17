import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { SessionManager, Theme, ModelRuntime, ModelRegistry, ExtensionRunner, createExtensionRuntime } from "@earendil-works/pi-coding-agent";
import type { Extension } from "@earendil-works/pi-coding-agent";
import { InMemoryCredentialStore, InMemoryModelsStore } from "@earendil-works/pi-ai";
import type { AssistantMessage, Usage } from "@earendil-works/pi-ai";
import { usageTotalsFromEntries, stateInputsFromContext } from "../runtime-snapshot.js";
import { resolvePiThemeStyles } from "../theme-adapter.js";
import { cloneConfig, createGitHarness, createRuntimeHarness, createRuntimeTestContext, invokeEditorFactory } from "./runtime-harness.js";
import { onlySegments, stripAnsi } from "./surface-test-harness.js";

function usage(cost: number, output = 20): Usage {
	return { input: 100, output, cacheRead: 30, cacheWrite: 40, totalTokens: 170 + output,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}
function assistant(cost = 0.01): AssistantMessage {
	return { role: "assistant", content: [{ type: "text", text: "done" }], api: "openai-completions",
		provider: "g1-offline", model: "g1-model", responseId: "same-response", usage: usage(cost), stopReason: "stop", timestamp: 1000 };
}
function closeCost(actual: number, expected: number): void {
	assert.ok(Math.abs(actual - expected) < 1e-10, `recorded cost ${actual}, expected ${expected}`);
}
function fixture() {
	const dir = mkdtempSync(join(tmpdir(), "glance-g1-"));
	const manager = SessionManager.create(dir, dir);
	manager.appendMessage({ role: "user", content: "offline contract", timestamp: 1 });
	return { manager, dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("SDK entries: assistant + outer rollup + independent usage, without nested double accounting", () => {
	const f = fixture();
	try {
		f.manager.appendMessage(assistant());
		f.manager.appendMessage({ role: "toolResult", toolCallId: "outer", toolName: "Agent",
			content: [{ type: "text", text: "child complete" }], isError: false, timestamp: 2,
			usage: usage(0.03), details: { nested: { usage: { cost: { total: 9 } } } } });
		f.manager.appendUsage("cache_warm", "g1-offline", "g1-model", usage(0.02));
		closeCost(usageTotalsFromEntries(f.manager.getEntries()).cost, 0.06);
	} finally { f.cleanup(); }
});

test("distinct durable IDs survive identical payloads/response IDs and disk reload", () => {
	const f = fixture();
	try {
		const message = assistant();
		const a = f.manager.appendMessage(message);
		const b = f.manager.appendMessage(message);
		const c = f.manager.appendUsage("future-kind", "g1-offline", "g1-model", usage(0.02));
		const d = f.manager.appendUsage("future-kind", "g1-offline", "g1-model", usage(0.02));
		assert.equal(new Set([a, b, c.id, d.id]).size, 4, "SDK fixture must have distinct entry identities");
		const reloaded = SessionManager.open(f.manager.getSessionFile()!, f.dir);
		assert.deepEqual(reloaded.getEntries().map(e => e.id), f.manager.getEntries().map(e => e.id));
		closeCost(usageTotalsFromEntries(reloaded.getEntries()).cost, 0.06);
	} finally { f.cleanup(); }
});

test("tree and compaction preserve all-session totals and count summary usage once", () => {
	const f = fixture();
	try {
		const root = f.manager.getLeafId()!;
		f.manager.appendMessage(assistant());
		f.manager.appendUsage("cache_warm", "g1-offline", "g1-model", usage(0.02));
		f.manager.branchWithSummary(root, "branch summary", undefined, false, usage(0.03));
		const kept = f.manager.appendMessage(assistant(0.04));
		f.manager.appendCompaction("compacted", kept, 1000, undefined, false, usage(0.05));
		assert.ok(f.manager.getBranch().length < f.manager.getEntries().length);
		const ctx = createRuntimeTestContext().ctx;
		ctx.sessionManager = f.manager;
		closeCost(stateInputsFromContext(ctx, "off").usage.cost, 0.15);
		closeCost(stateInputsFromContext(ctx, "off").usage.cost, 0.15);
	} finally { f.cleanup(); }
});

test("unknown usage kind contributes token buckets but never model context", () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant());
	const before = manager.buildSessionContext();
	manager.appendUsage("not-yet-known", "g1-offline", "g1-model", usage(0.02, 700));
	assert.deepEqual(manager.buildSessionContext(), before);
	const totals = usageTotalsFromEntries(manager.getEntries());
	assert.equal(totals.input, 200);
	assert.equal(totals.output, 720);
	assert.equal(totals.cacheRead, 60);
	assert.equal(totals.cacheWrite, 80);
	closeCost(totals.cost, 0.03);
});

// Use the existing surface fixture, not a replacement renderer or a state getter.
async function liveFixture(manager: SessionManager, segments: Parameters<typeof onlySegments>[1] = ["cost"], uiTheme?: unknown) {
	const config = cloneConfig();
	config.colorSource = "glance";
	onlySegments(config, segments);
	const ctxFixture = createRuntimeTestContext({ cwd: manager.getCwd(), invokeFooterFactory: false, uiTheme });
	let reads = 0;
	const observedManager = new Proxy(manager, {
		get(target, key) {
			if (key === "getEntries") return () => { reads++; return target.getEntries(); };
			const value = Reflect.get(target, key, target);
			return typeof value === "function" ? value.bind(target) : value;
		},
	});
	const timers = new Map<unknown, () => void>();
	const harness = createRuntimeHarness({ loadConfigSyncConfig: config, git: createGitHarness(),
		setTimeout: (callback) => {
			const handle = {} as ReturnType<typeof setTimeout>;
			timers.set(handle, callback);
			return handle;
		}, clearTimeout: handle => { timers.delete(handle); } });
	const flush = async () => {
		for (let i = 0; i < 10 && timers.size; i++) {
			const pending = [...timers.values()];
			timers.clear();
			for (const callback of pending) callback();
			await Promise.resolve();
		}
		assert.equal(timers.size, 0, "fixture must drain scheduled refreshes");
	};
	const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
		modelsStore: new InMemoryModelsStore(), modelsPath: null, refreshOnCreate: false, allowModelNetwork: false });
	const registry = new ModelRegistry(modelRuntime);
	// Exercise public runtime lifecycle through SDK dispatch/context, not the package index's registration.
	const extension: Extension = { path: "<inline:g1-contract>", resolvedPath: "<inline:g1-contract>",
		sourceInfo: { path: "<inline:g1-contract>", source: "inline", scope: "temporary", origin: "top-level" },
		handlers: new Map(), tools: new Map(), commands: new Map(), flags: new Map(), shortcuts: new Map(), messageRenderers: new Map() };
	for (const [event, handler] of [
		["session_start", harness.runtime.events.sessionStart],
		["agent_settled", harness.runtime.events.agentSettled],
		["session_shutdown", harness.runtime.events.sessionShutdown],
	] as const) {
		extension.handlers.set(event, [async (event, ctx) => handler(event, ctx as Parameters<typeof handler>[1])]);
	}
	const runner = new ExtensionRunner([extension], createExtensionRuntime(), manager.getCwd(), observedManager, registry);
	const errors: string[] = [];
	runner.onError(error => errors.push(error.error));
	runner.setUIContext(ctxFixture.ctx.ui, "tui");
	await runner.emit({ type: "session_start", reason: "startup" });
	assert.deepEqual(errors, [], "SDK lifecycle must not swallow fixture errors");
	const ctx = runner.createContext();
	const editor = invokeEditorFactory(ctxFixture, 0, () => {}) as { render(width: number): string[]; invalidate(): void };
	await flush();
	return { ...harness, ctx, editor, reads: () => reads, flush,
		settle: async () => {
			await runner.emit({ type: "agent_settled", aborted: false });
			await flush();
			assert.deepEqual(errors, [], "SDK settled handler must complete without errors");
		},
		render: (width = 120) => stripAnsi(editor.render(width).join("\n")),
		renderStyled: () => editor.render(120).join("\n"),
		close: async () => {
			await runner.emit({ type: "session_shutdown", reason: "quit" });
			assert.deepEqual(errors, [], "SDK shutdown handler must complete without errors");
		} };
}

test("live persisted IDs: repeated public boundaries and reload never double count", async () => {
	const f = fixture();
	let live: Awaited<ReturnType<typeof liveFixture>> | undefined;
	try {
		f.manager.appendMessage(assistant());
		live = await liveFixture(f.manager);
		const initial = live.render();
		assert.match(initial, /0\.01/, "positive control: actual editor exposes historical cost");
		const message = assistant();
		f.manager.appendMessage(message);
		await live.runtime.events.messageEnd({ message }, live.ctx);
		await live.runtime.events.turnEnd({}, live.ctx);
		assert.match(live.render(), /0\.02/, "same response ID, new persisted entry must count");
		await live.runtime.events.messageEnd({ message }, live.ctx);
		await live.runtime.events.turnEnd({}, live.ctx);
		await live.settle();
		assert.match(live.render(), /0\.02/, "repeat observation is not another charge");
		f.manager.appendMessage(message);
		await live.runtime.events.messageEnd({ message }, live.ctx);
		await live.runtime.events.turnEnd({}, live.ctx);
		assert.match(live.render(), /0\.03/, "another identical payload is a third charge");
		await live.runtime.events.sessionTree({}, live.ctx);
		await live.runtime.events.sessionCompact({}, live.ctx);
		assert.match(live.render(), /0\.03/);
		await live.close();
		live = await liveFixture(SessionManager.open(f.manager.getSessionFile()!, f.dir));
		assert.match(live.render(), /0\.03/, "reload agrees with live accounting");
	} finally { await live?.close(); f.cleanup(); }
});

test("persisted independent usage becomes visible at the SDK settled boundary", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant());
	const live = await liveFixture(manager);
	try {
		assert.match(live.render(), /0\.01/);
		manager.appendUsage("future-kind", "g1-offline", "g1-model", usage(0.02));
		await live.settle();
		assert.match(live.render(), /0\.03/, "settled syncs independent usage without opening settings");
		await live.settle();
		assert.match(live.render(), /0\.03/);
	} finally { await live.close(); }
});

for (const malformed of ["missing", "non-finite"] as const) {
	test(`${malformed} cost preserves the known subtotal and marks it incomplete`, () => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(assistant());
		manager.appendUsage("cache_warm", "g1-offline", "g1-model", usage(0));
		// The coordinator's new public declaration is optional on the pre-implementation baseline.
		type Totals = ReturnType<typeof usageTotalsFromEntries> & { costUnknown?: boolean };
		const known: Totals = usageTotalsFromEntries(manager.getEntries());
		closeCost(known.cost, 0.01);
		assert.notEqual(known.costUnknown, true, "explicit zero is known, not missing");
		const { cost: _cost, ...missing } = usage(0);
		manager.appendUsage("future-kind", "g1-offline", "g1-model",
			malformed === "missing" ? missing as Usage : usage(Number.NaN));
		const incomplete: Totals = usageTotalsFromEntries(manager.getEntries());
		closeCost(incomplete.cost, 0.01);
		assert.equal(incomplete.costUnknown, true);
	});
}

test("missing cost is visibly distinct from confirmed zero; known subtotal survives", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant());
	manager.appendUsage("cache_warm", "g1-offline", "g1-model", usage(0));
	const live = await liveFixture(manager);
	try {
		const known = live.render();
		assert.match(known, /0\.01/, "positive control: known cost visible before unknown entry");
		assert.doesNotMatch(known, /\?/, "confirmed zero must not mark the cost incomplete");
		const { cost: _cost, ...missing } = usage(0);
		// A malformed/legacy persisted payload is intentional; do not invent a private unknown flag.
		manager.appendUsage("future-kind", "g1-offline", "g1-model", missing as Usage);
		await live.runtime.events.turnEnd({}, live.ctx);
		await live.flush();
		const unknown = live.render();
		assert.match(unknown, /\?/, "incomplete recorded cost must show the public unknown marker");
		assert.match(unknown, /0\.01/, "known recorded subtotal must remain visible");
	} finally { await live.close(); }
});

test("repeated render and resize never rescan persisted history", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant());
	const live = await liveFixture(manager);
	try {
		assert.match(live.render(), /0\.01/);
		const reads = live.reads();
		for (const width of [80, 120, 160, 120]) {
			live.editor.invalidate();
			assert.match(live.render(width), /0\.01/);
		}
		assert.equal(live.reads(), reads, "render/resize must not re-read session history");
	} finally { await live.close(); }
});

test("independent usage does not become generation throughput or context", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant());
	const live = await liveFixture(manager, ["throughput"]);
	try {
		const before = live.render();
		const context = manager.buildSessionContext();
		assert.equal(context.messages.length, 1, "context control includes the actual assistant message");
		manager.appendUsage("cache_warm", "g1-offline", "g1-model", usage(0.02, 100_000));
		await live.settle();
		assert.equal(live.render(), before, "recorded usage is not a generated response");
		assert.deepEqual(manager.buildSessionContext(), context);
	} finally { await live.close(); }
});

function sdkTheme(appearance: "dark" | "light", name = "system"): Theme {
	const fgTokens = "accent border borderAccent borderMuted success error warning muted dim text thinkingText userMessageText customMessageText customMessageLabel toolTitle toolOutput mdHeading mdLink mdLinkUrl mdCode mdCodeBlock mdCodeBlockBorder mdQuote mdQuoteBorder mdHr mdListBullet toolDiffAdded toolDiffRemoved toolDiffContext syntaxComment syntaxKeyword syntaxFunction syntaxVariable syntaxString syntaxNumber syntaxType syntaxOperator syntaxPunctuation thinkingOff thinkingMinimal thinkingLow thinkingMedium thinkingHigh thinkingXhigh bashMode".split(" ");
	const bgTokens = "selectedBg userMessageBg customMessageBg toolPendingBg toolSuccessBg toolErrorBg".split(" ");
	const colors = <T>(tokens: string[], color: string) => Object.fromEntries(tokens.map(t => [t, color])) as T;
	return new Theme(
		colors<ConstructorParameters<typeof Theme>[0]>(fgTokens, appearance === "dark" ? "#eeeeee" : "#111111"),
		colors<ConstructorParameters<typeof Theme>[1]>(bgTokens, appearance === "dark" ? "#111111" : "#eeeeee"),
		"truecolor", { name, appearance });
}

test("editor appearance overrides name while missing appearance preserves name fallback", async () => {
	const sdk = sdkTheme("dark");
	const live: Array<Awaited<ReturnType<typeof liveFixture>>> = [];
	const paint = async (name: string, appearance?: "dark" | "light") => {
		const manager = SessionManager.inMemory();
		manager.appendMessage(assistant());
		const theme = { name, ...(appearance ? { appearance } : {}), fg: sdk.fg.bind(sdk),
			bold: sdk.bold.bind(sdk), getColorMode: sdk.getColorMode.bind(sdk) };
		const f = await liveFixture(manager, ["cost"], theme);
		live.push(f);
		return f.renderStyled();
	};
	try {
		const light = await paint("light", "light");
		const dark = await paint("dark", "dark");
		assert.notEqual(light, dark, "positive control: chosen palettes visibly differ");
		assert.equal(await paint("light"), light, "missing appearance retains light-name fallback");
		assert.equal(await paint("dark"), dark, "missing appearance retains dark-name fallback");
		assert.equal(await paint("dark", "light"), light, "explicit light appearance overrides dark name");
		assert.equal(await paint("light", "dark"), dark, "explicit dark appearance overrides light name");
	} finally { for (const f of live) await f.close(); }
});

test("same-object appearance switch repaints the real editor without history rescanning", async () => {
	const manager = SessionManager.inMemory();
	manager.appendMessage(assistant());
	const sdk = sdkTheme("dark");
	// Keep name and all foreground functions fixed: only the public appearance changes.
	const theme = { name: "system", appearance: "dark" as "dark" | "light",
		fg: sdk.fg.bind(sdk), bold: sdk.bold.bind(sdk), getColorMode: sdk.getColorMode.bind(sdk) };
	const live = await liveFixture(manager, ["cost"], theme);
	try {
		const before = live.renderStyled();
		assert.match(stripAnsi(before), /0\.01/);
		const reads = live.reads();
		theme.appearance = "light";
		live.editor.invalidate();
		const after = live.renderStyled();
		assert.notEqual(after, before, "appearance alone must change actual visible chrome");
		assert.equal(stripAnsi(after), stripAnsi(before), "theme switch must preserve visible facts");
		assert.equal(live.reads(), reads, "theme repaint must not reread history");
		theme.appearance = "dark";
		live.editor.invalidate();
		assert.equal(live.renderStyled(), before);
	} finally { await live.close(); }
});

test("same-name, same-object SDK theme switch refreshes actual cached style output", () => {
	const dark = sdkTheme("dark");
	const light = sdkTheme("light");
	let active = dark;
	const host = { name: "system", get appearance() { return active.appearance; },
		getColorMode: () => active.getColorMode(), fg: (token: Parameters<typeof dark.fg>[0], text: string) => active.fg(token, text),
		bold: (text: string) => active.bold(text) };
	const sample = (styles: ReturnType<typeof resolvePiThemeStyles>) => [styles.text("sample"), styles.border("sample"), styles.dim("sample")];
	const before = sample(resolvePiThemeStyles(host));
	active = light;
	const after = sample(resolvePiThemeStyles(host));
	assert.notDeepEqual(after, before, "same-name appearance change must affect actual styles, not only metadata");
	assert.deepEqual(after, sample(resolvePiThemeStyles({ ...host, name: "fresh-light-control" })), "cached result agrees with fresh resolution");
	active = dark;
	assert.deepEqual(sample(resolvePiThemeStyles(host)), before);
});
