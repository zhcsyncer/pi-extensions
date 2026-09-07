import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, InteractiveMode, ToolExecutionComponent, UserMessageComponent, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Text, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AggregateProjection, patchAggregateToolExecutions, restoreAggregateToolExecutions } from "../src/aggregate-activity.ts";
import { patchAggregateThinkingPlaceholders, restoreAggregateThinkingPlaceholders } from "../src/aggregate-thinking-placeholder.ts";
import registerNativeUserMessageBox from "../src/user-message-box-native.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";
import type { DetailRequest } from "../src/detail-viewer.ts";

const plain = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const clean = (line: string) => line.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");
const entry = (id: string, message: unknown) => ({ type: "message", id, message });
const user = (id: string, content: string, timestamp: number) => entry(id, { role: "user", content, timestamp });
const result = (id: string, name: string) => ({ role: "toolResult", toolCallId: id, toolName: name, isError: false, content: [{ type: "text", text: `PRIVATE OUTPUT ${id}` }] });
const assistant = (id: string, name: string, text?: string) => ({
	role: "assistant", id: `assistant-${id}`, stopReason: "toolUse",
	usage: { input: 100, output: 20, cacheRead: 0, cacheWrite: 0 }, content: [
		...(text ? [{ type: "text", text }] : []),
		{ type: "toolCall", id, name, arguments: { path: `${id}.ts` } },
	],
});
const final = (id: string) => entry(`final-${id}`, { role: "assistant", id: `final-${id}`, stopReason: "stop", content: [{ type: "text", text: "Done" }] });
function click(x: number, y: number, height: number, extras: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return { type: "click", button: "left", x, y, screenX: x, screenY: y, width: 100, height, shift: false, alt: false, ctrl: false, ...extras };
}
function tool(name: string, id: string, shell: "self" | "default" = "default") {
	const component = new ToolExecutionComponent(name, id, { path: `${id}.ts` }, {}, {
		name, label: name, description: name, parameters: { type: "object", properties: {} }, renderShell: shell,
		execute: () => { throw new Error("Viewing must not execute a tool"); },
		renderCall: () => new Text(`NATIVE ${id}`, 0, 0),
		renderResult: () => new Text(`NATIVE RESULT ${id}`, 0, 0),
	} as never, { requestRender() {} } as never, process.cwd());
	component.updateResult(result(id, name) as never);
	component.setExpanded(false);
	return component;
}
function setup(shell: "self" | "default" = "default", narration = false) {
	initTheme("dark", false);
	const p = new AggregateProjection((name) => name === "Agent", () => "turns");
	p.setRenderTheme(plain);
	const a = assistant("a", "read", narration ? "First narration" : undefined);
	const b = assistant("b", "bash");
	const c = assistant("c", "read");
	const branch = [user("u1", "first request", 1), entry("a", a), entry("ra", result("a", "read")), entry("b", b), entry("rb", result("b", "bash")), final("u1"), user("u2", "next request", 2), entry("c", c), entry("rc", result("c", "read")), final("u2")];
	p.rebuild(branch);
	patchAggregateToolExecutions(p);
	patchAggregateThinkingPlaceholders(() => true);
	const root = new Container();
	const note = new AssistantMessageComponent(a as never, true);
	if (narration) root.addChild(note);
	const first = tool("read", "a", shell);
	const second = tool("bash", "b", shell);
	const other = tool("read", "c", shell);
	root.addChild(first); root.addChild(second); root.addChild(other);
	const opened: DetailRequest[] = [];
	p.setDetailOpener(async (request) => { opened.push(request); });
	return { p, root, note, first, second, other, opened, branch };
}
function restore() { restoreAggregateThinkingPlaceholders(); restoreAggregateToolExecutions(); }

