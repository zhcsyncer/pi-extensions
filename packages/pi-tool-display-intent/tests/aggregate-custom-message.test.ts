import assert from "node:assert/strict";
import { test, type TestContext } from "node:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	CustomMessageComponent, InteractiveMode, getMarkdownTheme, initTheme, sessionEntryToContextMessages,
} from "@earendil-works/pi-coding-agent";
import { Container, stripTerminalSequences, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AggregateProjection, aggregateAssistantFrameId, patchAggregateToolExecutions, restoreAggregateToolExecutions } from "../src/aggregate-activity.ts";
import { bindExistingAggregateCustomMessages, patchAggregateCustomMessages, restoreAggregateCustomMessages } from "../src/aggregate-custom-message.ts";

const custom = (content: string, display = true) => ({ role: "custom", customType: "card", content, display, timestamp: 1 });
const customEntry = (id: string, content: string, display = true) => ({
	type: "custom_message", id, customType: "card", content, display, timestamp: "2026-01-01T00:00:00.000Z",
});
const entry = (id: string, message: unknown) => ({ type: "message", id, message });
const assistant = (id: string, content: unknown[], stopReason = "toolUse") => ({ role: "assistant", id, content, stopReason });
const clean = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
function pointer(x: number, y: number, height: number, width = 80): TuiMouseEvent {
	return { type: "click", button: "left", x, y, screenX: 100 + x, screenY: 200 + y,
		width, height, shift: false, alt: false, ctrl: false };
}

function fixture(t: TestContext, renderer?: (...args: any[]) => any) {
	initTheme("dark", false);
	const projection = new AggregateProjection();
	projection.rebuild([]);
	projection.setRenderTheme({ fg: (_color, text) => text, bold: (text) => text });
	patchAggregateToolExecutions(projection);
	patchAggregateCustomMessages();
	t.after(() => { restoreAggregateCustomMessages(); restoreAggregateToolExecutions(); });
	let requests = 0;
	// Real native replay/add methods construct the actual SDK components. Only
	// their application services are supplied; no renderer output is substituted.
	const mode = Object.create(InteractiveMode.prototype, Object.getOwnPropertyDescriptors({
		chatContainer: new Container(), pendingTools: new Map(), toolOutputExpanded: false,
		outputPad: 0, hideThinkingBlock: true, hiddenThinkingLabel: "Thinking...",
		ui: { requestRender() { requests++; } },
		session: { extensionRunner: { getMessageRenderer: () => renderer, getEntryRenderer: () => undefined } },
		sessionManager: { getEntries: () => [], getCwd: () => process.cwd() },
		settingsManager: { getShowCacheMissNotices: () => false, getShowImages: () => false, getImageWidthCells: () => 40 },
		getMarkdownThemeWithSettings: () => getMarkdownTheme(), getMarkdownTransformers: () => [],
		getRegisteredToolDefinition: () => undefined,
	}));
	const cards = () => mode.chatContainer.children.filter((child: object) => child instanceof CustomMessageComponent) as CustomMessageComponent[];
	const id = (card: CustomMessageComponent) => projection.getCustomMessageItemId((card as any).message)!;
	return { projection, mode, cards, id, requests: () => requests };
}

test("native replay consumes hidden slots and preserves duplicate occurrence identity", (t) => {
	const f = fixture(t);
	f.mode.renderSessionEntries([customEntry("a", "same"), customEntry("hidden", "secret", false), customEntry("b", "same")]);
	const cards = f.cards();
	assert.equal(cards.length, 2);
	assert.ok(f.id(cards[0]));
	assert.notEqual(f.id(cards[0]), f.id(cards[1]));
	assert.deepEqual(cards[0].render(80), [], "only the latest eligible occurrence hosts the collapsed run");
	assert.match(clean(cards[1].render(80)), /Run/);
	assert.doesNotMatch(clean(f.mode.chatContainer.render(80)), /secret/);
	f.projection.toggleGroupExpansion(f.id(cards[1]));
	assert.match(clean(cards[0].render(80)), /same/);
	assert.match(clean(cards[1].render(80)), /same/);
});

