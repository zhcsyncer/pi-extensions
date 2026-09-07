import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, ToolExecutionComponent, initTheme, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Container, Input, ScrollView, Spacer, Text, TuiAltScreen, VStack, type Component } from "@earendil-works/pi-tui";
import { AggregateTerminal, fullscreen } from "./helpers/aggregate-terminal.ts";
import { AggregateProjection, patchAggregateToolExecutions, restoreAggregateToolExecutions } from "../src/aggregate-activity.ts";
import { patchAggregateThinkingPlaceholders, restoreAggregateThinkingPlaceholders } from "../src/aggregate-thinking-placeholder.ts";
import { createAggregateCollapseWidget } from "../src/aggregate-collapse-widget.ts";

const clean = (line: string) => line.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*m/g, "");

test("expanded simulation and consult ledgers remain steady at end with a real above-editor dock", () => {
	initTheme("dark", false);
	const f = fullscreen();
	const p = new AggregateProjection((name) => name === "Agent");
	const branch: unknown[] = [];
	const tools: ToolExecutionComponent[] = [];
	f.document.addChild(new Spacer(40));
	for (const [id, name] of [["simulation", "bash"], ["consultation", "consult"]]) {
		const args = name === "bash" ? { command: "simulation" } : { why: "Review the simulation" };
		const message = { role: "assistant", id: `message-${id}`, stopReason: "toolUse", content: [
			{ type: "toolCall", id, name, arguments: args },
		] };
		const result = { role: "toolResult", toolCallId: id, toolName: name,
			content: [{ type: "text", text: Array.from({ length: 30 }, (_, row) => `${id} output ${row}`).join("\n") }] };
		branch.push({ type: "message", id: `user-${id}`, message: { role: "user", content: id } },
			{ type: "message", id: `entry-${id}`, message }, { type: "message", id: `result-${id}`, message: result },
			{ type: "message", id: `final-${id}`, message: { role: "assistant", stopReason: "stop", content: [{ type: "text", text: "done" }] } });
		f.document.addChild(new Text(id, 0, 0));
		f.document.addChild(new AssistantMessageComponent(message as never, true));
		const tool = new ToolExecutionComponent(name, id, args, {}, {
			name, label: name, description: name, parameters: { type: "object", properties: {} },
			execute() { throw new Error("inspection must not execute tools"); },
			renderCall: () => new Text("native", 0, 0), renderResult: () => new Text("native result", 0, 0),
		} as never, f.renderer, process.cwd());
		tool.updateResult(result as never);
		tools.push(tool); f.document.addChild(tool);
	}
	const final = new Text("final answer", 0, 0); f.document.addChild(final);
	p.rebuild(branch);
	patchAggregateToolExecutions(p);
	patchAggregateThinkingPlaceholders(() => true);
	const widget = createAggregateCollapseWidget(p);
	const mounts: boolean[] = [];
	const theme = { fg: (_: string, text: string) => text };
	widget.bind({ hasUI: true, ui: {
		theme,
		setWidget(_key: string, factory: ((tui: typeof f.renderer, theme: any) => Component) | undefined) {
			mounts.push(!!factory);
			f.widgets.clear();
			if (factory) { f.widgets.addChild(new Spacer(1)); f.widgets.addChild(factory(f.renderer, theme)); }
			f.renderer.requestRender();
		},
	} } as unknown as ExtensionContext);
	try {
		f.start();
		f.scroll.scrollToStart(); f.paint(); f.paint();
		// Exercise the projection's actual expand path, not hand-recorded viewport regions.
		p.toggleGroupExpansionFromComponent("simulation", tools[0]); f.paint();
		p.toggleGroupExpansionFromComponent("consultation", tools[1]); f.paint();
		f.scroll.scrollToStart(); f.paint(); f.paint();
		assert.equal(p.isItemExpanded("simulation"), true);
		assert.equal(p.isItemExpanded("consultation"), true);
		assert.equal(f.widgets.children.length, 0);
		// Without a dock the last tool body overlaps the viewport by one row.
		final.setText(Array(f.scroll.viewportHeight - 1).fill("final answer").join("\n")); f.paint();
		mounts.length = 0;
		f.scroll.scrollToEnd(); f.paint();
		const undockedTop = f.scroll.scrollTop;
		const undockedHeight = f.scroll.viewportHeight;
		const frames = Array.from({ length: 8 }, () => {
			f.paint();
			return { top: f.scroll.scrollTop, height: f.scroll.viewportHeight, screen: f.lines() };
		});
		assert.deepEqual(frames, Array(8).fill(frames[0]), frames.map(({ top, height }) => `${top}/${height}`).join(", "));
		assert.equal(frames[0].top, undockedTop + 2);
		assert.equal(frames[0].height, undockedHeight - 2);
		assert.ok(frames[0].screen.some((line) => line.includes("Collapse")));
		assert.deepEqual(mounts, [true]);
		assert.equal(f.scroll.isFollowingEnd, true);
		f.terminal.click(f.terminal.columns - 3, f.lines().findIndex((line) => line.includes("Collapse"))); f.paint(); f.paint();
		assert.equal(p.isItemExpanded("simulation"), true);
		assert.equal(p.isItemExpanded("consultation"), false);
	} finally {
		widget.dispose(); f.stop();
		restoreAggregateThinkingPlaceholders(); restoreAggregateToolExecutions();
	}
});

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
		const titleLabel = p.getViewportRun("a-0")!.label().replace(/\)$/, "");
		const initialTitle = screen().findIndex((line) => line.includes(titleLabel));
		assert.ok(initialTitle >= 0, "collapsed title should be visible while following end");
		assert.equal(scroll.isFollowingEnd, true);
		click(initialTitle);
		assert.equal(p.isItemExpanded("a-0"), true);
		assert.equal(p.isItemExpanded("b-0"), false);
		assert.equal(screen().findIndex((line) => line.includes(titleLabel)), initialTitle);
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
		click(screen().findIndex((line) => line.includes("Collapse")), terminal.columns - 3);
		assert.equal(p.isItemExpanded("a-0"), false);
		assert.equal(p.isItemExpanded("b-0"), false);
		assert.ok(screen().some((line) => line.includes(titleLabel)));
		assert.ok(screen().every((line) => !line.includes("Collapse")));
		input("z");
		assert.equal(editor.getValue(), "kz");
	} finally {
		control.dispose(); tui.stop();
		restoreAggregateThinkingPlaceholders(); restoreAggregateToolExecutions();
	}
});
