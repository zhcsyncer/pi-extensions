import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { test, type TestContext } from "node:test";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { modules } from "./helpers/aggregate-reload-entry.ts";
import { AggregateTerminal } from "./helpers/aggregate-terminal.ts";

type Modules = typeof modules;
// Exercise the same virtualModules/tryNative:false loader shipped by the CLI, resolved
// from this package's SDK dependency. Query-string imports would NOT reload dependencies.
const sdk = await import(new URL("bundle/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as typeof import("@earendil-works/pi-coding-agent");

async function loader(t: TestContext) {
	const directory = mkdtempSync(join(tmpdir(), "aggregate-reload-"));
	const loaded: Modules[] = [];
	const snapshots: Array<{ prototype: object; descriptors: PropertyDescriptorMap }> = [];
	t.after(() => {
		for (const m of loaded.toReversed()) {
			m.thinking.restoreAggregateThinkingPlaceholders();
			m.activity.restoreAggregateToolExecutions();
		}
		// A failed takeover test must not poison the next case with disabled outer wrappers.
		for (const { prototype, descriptors } of snapshots) {
			for (const key of Reflect.ownKeys(prototype)) if (!(key in descriptors)) Reflect.deleteProperty(prototype, key);
			Object.defineProperties(prototype, descriptors);
		}
		rmSync(directory, { recursive: true, force: true });
	});
	return async () => {
		const bus = sdk.createEventBus();
		let result: Modules | undefined;
		bus.on("aggregate-reload-test:modules", (value) => { result = value as Modules; });
		const loadedExtension = await sdk.discoverAndLoadExtensions(
			[fileURLToPath(new URL("./helpers/aggregate-reload-entry.ts", import.meta.url))], directory, directory, bus,
		);
		assert.deepEqual(loadedExtension.errors, []);
		assert.ok(result, "the native loader must execute the fixture factory");
		if (loaded.length === 0) {
			for (const prototype of [result.Tui.TuiAltScreen.prototype, sdk.ToolExecutionComponent.prototype,
				sdk.AssistantMessageComponent.prototype, sdk.InteractiveMode.prototype]) {
				snapshots.push({ prototype, descriptors: Object.getOwnPropertyDescriptors(prototype) });
			}
			sdk.initTheme("dark", false);
		} else {
			assert.equal(result.Tui.TuiAltScreen, loaded[0].Tui.TuiAltScreen, "reload must share the host TUI class");
			assert.notEqual(result.activity.AggregateProjection, loaded[0].activity.AggregateProjection);
			assert.notEqual(result.viewport.patchAggregateViewport, loaded[0].viewport.patchAggregateViewport);
			assert.notEqual(result.thinking.patchAggregateThinkingPlaceholders, loaded[0].thinking.patchAggregateThinkingPlaceholders);
		}
		loaded.push(result);
		return result;
	};
}

function transcript(id: string) {
	const calls = [0, 1].map((n) => ({ id: `${id}-${n}`, name: "read", arguments: { path: `${id}-${n}.ts` } }));
	const messages = calls.map((call, n) => ({ role: "assistant", id: `${id}-message-${n}`, stopReason: "toolUse", content: [
		...(n === 0 ? [{ type: "text", text: Array.from({ length: 45 }, (_, row) => `${id} narration ${row}`).join("\n") }] : []),
		{ type: "toolCall", ...call },
	] }));
	const branch: unknown[] = [{ type: "message", id: `${id}-user`, message: { role: "user", content: id } }];
	for (const [n, message] of messages.entries()) {
		branch.push({ type: "message", id: `${id}-assistant-${n}`, message }, { type: "message", id: `${id}-result-${n}`,
			message: { role: "toolResult", toolCallId: calls[n].id, toolName: "read", content: [{ type: "text", text: "ok" }] } });
	}
	branch.push({ type: "message", id: `${id}-final`, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });
	return { id, calls, messages, branch };
}

function lifecycle(m: Modules, ctx: ExtensionContext) {
	const handlers = new Map<string, Array<(event: any, ctx: ExtensionContext) => unknown>>();
	const pi = { on(event: string, handler: (event: any, ctx: ExtensionContext) => unknown) {
		handlers.set(event, [...(handlers.get(event) ?? []), handler]);
	} } as ExtensionAPI;
	const projection = new m.activity.AggregateProjection(() => false, () => "turns");
	m.activity.registerAggregateProjectionEvents(pi, projection);
	m.thinking.registerAggregateThinkingPlaceholderSuppression(pi, () => true);
	return { projection, async emit(name: string, reason?: string) {
		for (const handler of handlers.get(name) ?? []) await handler({ type: name, reason }, ctx);
	} };
}
function headless(data?: ReturnType<typeof transcript>): ExtensionContext {
	const branch = data?.branch ?? [];
	return { hasUI: false, mode: "print", sessionManager: { getBranch: () => branch,
		buildSessionContext: () => ({ messages: branch.map((entry: any) => entry.message) }) } } as unknown as ExtensionContext;
}

function host(t: TestContext, m: Modules) {
	const T = m.Tui;
	const terminal = new AggregateTerminal(); terminal.columns = 90; terminal.rows = 24;
	const renderer = new T.TuiAltScreen(terminal, false, undefined, { mouse: true, copyOnSelect: false });
	const document = new T.Container();
	const scroll = new T.ScrollView(document, { primary: true, follow: "end", scrollbar: "always" });
	const widgets = new T.Container();
	const editor = new T.Input();
	renderer.setLayoutRoot(new T.VStack([
		{ component: new T.Text("host", 0, 0), basis: 1, shrink: 0 },
		{ component: scroll, basis: 0, grow: 1, minSize: 1 },
		{ component: widgets, shrink: 0 },
		{ component: editor, basis: 1, shrink: 0 },
	]));
	renderer.setFocus(editor);
	const theme = { fg: (_color: string, text: string) => text };
	const context = (data: ReturnType<typeof transcript>) => ({ hasUI: true, mode: "tui", ui: {
		theme,
		setWidget(_key: string, factory: ((tui: typeof renderer, theme: any) => TuiComponent) | undefined) {
			widgets.clear();
			if (factory) { widgets.addChild(new T.Spacer(1)); widgets.addChild(factory(renderer, theme)); }
			renderer.requestRender();
		},
	}, sessionManager: { getBranch: () => data.branch,
		buildSessionContext: () => ({ messages: data.branch.map((entry: any) => entry.message) }) } }) as unknown as ExtensionContext;
	const paint = () => { renderer.renderNow(); renderer.renderNow(); };
	const screen = () => (renderer as unknown as { previousScreen: string[] }).previousScreen.map(T.stripTerminalSequences);
	const populate = (data: ReturnType<typeof transcript>) => {
		document.clear(); document.addChild(new T.Spacer(30));
		for (const [n, message] of data.messages.entries()) {
			document.addChild(new sdk.AssistantMessageComponent(message as never, true));
			const call = data.calls[n];
			const tool = new sdk.ToolExecutionComponent(call.name, call.id, call.arguments, {}, {
				name: "read", label: "read", description: "read", parameters: { type: "object", properties: {} },
				execute() { throw new Error("rendering must never execute a tool"); },
				renderCall: () => new T.Text("native call", 0, 0), renderResult: () => new T.Text("native result", 0, 0),
			} as never, renderer, process.cwd());
			tool.updateResult({ content: [{ type: "text", text: "ok" }] } as never);
			document.addChild(tool);
		}
		document.addChild(new T.Text("final answer", 0, 0));
		scroll.scrollToEnd(); paint();
	};
	renderer.start(); paint();
	t.after(() => renderer.stop({ preserveScreen: true }));
	return { renderer, terminal, scroll, editor, context, paint, screen, populate };
}
type TuiComponent = import("@earendil-works/pi-tui").Component;

/** Real tool/assistant renders record metadata; no hand-written region or fake layout. */
function exercise(t: TestContext, f: ReturnType<typeof host>, m: Modules, p: InstanceType<Modules["activity"]["AggregateProjection"]>, data: ReturnType<typeof transcript>) {
	let control: import("../src/aggregate-viewport.ts").AggregateViewportControl | undefined;
	const unsubscribe = m.viewport.subscribeAggregateViewportControl(p, (next) => { control = next; });
	t.after(unsubscribe);
	f.populate(data);
	const label = p.getViewportRun(data.calls[0].id)!.label().replace(/\)$/, "");
	const title = f.screen().findIndex((line) => line.includes(label));
	assert.ok(title >= 0, `collapsed tool receipt must be visible: ${f.screen().join("\n")}`);
	assert.equal(f.scroll.isFollowingEnd, true);
	f.terminal.click(5, title); f.renderer.renderNow();
	assert.equal(p.isItemExpanded(data.calls[0].id), true, "native tool click must address the new projection");
	assert.equal(f.screen().findIndex((line) => line.includes(label)), title, "first expanded paint must anchor the migrating title");
	assert.equal(f.scroll.isFollowingEnd, false);
	assert.ok(f.screen().some((line) => line.includes(`${data.id} narration`)), "title must migrate to the native assistant host");
	f.scroll.scrollBy(25); f.paint();
	assert.equal(control?.run, p.getViewportRun(data.calls[0].id), "the new module must publish its own control");
	const dock = f.screen().findIndex((line) => line.includes("Collapse"));
	assert.ok(dock >= 0, "fixed collapse widget must subscribe after reload/takeover");
	f.terminal.onInput?.("k");
	assert.ok(f.editor.getValue().endsWith("k"), "the dock must not capture keyboard focus");
	f.terminal.click(f.terminal.columns - 3, dock); f.paint();
	assert.equal(p.isItemExpanded(data.calls[0].id), false, "dock click must collapse the new projection");
	assert.equal(control, undefined);
	assert.ok(f.screen().some((line) => line.includes(label)));
	assert.ok(f.screen().every((line) => !line.includes("Collapse")));
}

test("registration and headless sessions never claim UI patches; a later same-module child cannot steal the host", async (t) => {
	const load = await loader(t); const A = await load();
	const before = [sdk.ToolExecutionComponent.prototype.render, sdk.AssistantMessageComponent.prototype.render,
		(A.Tui.TuiAltScreen.prototype as any).doRender];
	const child = lifecycle(A, headless());
	assert.equal(A.activity.getActiveAggregateProjection(), undefined, "registration must not claim the host");
	await child.emit("session_start", "startup"); await child.emit("before_agent_start");
	assert.deepEqual([sdk.ToolExecutionComponent.prototype.render, sdk.AssistantMessageComponent.prototype.render,
		(A.Tui.TuiAltScreen.prototype as any).doRender], before, "headless events must not install renderer hooks");
	const f = host(t, A); const data = transcript("host"); const ui = lifecycle(A, f.context(data));
	await ui.emit("session_start", "startup");
	const later = lifecycle(A, f.context(transcript("child")));
	await later.emit("session_start", "startup"); await later.emit("before_agent_start");
	assert.equal(A.activity.getActiveAggregateProjection(), ui.projection);
	exercise(t, f, A, ui.projection, data);
});

test("clean reload preserves native title migration and the fixed collapse widget", async (t) => {
	const load = await loader(t); const A = await load(); const f = host(t, A);
	const old = transcript("old"); const uiA = lifecycle(A, f.context(old)); await uiA.emit("session_start", "startup");
	exercise(t, f, A, uiA.projection, old);
	await uiA.emit("session_shutdown", "reload");
	const B = await load(); const data = transcript("reloaded"); const uiB = lifecycle(B, f.context(data));
	await uiB.emit("session_start", "reload");
	exercise(t, f, B, uiB.projection, data);
});

for (const reason of ["quit", "new", "resume", "fork", "still-live"] as const) {
	test(`headless child ${reason} does not retain host hooks across reload into a fresh module`, async (t) => {
		const load = await loader(t); const A = await load(); const f = host(t, A);
		const uiA = lifecycle(A, f.context(transcript("old"))); await uiA.emit("session_start", "startup");
		const childData = transcript("child"); const child = lifecycle(A, headless(childData));
		await child.emit("session_start", "startup");
		if (reason !== "still-live") {
			await child.emit("session_shutdown", reason);
			assert.equal(A.activity.resolveAggregateProjection(undefined, childData.calls[0].id), uiA.projection,
				"terminated child must release its ledger, not remain addressable by tool id");
		}
		await uiA.emit("session_shutdown", "reload");
		assert.equal(A.activity.getActiveAggregateProjection(), undefined);
		const B = await load(); const data = transcript("reloaded"); const uiB = lifecycle(B, f.context(data));
		await uiB.emit("session_start", "reload");
		// Delayed shutdown from an old runtime may arrive after the new host has bound.
		await child.emit("session_shutdown", "quit");
		exercise(t, f, B, uiB.projection, data);
	});
}

test("fresh module takes over active tool, assistant and viewport hooks through foreign wrappers and survives late old cleanup", async (t) => {
	const load = await loader(t); const A = await load(); const f = host(t, A);
	const uiA = lifecycle(A, f.context(transcript("old"))); await uiA.emit("session_start", "startup");
	exercise(t, f, A, uiA.projection, transcript("old"));
	const counts = [0, 0, 0];
	for (const [index, [prototype, key]] of [
		[sdk.ToolExecutionComponent.prototype, "render"], [sdk.AssistantMessageComponent.prototype, "render"],
		[A.Tui.TuiAltScreen.prototype, "doRender"],
	].entries()) {
		const original = (prototype as any)[key as string];
		(prototype as any)[key as string] = function (...args: unknown[]) { counts[index]++; return original.apply(this, args); };
	}
	const B = await load(); const data = transcript("new"); const uiB = lifecycle(B, f.context(data));
	await uiB.emit("session_start", "reload");
	exercise(t, f, B, uiB.projection, data);
	assert.ok(counts.every((count) => count > 0), "takeover must retain unrelated outer render wrappers");
	await uiA.emit("session_shutdown", "reload");
	A.thinking.restoreAggregateThinkingPlaceholders(); A.activity.restoreAggregateToolExecutions(); A.viewport.restoreAggregateViewport();
	const before = [...counts];
	exercise(t, f, B, uiB.projection, data);
	assert.ok(counts.every((count, index) => count > before[index]), "late old cleanup must preserve foreign wrappers and the new host");
});