test("idle native add path ingests custom-only runs without extension message events", (t) => {
	const f = fixture(t);
	const hidden = custom("secret", false);
	f.mode.addMessageToChat(hidden);
	assert.equal(f.projection.getCustomMessageItemId(hidden), undefined);
	assert.equal(f.cards().length, 0);
	const message = custom("idle notification");
	f.mode.addMessageToChat(message);
	const id = f.projection.getCustomMessageItemId(message);
	assert.ok(id);
	assert.equal(f.projection.ingestCustomMessage(message), id, "same live object is idempotent");
	assert.equal((f.cards()[0] as any).message, message, "native constructor retains the original message");
	assert.match(clean(f.cards()[0].render(80)), /Run/);
	assert.equal(f.projection.getView(id)?.callCount, 0);
});

test("native replay keeps custom and tool order and starts a notification segment after the final answer", (t) => {
	const f = fixture(t);
	f.mode.renderSessionEntries([
		entry("user", { role: "user", content: "request", timestamp: 1 }),
		customEntry("before", "before call"),
		entry("assistant", assistant("a", [{ type: "toolCall", id: "read", name: "read", arguments: { path: "a.ts" } }])),
		entry("result", { role: "toolResult", toolName: "read", toolCallId: "read", content: [{ type: "text", text: "ok" }] }),
		customEntry("after", "after call"),
		entry("final", assistant("final", [{ type: "text", text: "final answer" }], "stop")),
		customEntry("notification", "later notification"),
	]);
	const [before, after, notification] = f.cards();
	assert.equal(f.projection.getViewportRun(f.id(before)), f.projection.getViewportRun("read"));
	assert.equal(f.projection.getViewportRun(f.id(after)), f.projection.getViewportRun("read"));
	assert.notEqual(f.projection.getViewportRun(f.id(notification)), f.projection.getViewportRun("read"));
	assert.deepEqual(f.projection.getFramedItemIds(f.id(before)).filter((id) => [f.id(before), "read", f.id(after)].includes(id)),
		[f.id(before), "read", f.id(after)]);
	f.projection.toggleGroupExpansion(f.id(before));
	f.projection.toggleGroupExpansion(f.id(notification));
	const text = clean(f.mode.chatContainer.render(80));
	assert.ok(text.indexOf("before call") < text.indexOf("Read(a.ts)"));
	assert.ok(text.indexOf("Read(a.ts)") < text.indexOf("after call"));
	assert.ok(text.indexOf("after call") < text.indexOf("final answer"));
	assert.ok(text.indexOf("final answer") < text.indexOf("later notification"));
});

test("Run toggles preserve the native component state, global options and real child mouse targets", (t) => {
	let builds = 0;
	let clicks = 0;
	let lastEvent: TuiMouseEvent | undefined;
	const native = {
		render: (_width: number) => [`native card ${clicks}`], invalidate() {}, handleInput(_data: string) {},
		handleMouse(event: TuiMouseEvent) {
			lastEvent = event; clicks++;
			return { handled: true, focus: true, capture: true };
		},
	};
	const options: boolean[] = [];
	const f = fixture(t, (_message, option) => { builds++; options.push(option.expanded); return native; });
	f.mode.addMessageToChat(custom("interactive"));
	const card = f.cards()[0];
	const id = f.id(card);
	let lines = f.mode.chatContainer.render(80);
	assert.match(clean(lines), /Run/);
	const requests = f.requests();
	f.mode.chatContainer.handleMouse(pointer(10, 1, lines.length));
	assert.equal(f.projection.isItemExpanded(id), true);
	assert.ok(f.requests() > requests, "the frame invalidator requests a real mode render");
	lines = f.mode.chatContainer.render(80);
	const row = lines.findIndex((line: string) => line.includes("native card"));
	assert.ok(row > 1);
	const result = f.mode.chatContainer.handleMouse(pointer(7, row, lines.length));
	assert.equal(clicks, 1);
	assert.equal(result?.capture, true);
	assert.equal(result?.focusTarget, native);
	assert.equal((result as any)?.target.component, native);
	assert.equal((result as any)?.target.originX, 104);
	assert.equal((result as any)?.target.originY, 200 + row);
	assert.equal(lastEvent?.x, 3);
	assert.equal(lastEvent?.y, 0);
	assert.equal(lastEvent?.width, 76);
	assert.equal(lastEvent?.screenX, 107);
	assert.equal(f.projection.isItemExpanded(id), true, "body clicks never toggle the run");
	f.projection.toggleGroupExpansion(id);
	lines = f.mode.chatContainer.render(80);
	assert.equal(card.handleMouse(pointer(7, row, lines.length)), undefined, "folding removes native hit regions");
	f.projection.toggleGroupExpansion(id);
	assert.match(clean(f.mode.chatContainer.render(80)), /native card 1/);
	assert.equal(builds, 1, "Run toggles must not rebuild the native component");
	assert.deepEqual(options, [false], "Run expansion does not overwrite native global expansion");
});

