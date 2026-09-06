import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, ScrollView, Spacer, Text, TuiAltScreen, VStack, type Component } from "@earendil-works/pi-tui";
import { AggregateTerminal } from "./helpers/aggregate-terminal.ts";
import { AggregateProjection, patchAggregateToolExecutions, restoreAggregateToolExecutions } from "../src/aggregate-activity.ts";
import { patchAggregateThinkingPlaceholders, restoreAggregateThinkingPlaceholders } from "../src/aggregate-thinking-placeholder.ts";
import { createAggregateCollapseWidget } from "../src/aggregate-collapse-widget.ts";

const clean = (line: string) => line.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");

test("real fullscreen ledger anchors migrating titles and collapses through the editor widget without stealing focus", () => {
	initTheme("dark", false);
	const terminal = new AggregateTerminal();
	terminal.columns = 90;
	terminal.rows = 24;
	const input = (data: string) => terminal.onInput?.(data);
	const tui = new TuiAltScreen(terminal, false, undefined, { mouse: true, copyOnSelect: false });
	const p = new AggregateProjection((name) => name === "Agent");
	const branch: unknown[] = [];
	const messages: Array<{ name: string; id: string; message: any }> = [];
	for (const [group, count] of [["a", 12], ["b", 1]] as const) {
		branch.push({ type: "message", id: `user-${group}`, message: { role: "user", content: `request ${group}` } });
		for (let i = 0; i < count; i++) {
			const id = `${group}-${i}`;
			const message = { role: "assistant", id: `message-${id}`, stopReason: "toolUse", content: [
				...(id === "a-0" ? [{ type: "text", text: Array.from({ length: 55 }, (_, n) => `Narration row ${n}`).join("\n") }] : []),
				{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } },
			] };
			messages.push({ id, name: "read", message });
			branch.push({ type: "message", id: `entry-${id}`, message });
			branch.push({ type: "message", id: `result-${id}`, message: { role: "toolResult", toolCallId: id, toolName: "read", content: [{ type: "text", text: "ok" }] } });
		}
		branch.push({ type: "message", id: `final-${group}`, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });
	}
	p.rebuild(branch);
	patchAggregateToolExecutions(p);
	patchAggregateThinkingPlaceholders(() => true);
	const document = new Container();
	document.addChild(new Spacer(40));
	for (const { id, name, message } of messages) {
		document.addChild(new AssistantMessageComponent(message, true));
		const tool = new ToolExecutionComponent(name, id, { path: `${id}.ts` }, {}, {
			name, label: name, description: name, parameters: { type: "object", properties: {} },
			execute() { throw new Error("inspection must not execute tools"); },
			renderCall: () => new Text("native", 0, 0), renderResult: () => new Text("native result", 0, 0),
		} as never, tui, process.cwd());
		tool.updateResult({ content: [{ type: "text", text: "ok" }] } as never);
		document.addChild(tool);
	}
	const scroll = new ScrollView(document, { primary: true, follow: "end", scrollbar: "always" });
	const widgets = new Container();
	const editor = new Input();
	tui.setLayoutRoot(new VStack([
		{ component: new Text("Application heading", 0, 0), basis: 1, shrink: 0 },
		{ component: scroll, basis: 0, grow: 1, minSize: 1 },
		{ component: widgets, shrink: 0 },
		{ component: editor, basis: 1, shrink: 0 },
	]));
	tui.setFocus(editor);
	const control = createAggregateCollapseWidget(p);
	const theme = { fg: (_: string, text: string) => text };
	control.bind({ hasUI: true, mode: "tui", ui: {
		theme,
		setWidget(_key: string, factory: ((t: typeof tui, theme: any) => Component) | undefined) {
			widgets.clear();
			if (factory) { widgets.addChild(new Spacer(1)); widgets.addChild(factory(tui, theme)); }
			tui.requestRender();
		},
	} } as unknown as ExtensionContext);
	const paint = () => { tui.renderNow(); tui.renderNow(); };
	const screen = () => ((tui as unknown as { currentLayout: { lines: string[] } }).currentLayout.lines).map(clean);
	const click = (row: number, column = 5) => {
		assert.ok(row >= 0 && row < terminal.rows);
		input(`\x1b[<0;${column + 1};${row + 1}M`);
		input(`\x1b[<0;${column + 1};${row + 1}m`);
		paint();
	};
	try {
		tui.start(); paint();
		const initialTitle = screen().findIndex((line) => line.includes("Tools (12 calls"));
		assert.ok(initialTitle >= 0, "collapsed title should be visible while following end");
		assert.equal(scroll.isFollowingEnd, true);
		click(initialTitle);
		assert.equal(p.isItemExpanded("a-0"), true);
		assert.equal(p.isItemExpanded("b-0"), false);
		assert.equal(screen().findIndex((line) => line.includes("Tools (12 calls")), initialTitle);
		assert.equal(scroll.isFollowingEnd, false);
		assert.ok(screen().some((line) => line.includes("Narration row")), "title moved to the newly visible narration host");
		scroll.scrollBy(25); paint();
		assert.ok(screen().some((line) => line.includes("Collapse")), `scrollTop=${scroll.scrollTop}\n${screen().join("\n")}`);
		assert.equal(tui.hasOverlay(), false);
		input("k"); paint();
		assert.equal(editor.getValue(), "k", "widget must not own typing focus");
		const modal = tui.showOverlay(new Text("foreground details", 0, 0), { width: 30 });
		paint();
		assert.ok(screen().every((line) => !line.includes("Collapse")));
		modal.hide(); paint();
		click(screen().findIndex((line) => line.includes("Collapse")));
		assert.equal(p.isItemExpanded("a-0"), false);
		assert.equal(p.isItemExpanded("b-0"), false);
		assert.ok(screen().some((line) => line.includes("Tools (12 calls")));
		assert.ok(screen().every((line) => !line.includes("Collapse")));
		input("z");
		assert.equal(editor.getValue(), "kz");
	} finally {
		control.dispose(); tui.stop();
		restoreAggregateThinkingPlaceholders(); restoreAggregateToolExecutions();
	}
});