for (const shell of ["self", "default"] as const) {
	test(`${shell} shell: full title row toggles the whole run through Pi's actual mouse dispatch`, () => {
		const { p, root, first, branch } = setup(shell);
		try {
			let lines = root.render(100);
			assert.equal(root.handleMouse(click(95, 0, lines.length)), undefined, "top spacing is not a click target");
			assert.equal(root.handleMouse(click(95, 1, lines.length))?.handled, true, "trailing title whitespace is clickable");
			assert.equal(p.isItemExpanded("a"), true);
			assert.equal(p.isItemExpanded("b"), true);
			assert.equal(p.isItemExpanded("c"), false);
			lines = root.render(100);
			assert.match(clean(lines.join("\n")), /Read\(a.ts\)/);
			assert.match(clean(lines.join("\n")), /Bash/);
			assert.doesNotMatch(lines.join("\n"), /PRIVATE OUTPUT|NATIVE RESULT/);
			p.rebuild(branch);
			assert.equal(p.isItemExpanded("a"), true, "local choice survives a same-branch rebuild");
			lines = root.render(100);
			assert.equal(root.handleMouse(click(95, 1, lines.length))?.handled, true);
			assert.equal(p.isItemExpanded("a"), false);
			assert.deepEqual(first.render(100), []);
		} finally { restore(); }
	});
}

test("collapsed receipts and expanded summary areas toggle the run without opening details", () => {
	const { p, first, second, opened } = setup();
	try {
		let lines = second.render(100);
		const receipt = lines.findIndex((line) => clean(line).includes("tok "));
		assert.ok(receipt > 1);
		assert.equal(second.handleMouse(click(95, lines.length - 1, lines.length)), undefined);
		assert.equal(second.handleMouse(click(95, receipt, lines.length))?.handled, true);
		assert.equal(p.isItemExpanded("a"), true);
		lines = first.render(100);
		const expandedReceipt = lines.findIndex((line) => clean(line).includes("tok "));
		assert.equal(first.handleMouse(click(95, expandedReceipt, lines.length))?.handled, true);
		assert.equal(p.isItemExpanded("a"), false);
		assert.deepEqual(opened, []);
	} finally { restore(); }
});

test("a collapsed active call preview expands the ledger rather than opening tool details", () => {
	const { p, second, opened } = setup();
	try {
		p.markStarted("a", "read", { path: "a.ts" });
		const lines = second.render(100);
		const preview = lines.findIndex((line) => clean(line).includes("Read(a.ts)"));
		assert.ok(preview > 1);
		assert.equal(second.handleMouse(click(95, preview, lines.length))?.handled, true);
		assert.equal(p.isItemExpanded("a"), true);
		assert.deepEqual(opened, []);
	} finally { restore(); }
});

test("expanded tool call rows open readonly details; blanks, turn headers and drags do not", async () => {
	const { p, root, opened } = setup("self");
	try {
		p.toggleGroupExpansion("a");
		const lines = root.render(100);
		const turn = lines.findIndex((line) => clean(line).includes("↻"));
		const call = lines.findIndex((line) => clean(line).includes("Read(a.ts)"));
		assert.equal(root.handleMouse(click(95, turn, lines.length)), undefined);
		assert.equal(root.handleMouse(click(95, call, lines.length, { type: "drag" })), undefined);
		assert.equal(root.handleMouse(click(95, call, lines.length, { shift: true })), undefined);
		assert.equal(root.handleMouse(click(95, call, lines.length))?.handled, true);
		await Promise.resolve();
		assert.equal(opened.length, 1);
		assert.equal(opened[0]?.kind, "tool");
		if (opened[0]?.kind === "tool") {
			assert.equal(opened[0].toolName, "read");
			assert.deepEqual(opened[0].args, { path: "a.ts" });
			assert.deepEqual(opened[0].result, result("a", "read"));
		}
		assert.equal(p.isItemExpanded("a"), true, "viewing does not change the timeline state");
	} finally { restore(); }
});