test("an empty native renderer cannot paint a phantom frame", (t) => {
	const f = fixture(t, () => ({ render: () => [], invalidate() {} }));
	f.mode.addMessageToChat(custom("empty"));
	const card = f.cards()[0];
	assert.deepEqual(card.render(80), []);
	f.projection.toggleGroupExpansion(f.id(card));
	assert.deepEqual(card.render(80), []);
	assert.equal(card.handleMouse(pointer(4, 0, 1)), undefined);
});

test("missing renderer uses the original SDK fallback body", (t) => {
	const f = fixture(t);
	f.mode.addMessageToChat(custom("fallback text"));
	const card = f.cards()[0];
	f.projection.toggleGroupExpansion(f.id(card));
	assert.match(clean(card.render(80)), /\[card\]/);
	assert.match(clean(card.render(80)), /fallback text/);
});

test("a mismatched replay falls back native instead of ingesting into the active run", (t) => {
	const f = fixture(t);
	const original = f.projection.prepareCustomReplay.bind(f.projection);
	f.projection.prepareCustomReplay = (entries) => { original(entries); return []; };
	let ingestions = 0;
	const ingest = f.projection.ingestCustomMessage.bind(f.projection);
	f.projection.ingestCustomMessage = (message, restoredId) => {
		if (restoredId === undefined) ingestions++;
		return ingest(message, restoredId);
	};
	f.mode.renderSessionEntries([customEntry("a", "unmatched")]);
	assert.equal(ingestions, 0);
	assert.match(clean(f.cards()[0].render(80)), /unmatched/);
	assert.doesNotMatch(clean(f.cards()[0].render(80)), /Run/);
	f.mode.addMessageToChat(custom("live afterwards"));
	assert.equal(ingestions, 1, "replay scope is cleared before subsequent live delivery");
});

test("message-only runs count occurrences without inventing successful calls or model turns", (t) => {
	const f = fixture(t);
	f.mode.addMessageToChat(custom("one"));
	f.mode.addMessageToChat(custom("two"));
	const last = f.cards()[1];
	const view = f.projection.getView(f.id(last))!;
	assert.equal(view.callCount, 0);
	assert.equal(view.agentTurnCount, 0);
	assert.equal(view.customMessageCount, 2);
	assert.equal(view.usage, undefined);
	assert.match(clean(last.render(80)), /• Run \(2 messages\)/);
	assert.doesNotMatch(clean(last.render(80)), /✓|0 calls|1 turn/);
});

test("custom-first expansion and original message bindings survive the first tool and an append-only history rebuild", (t) => {
	const f = fixture(t);
	const request = entry("u", { role: "user", content: "request", timestamp: 1 });
	f.projection.rebuild([request]);
	const message = custom("first notice");
	f.mode.addMessageToChat(message);
	const id = f.projection.getCustomMessageItemId(message)!;
	f.projection.toggleGroupExpansion(id);
	const tool = assistant("a", [{ type: "toolCall", id: "read", name: "read", arguments: { path: "a.ts" } }]);
	f.projection.ingestAssistantMessage(tool);
	assert.equal(f.projection.isItemExpanded("read"), true);
	f.projection.rebuild([request, customEntry("c", "first notice"), entry("a", tool)]);
	assert.equal(f.projection.getCustomMessageItemId(message), id);
	assert.equal(f.projection.isItemExpanded("read"), true);
	assert.match(clean(f.cards()[0].render(80)), /first notice/);
});

