import assert from "node:assert/strict";
import test from "node:test";
import { Container, Spacer, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AggregateProjection } from "../src/aggregate-activity.ts";
import { createAggregateCollapseControl } from "../src/aggregate-collapse-widget.ts";

function setup() {
	const projection = new AggregateProjection();
	for (const id of ["a", "b"]) {
		projection.startUserGroup(`user-${id}`);
		projection.ingestAssistantMessage({ role: "assistant", id: `assistant-${id}`, stopReason: "toolUse", content: [
			{ type: "toolCall", id, name: "read", arguments: { path: `${id}.ts` } },
		] });
	}
	projection.toggleGroupExpansion("a");
	const run = projection.getViewportRun("a")!;
	let mode: "fullscreen" | "regular" = "fullscreen";
	let overlay = false;
	const button = createAggregateCollapseControl(() => ({ run, collapse: () => run.toggle() }), {
		get mode() { return mode; }, hasOverlay: () => overlay,
	}, (text) => text);
	return { projection, run, button, setMode: (value: typeof mode) => { mode = value; }, setOverlay: (value: boolean) => { overlay = value; } };
}
const click = (extra: Partial<TuiMouseEvent> = {}): TuiMouseEvent => ({
	type: "click", button: "left", x: 3, y: 0, screenX: 3, screenY: 0,
	width: 80, height: 1, shift: false, ctrl: false, alt: false, ...extra,
});

test("fixed collapse control dispatches locally without requesting keyboard focus", () => {
	const { projection, button } = setup();
	const root = new Container();
	root.addChild(new Spacer(2));
	root.addChild(button);
	const rows = root.render(80);
	assert.match(rows[2], /Run \(1 call\).*Collapse/);
	const result = root.handleMouse(click({ y: 2, screenY: 2, height: rows.length }));
	assert.equal(result?.handled, true);
	assert.notEqual(result?.focus, true);
	assert.equal(projection.isItemExpanded("a"), false);
	assert.equal(projection.isItemExpanded("b"), false, "do not globally toggle unrelated runs");
	assert.deepEqual(button.render(80), []);
});

test("drag, modifiers and whitespace outside the control cannot collapse the run", () => {
	const { projection, button } = setup();
	button.render(80);
	for (const extras of [{ type: "drag" }, { type: "press" }, { button: "right" }, { shift: true }, { ctrl: true }, { alt: true }, { x: 79 }, { x: -1 }, { y: 1 }] as Partial<TuiMouseEvent>[]) {
		assert.equal(button.handleMouse?.(click(extras)), undefined);
		assert.equal(projection.isItemExpanded("a"), true);
	}
});

test("an overlay, renderer switch or removed run immediately disables a previously drawn control", () => {
	const { projection, button, setMode, setOverlay } = setup();
	button.render(80);
	setOverlay(true);
	assert.equal(button.handleMouse?.(click()), undefined);
	assert.deepEqual(button.render(80), []);
	setOverlay(false);
	button.render(80);
	setMode("regular");
	assert.equal(button.handleMouse?.(click()), undefined);
	assert.deepEqual(button.render(80), []);
	setMode("fullscreen");
	button.render(80);
	projection.rebuild([]);
	assert.equal(button.handleMouse?.(click()), undefined);
	assert.deepEqual(button.render(80), []);
});