test("a Run title hosted by expanded narration can close its entire run", () => {
	const { p, root, note } = setup("default", true);
	try {
		let lines = root.render(100);
		root.handleMouse(click(95, 1, lines.length));
		lines = root.render(100);
		assert.match(clean(note.render(100).join("\n")), /Run.*\n[\s\S]*First narration/);
		const header = lines.findIndex((line) => clean(line).includes("Run"));
		assert.equal(root.handleMouse(click(95, header, lines.length))?.handled, true);
		assert.equal(p.isItemExpanded("a"), false);
		assert.deepEqual(note.render(100), []);
	} finally { restore(); }
});

test("expanded narration hosts let the whole summary area collapse the run", () => {
	const { p, note } = setup("default", true);
	try {
		p.toggleGroupExpansion("a");
		const lines = note.render(100);
		const receipt = lines.findIndex((line) => clean(line).includes("tok "));
		assert.ok(receipt > 1);
		assert.equal(note.handleMouse(click(95, receipt, lines.length))?.handled, true);
		assert.equal(p.isItemExpanded("a"), false);
	} finally { restore(); }
});

test("expanded live summaries do not duplicate pinned narration or active calls", () => {
	const { p, root } = setup("default", true);
	try {
		p.markStarted("a", "read", { path: "a.ts" });
		p.toggleGroupExpansion("a");
		const rendered = clean(root.render(100).join("\n"));
		assert.equal((rendered.match(/First narration/g) ?? []).length, 1);
		assert.equal((rendered.match(/Read\(a.ts\)/g) ?? []).length, 1);
	} finally { restore(); }
});

test("native global expansion overrides local choices and new tools inherit their run's local choice", () => {
	const { p, root } = setup();
	try {
		p.toggleGroupExpansion("a");
		const mode = {
			toolOutputExpanded: false, loadedResourcesContainer: new Container(), chatContainer: root,
			showStatus() {},
		};
		const setToolsExpanded = (InteractiveMode.prototype as unknown as { setToolsExpanded: (expanded: boolean) => void }).setToolsExpanded;
		setToolsExpanded.call(mode, true);
		assert.equal(p.isItemExpanded("a"), true);
		assert.equal(p.isItemExpanded("c"), true);
		p.toggleGroupExpansion("a");
		assert.equal(p.isItemExpanded("a"), false);
		setToolsExpanded.call(mode, false);
		assert.equal(p.isItemExpanded("c"), false);
		p.toggleGroupExpansion("a");
		// Native initial state for a new component reflects the global setting, not local overrides.
		const replacement = tool("read", "a");
		assert.match(clean(replacement.render(100).join("\n")), /Read\(a.ts\)/);
	} finally { restore(); }
});

test("passthrough tools keep native click behavior without changing aggregate run expansion", () => {
	const { p } = setup();
	try {
		const passthrough = tool("Agent", "passthrough", "self");
		const rows = passthrough.render(100);
		assert.ok(rows.every((line) => clean(line).startsWith("    ")));
		assert.equal(passthrough.handleMouse(click(3, 1, rows.length)), undefined, "the new margin is not a native hit target");
		assert.equal(passthrough.handleMouse(click(7, 1, rows.length))?.handled, true);
		assert.equal(p.isItemExpanded("a"), false);
		assert.match(clean(passthrough.render(100).join("\n")), /NATIVE RESULT/);
	} finally { restore(); }
});