test("compaction replays only its retained messages and does not reuse a removed notification's expansion", (t) => {
	const f = fixture(t);
	f.mode.renderSessionEntries([customEntry("old", "removed notice")]);
	const oldRun = f.projection.getViewportRun(f.id(f.cards()[0]))!;
	f.projection.toggleGroupExpansion(f.id(f.cards()[0]));
	f.mode.chatContainer.clear();
	const retained = Object.freeze(custom("retained notice"));
	const checkpoint = Object.freeze({ type: "compaction", id: "checkpoint", summary: "context summary",
		tokensBefore: 1000, timestamp: "2026-01-01T00:00:00.000Z", retainedTail: [retained, custom("hidden", false)] });
	const original = JSON.stringify(checkpoint);
	// Older supported hosts keep explicit entries; newer hosts materialize the tail.
	const retainedSupported = sessionEntryToContextMessages(checkpoint as never).some((message) => message.role === "custom");
	f.mode.renderSessionEntries(retainedSupported ? [checkpoint] : [
		{ ...checkpoint, retainedTail: undefined }, customEntry("kept", "retained notice"), customEntry("hidden", "hidden", false),
	]);
	assert.equal(oldRun.isValid(), false);
	assert.equal(f.cards().length, 1);
	const id = f.id(f.cards()[0]);
	assert.equal(f.projection.isItemExpanded(id), false);
	assert.equal(f.projection.getView(id)?.customMessageCount, 1);
	f.projection.toggleGroupExpansion(id);
	const text = clean(f.mode.chatContainer.render(80));
	assert.match(text, /retained notice/);
	assert.doesNotMatch(text, /removed notice|hidden/);
	assert.equal(JSON.stringify(checkpoint), original);
});

test("compaction projection follows the installed host's actual retained-tail capability", (t) => {
	const f = fixture(t);
	f.mode.renderSessionEntries([{ type: "compaction", id: "checkpoint", summary: "summary", tokensBefore: 1000,
		timestamp: "2026-01-01T00:00:00.000Z", retainedTail: [custom("retained")] }]);
	assert.equal(f.projection.getCustomOccurrenceIds().length, f.cards().length);
});

test("session_start binds history already constructed while reload hooks were uninstalled", (t) => {
	const f = fixture(t);
	const entries = [customEntry("a", "same"), customEntry("hidden", "hidden", false), customEntry("b", "same")];
	restoreAggregateToolExecutions();
	f.mode.renderSessionEntries(entries);
	const before = [...f.cards()];
	assert.equal(before.length, 2);
	assert.match(clean(before[0].render(80)), /same/);
	assert.equal(f.id(before[0]), undefined);
	patchAggregateToolExecutions(f.projection);
	f.projection.rebuild(entries);
	const root = new Container(); root.addChild(f.mode.chatContainer);
	const bindings: unknown[] = [];
	bindExistingAggregateCustomMessages({ hasUI: true, ui: {
		setWidget(_key: string, factory: any) {
			bindings.push(factory);
			if (factory) factory(Object.assign(root, { requestRender() {} }));
		},
	} } as never, f.projection);
	assert.equal(bindings.at(-1), undefined, "the TUI capture leaves no widget mounted");
	assert.deepEqual(f.cards(), before, "bind original instances without reconstructing renderers");
	assert.notEqual(f.id(before[0]), f.id(before[1]));
	assert.deepEqual(before[0].render(80), []);
	assert.match(clean(before[1].render(80)), /Run \(2 messages\)/);
	f.projection.toggleGroupExpansion(f.id(before[1]));
	assert.match(clean(before[0].render(80)), /same/);
	assert.match(clean(before[1].render(80)), /same/);
});

