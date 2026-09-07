import assert from "node:assert/strict";
import test from "node:test";
import { Container, Spacer, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
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
	type: "click", button: "left", x: 76, y: 0, screenX: 76, screenY: 0,
	width: 80, height: 1, shift: false, ctrl: false, alt: false, ...extra,
});

test("fixed collapse control dispatches locally without requesting keyboard focus", () => {
	const { projection, button } = setup();
	const root = new Container();
	root.addChild(new Spacer(2));
	root.addChild(button);
	const rows = root.render(80);
	assert.match(rows[2], /Run \(1 call\).*Collapse/);
	assert.equal(visibleWidth(rows[2]), 79, "right-align with one column of breathing room");
	assert.ok(rows[2].startsWith(" ".repeat(40)), "the left side is empty, not a click target");
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
	for (const extras of [{ type: "drag" }, { type: "press" }, { button: "right" }, { shift: true }, { ctrl: true }, { alt: true }, { x: 3 }, { x: 79 }, { x: -1 }, { y: 1 }] as Partial<TuiMouseEvent>[]) {
		assert.equal(button.handleMouse?.(click(extras)), undefined);
		assert.equal(projection.isItemExpanded("a"), true);
	}
});

test("resizing updates the right-aligned hit area and never exceeds narrow widths", () => {
	const { projection, button } = setup();
	button.render(80);
	const rows = button.render(40);
	assert.ok(rows.every((row) => visibleWidth(row) <= 40));
	assert.equal(button.handleMouse?.(click()), undefined, "old wide-screen coordinates are no longer active");
	assert.equal(button.handleMouse?.(click({ x: 3, width: 40 })), undefined);
	assert.equal(button.handleMouse?.(click({ x: 37, width: 40 }))?.handled, true);
	assert.equal(projection.isItemExpanded("a"), false);
	projection.toggleGroupExpansion("a");
	for (const width of [0, 1, 2, 8]) assert.ok(button.render(width).every((row) => visibleWidth(row) <= width));
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