for (const shell of ["self", "default"] as const) test(`passthrough ${shell}: native button coordinates, focus and capture survive indentation and resize`, () => {
	initTheme("dark", false);
	const events: TuiMouseEvent[] = [];
	const nativeButton = {
		render: (width: number) => [".".repeat(Math.max(0, width - 1)) + "X"],
		invalidate() {},
		handleMouse(event: TuiMouseEvent) {
			if (event.x !== event.width - 1) return undefined;
			events.push(event);
			return { handled: true, capture: true, focus: true };
		},
	};
	const p = new AggregateProjection(() => true);
	patchAggregateToolExecutions(p);
	try {
		const native = new ToolExecutionComponent("Agent", "native", {}, {}, {
			name: "Agent", renderShell: shell, renderCall: () => nativeButton,
		} as never, { requestRender() {} } as never, process.cwd());
		const root = new Container(); root.addChild(native);
		for (const width of [80, 30]) {
			const rows = root.render(width);
			assert.ok(rows.every((line) => visibleWidth(line) <= width));
			const y = rows.findIndex((line) => clean(line).includes("X"));
			const x = visibleWidth(rows[y].slice(0, rows[y].indexOf("X")));
			assert.equal(root.handleMouse(click(3, y, rows.length, { width })), undefined);
			const response = root.handleMouse(click(x, y, rows.length, { width, screenX: x, screenY: y }));
			assert.equal(response?.target.component, nativeButton);
			assert.equal(response?.capture, true);
			assert.equal(response?.focus, true);
			assert.equal(response?.target.originX, x - events.at(-1)!.x);
			assert.equal(events.at(-1)?.screenX, x);
		}
		assert.equal(events.length, 2);
		assert.deepEqual(native.render(4), []);
		assert.equal(native.handleMouse(click(7, 1, 3)), undefined, "a hidden narrow body has no stale targets");
	} finally { restoreAggregateToolExecutions(); }
});

for (const lineCount of [30, 3000]) test(`${lineCount}-line steer follows its run and only its omission row opens the original message`, async () => {
	initTheme("dark", false);
	const p = new AggregateProjection(() => false, () => "turns");
	p.setRenderTheme(plain);
	const steerText = Array.from({ length: lineCount }, (_, i) => `steer line ${i + 1}${lineCount > 100 ? " · additional pasted log detail" : ""}`).join("\n");
	const branch = [user("u", "request", 1), entry("a", assistant("a", "read")), entry("ra", result("a", "read")), user("steer", steerText, 2), entry("b", assistant("b", "bash")), entry("rb", result("b", "bash")), final("u")];
	p.rebuild(branch);
	patchAggregateToolExecutions(p);
	const handlers = new Map<string, Array<(event: any) => unknown>>();
	const api = { on(name: string, callback: (event: any) => unknown) { handlers.set(name, [...(handlers.get(name) ?? []), callback]); } } as unknown as ExtensionAPI;
	registerNativeUserMessageBox(api, () => ({ ...DEFAULT_TOOL_DISPLAY_CONFIG, toolCallLayout: "aggregate" }));
	const opened: DetailRequest[] = [];
	p.setDetailOpener(async (request) => { opened.push(request); });
	try {
		const component = new UserMessageComponent(steerText);
		assert.deepEqual(component.render(100), []);
		p.toggleGroupExpansion("a");
		const lines = component.render(100);
		assert.equal(lines.length, 8);
		assert.match(clean(lines.join("\n")), new RegExp(`steer line 1[\\s\\S]*steer line 3[\\s\\S]*${lineCount - 5} lines hidden[\\s\\S]*steer line ${lineCount - 1}[\\s\\S]*steer line ${lineCount}`));
		const omitted = lines.findIndex((line) => clean(line).includes("lines hidden"));
		assert.equal(component.handleMouse(click(95, 1, lines.length)), undefined);
		assert.equal(component.handleMouse(click(95, omitted, lines.length))?.handled, true);
		assert.deepEqual(opened, [{ kind: "steer", text: steerText }]);
		assert.ok(component.render(4).length <= 8, "tiny viewports cannot bypass the steer budget");
		p.toggleGroupExpansion("a");
		assert.deepEqual(component.render(100), []);
	} finally {
		for (const handler of handlers.get("session_shutdown") ?? []) await handler({ reason: "reload" });
		restore();
	}
});

test("detail opening is single-flight and becomes available again after closing", async () => {
	const p = new AggregateProjection();
	let close!: () => void;
	let count = 0;
	p.setDetailOpener(() => { count++; return new Promise<void>((resolve) => { close = resolve; }); });
	p.openDetail({ kind: "steer", text: "one" });
	p.openDetail({ kind: "steer", text: "two" });
	assert.equal(count, 1);
	close();
	await new Promise((resolve) => setImmediate(resolve));
	p.openDetail({ kind: "steer", text: "three" });
	assert.equal(count, 2);
	close();
});