test("an unsupported existing UI tree cannot hide the tool summary behind an unbound custom host", (t) => {
	const f = fixture(t);
	f.mode.renderSessionEntries([
		entry("a", assistant("a", [{ type: "toolCall", id: "read", name: "read", arguments: {} }])),
		customEntry("c", "keep native notice"),
	]);
	assert.equal(f.projection.getView("read"), undefined);
	bindExistingAggregateCustomMessages({ hasUI: true, ui: {
		setWidget(_key: string, factory: any) { if (factory) factory({ requestRender() {} }); },
	} } as never, f.projection);
	assert.ok(f.projection.getView("read"));
	assert.equal(f.projection.getView("read")?.customMessageCount, 0);
	assert.match(clean(f.cards()[0].render(80)), /keep native notice/);
});

test("another interactive UI and a viewer copy cannot take over the host message ledger", (t) => {
	const f = fixture(t);
	f.mode.addMessageToChat(custom("host notice"));
	const root = Object.assign(new Container(), { requestRender() {} });
	root.addChild(f.mode.chatContainer);
	f.mode.ui = root;
	bindExistingAggregateCustomMessages({ hasUI: true, ui: {
		setWidget(_key: string, factory: any) { if (factory) factory(root); },
	} } as never, f.projection);
	const ids = f.projection.getCustomOccurrenceIds();
	const other = Object.assign(Object.create(InteractiveMode.prototype, Object.getOwnPropertyDescriptors(f.mode)), {
		ui: { requestRender() {} }, chatContainer: new Container(), pendingTools: new Map(),
	});
	other.renderSessionEntries([customEntry("other", "other UI notice")]);
	assert.deepEqual(f.projection.getCustomOccurrenceIds(), ids);
	assert.match(clean(other.chatContainer.render(80)), /other UI notice/);
	assert.doesNotMatch(clean(other.chatContainer.render(80)), /Run/);
	const copy = new CustomMessageComponent((f.cards()[0] as any).message);
	assert.match(clean(copy.render(80)), /host notice/);
	assert.doesNotMatch(clean(copy.render(80)), /Run/);
	assert.match(clean(f.cards()[0].render(80)), /Run/);
});

test("a custom entry remains a separate native entry, not an aggregate message", (t) => {
	const f = fixture(t);
	f.mode.session.extensionRunner.getEntryRenderer = () => () => ({ render: () => ["native state card"], invalidate() {} });
	f.mode.renderSessionEntries([{ type: "custom", id: "state", customType: "card", data: { value: 1 } }]);
	assert.equal(f.cards().length, 0);
	const text = clean(f.mode.chatContainer.render(80));
	assert.match(text, /native state card/);
	assert.doesNotMatch(text, /Run/);
});

test("a notification arriving during assistant text cannot move the expanded header below that narration", (t) => {
	const f = fixture(t);
	const message = assistant("stream", [{ type: "text", text: "Earlier narration" }], "pending");
	f.projection.ingestAssistantMessage(message);
	f.mode.addMessageToChat(custom("notification during stream"));
	const notice = f.id(f.cards()[0]);
	message.content.push({ type: "toolCall", id: "later-tool", name: "read", arguments: { path: "a.ts" } });
	message.stopReason = "toolUse";
	f.projection.ingestAssistantMessage(message);
	const frame = aggregateAssistantFrameId(message)!;
	f.projection.markFrameContentVisible(frame, true);
	assert.deepEqual(f.projection.getFramedItemIds(notice), [frame, notice, "later-tool"]);
	assert.equal(f.projection.shouldHostExpandedSummary(frame), true);
});

test("a repeated final event cannot charge its turn to a later notification segment", (t) => {
	const f = fixture(t);
	const final = assistant("final", [{ type: "text", text: "Done" }], "stop");
	f.projection.ingestAssistantMessage(final);
	f.mode.addMessageToChat(custom("later one"));
	f.projection.finishContextTurn(final, []);
	f.mode.addMessageToChat(custom("later two"));
	const [one, two] = f.cards();
	assert.equal(f.projection.getViewportRun(f.id(one)), f.projection.getViewportRun(f.id(two)));
	assert.equal(f.projection.getView(f.id(two))?.agentTurnCount, 0);
	assert.equal(f.projection.getView(f.id(two))?.customMessageCount, 2);
});

test("normal restoration restores inherited render and mouse methods", (t) => {
	const renderDescriptor = Object.getOwnPropertyDescriptor(CustomMessageComponent.prototype, "render");
	const mouseDescriptor = Object.getOwnPropertyDescriptor(CustomMessageComponent.prototype, "handleMouse");
	const f = fixture(t);
	restoreAggregateCustomMessages();
	f.mode.addMessageToChat(custom("native after restore"));
	assert.deepEqual(Object.getOwnPropertyDescriptor(CustomMessageComponent.prototype, "render"), renderDescriptor);
	assert.deepEqual(Object.getOwnPropertyDescriptor(CustomMessageComponent.prototype, "handleMouse"), mouseDescriptor);
	assert.match(clean(f.cards()[0].render(80)), /native after restore/);
	assert.doesNotMatch(clean(f.cards()[0].render(80)), /Run/);
});

test("external wrappers survive cleanup and reinstallation without leaving live ingress disabled", (t) => {
	const baseline = Object.getOwnPropertyDescriptor(CustomMessageComponent.prototype, "render");
	const f = fixture(t);
	const inner = CustomMessageComponent.prototype.render;
	let calls = 0;
	const outer = function(this: CustomMessageComponent, width: number) { calls++; return inner.call(this, width); };
	CustomMessageComponent.prototype.render = outer;
	t.after(() => {
		CustomMessageComponent.prototype.render = inner;
		restoreAggregateCustomMessages();
		if (baseline) Object.defineProperty(CustomMessageComponent.prototype, "render", baseline);
		else Reflect.deleteProperty(CustomMessageComponent.prototype, "render");
	});
	restoreAggregateCustomMessages();
	patchAggregateCustomMessages();
	assert.equal(CustomMessageComponent.prototype.render, outer);
	f.mode.addMessageToChat(custom("wrapped"));
	assert.match(clean(f.cards()[0].render(80)), /Run/);
	assert.ok(calls > 0);
});

test("native replay releases its scope when rendering throws", (t) => {
	const f = fixture(t);
	f.mode.session.extensionRunner.getMessageRenderer = () => { throw new Error("renderer lookup failed"); };
	assert.throws(() => f.mode.renderSessionEntries([customEntry("a", "replay")]), /renderer lookup failed/);
	f.mode.session.extensionRunner.getMessageRenderer = () => undefined;
	const message = custom("live after failure");
	f.mode.addMessageToChat(message);
	assert.ok(f.projection.getCustomMessageItemId(message));
	assert.match(clean(f.cards()[0].render(80)), /Run/);
});

test("fresh native loader takes over through outer wrappers and ignores late old cleanup", async (t) => {
	const sdk = await import(new URL("bundle/index.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href) as typeof import("@earendil-works/pi-coding-agent");
	type Modules = {
		custom: typeof import("../src/aggregate-custom-message.ts");
		activity: typeof import("../src/aggregate-activity.ts");
		Tui: typeof import("@earendil-works/pi-tui");
	};
	const directory = mkdtempSync(join(tmpdir(), "aggregate-custom-reload-"));
	const path = join(directory, "entry.ts");
	writeFileSync(path, `import * as custom from ${JSON.stringify(fileURLToPath(new URL("../src/aggregate-custom-message.ts", import.meta.url)))};
import * as activity from ${JSON.stringify(fileURLToPath(new URL("../src/aggregate-activity.ts", import.meta.url)))};
import * as Tui from "@earendil-works/pi-tui";
export default function(pi) { pi.events.emit("custom-reload:modules", { custom, activity, Tui }); }
`);
	const loaded: Modules[] = [];
	const snapshots: Array<{ prototype: object; descriptors: PropertyDescriptorMap }> = [];
	t.after(() => {
		for (const module of loaded.toReversed()) {
			module.custom.restoreAggregateCustomMessages();
			module.activity.restoreAggregateToolExecutions();
		}
		for (const { prototype, descriptors } of snapshots) {
			for (const key of Reflect.ownKeys(prototype)) if (!(key in descriptors)) Reflect.deleteProperty(prototype, key);
			Object.defineProperties(prototype, descriptors);
		}
		rmSync(directory, { recursive: true, force: true });
	});
	const load = async () => {
		let result: Modules | undefined;
		const bus = sdk.createEventBus();
		bus.on("custom-reload:modules", (modules) => { result = modules as Modules; });
		const extension = await sdk.discoverAndLoadExtensions([path], directory, directory, bus);
		assert.deepEqual(extension.errors, []);
		assert.ok(result);
		if (loaded.length === 0) {
			for (const prototype of [sdk.CustomMessageComponent.prototype, sdk.InteractiveMode.prototype,
				sdk.ToolExecutionComponent.prototype, result.Tui.TuiAltScreen.prototype]) {
				snapshots.push({ prototype, descriptors: Object.getOwnPropertyDescriptors(prototype) });
			}
			sdk.initTheme("dark", false);
		} else assert.notEqual(result.custom.patchAggregateCustomMessages, loaded[0].custom.patchAggregateCustomMessages);
		loaded.push(result);
		return result;
	};
	const bind = (module: Modules) => {
		const projection = new module.activity.AggregateProjection();
		projection.rebuild([]);
		module.activity.patchAggregateToolExecutions(projection);
		module.custom.patchAggregateCustomMessages();
		return projection;
	};
	const A = await load(); bind(A);
	const original = sdk.CustomMessageComponent.prototype.render;
	let wraps = 0;
	const outer = function(this: CustomMessageComponent, width: number) { wraps++; return original.call(this, width); };
	sdk.CustomMessageComponent.prototype.render = outer;
	const originalMouse = sdk.CustomMessageComponent.prototype.handleMouse;
	let mouseWraps = 0;
	sdk.CustomMessageComponent.prototype.handleMouse = function(event) { mouseWraps++; return originalMouse.call(this, event); };
	const modePrototype = sdk.InteractiveMode.prototype as any;
	const originalAdd = modePrototype.addMessageToChat;
	let deliveries = 0;
	modePrototype.addMessageToChat = function(...args: unknown[]) { deliveries++; return originalAdd.apply(this, args); };
	const B = await load(); const projection = bind(B);
	const message = custom("new loader");
	const native = { render: () => ["new native body"], invalidate() {}, handleMouse: () => ({ handled: true, capture: true }) };
	const mode = Object.create(modePrototype, Object.getOwnPropertyDescriptors({
		chatContainer: new B.Tui.Container(), toolOutputExpanded: false, outputPad: 0,
		ui: { requestRender() {} }, getMarkdownThemeWithSettings: () => sdk.getMarkdownTheme(),
		session: { extensionRunner: { getMessageRenderer: () => () => native } },
	}));
	mode.addMessageToChat(message);
	const id = projection.getCustomMessageItemId(message)!;
	assert.ok(id);
	const component = mode.chatContainer.children[0] as CustomMessageComponent;
	assert.match(clean(component.render(80)), /Run/);
	A.custom.restoreAggregateCustomMessages(); A.activity.restoreAggregateToolExecutions();
	A.custom.patchAggregateCustomMessages();
	assert.equal(sdk.CustomMessageComponent.prototype.render, outer);
	projection.toggleGroupExpansion(id);
	const lines = component.render(80);
	const row = lines.findIndex((line) => line.includes("new native body"));
	assert.ok(row >= 0);
	const result = component.handleMouse(pointer(6, row, lines.length));
	assert.equal(result?.capture, true);
	assert.equal((result as any)?.target.component, native);
	assert.ok(wraps >= 2);
	assert.equal(mouseWraps, 1);
	mode.addMessageToChat(custom("after old cleanup"));
	assert.equal(deliveries, 2);
	assert.ok(projection.getCustomMessageItemId((mode.chatContainer.children[1] as any).message));
});
