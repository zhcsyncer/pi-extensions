import assert from "node:assert/strict";
import { afterEach, beforeEach, test } from "node:test";
import * as Tui from "@earendil-works/pi-tui";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createAggregateCollapseWidget } from "../src/aggregate-collapse-widget.ts";
import {
	patchAggregateViewport, releaseAggregateViewportRegion, resetAggregateViewportOwner,
	restoreAggregateViewport, subscribeAggregateViewportControl, toggleAggregateViewportRun,
	type AggregateViewportControl,
} from "../src/aggregate-viewport.ts";
import { AggregateTerminal, Host, Rows, Run, fullscreen, host } from "./helpers/aggregate-terminal.ts";

const fixtures: ReturnType<typeof fullscreen>[] = [];
const subscriptions: (() => void)[] = [];
function fixture(options?: Parameters<typeof fullscreen>[0]) {
	const result = fullscreen(options);
	fixtures.push(result);
	return result;
}
function controlFor(owner: object) {
	let control: AggregateViewportControl | undefined;
	const changes: (string | undefined)[] = [];
	subscriptions.push(subscribeAggregateViewportControl(owner, (next) => { control = next; changes.push(next?.run.id); }));
	return { get current() { return control; }, changes };
}
function mountWidget(f: ReturnType<typeof fullscreen>, owner: object, gap = 1) {
	const widget = createAggregateCollapseWidget(owner);
	const changes: boolean[] = [];
	const theme = { fg: (_: string, text: string) => text };
	widget.bind({ hasUI: true, ui: {
		theme,
		setWidget(_key: string, factory: ((tui: typeof f.renderer, theme: any) => Tui.Component) | undefined) {
			changes.push(!!factory);
			f.widgets.clear();
			if (factory) { f.widgets.addChild(new Tui.Spacer(gap)); f.widgets.addChild(factory(f.renderer, theme)); }
			f.renderer.requestRender();
		},
	} } as unknown as ExtensionContext);
	subscriptions.push(() => widget.dispose());
	return changes;
}
function bottomWidget(gap = 1) {
	const f = fixture();
	const owner = {};
	const first = new Run(owner, "simulation"); first.expanded = true;
	const second = new Run(owner, "consult"); second.expanded = true;
	const hosts = [host(first, 20), host(second, 20)];
	for (const component of hosts) f.document.addChild(component);
	// The last body row is visible without the dock; mounting it moves top past bodyEnd.
	const final = new Rows(f.terminal.rows - 2 - 2 - 1, "final answer");
	f.document.addChild(final);
	const selected = controlFor(owner);
	const changes = mountWidget(f, owner, gap);
	return { f, owner, first, second, hosts, final, selected, changes };
}
function scrollTo(f: ReturnType<typeof fullscreen>, row: number) { f.scroll.scrollTo(row, { disableFollow: true }); f.paint(); }
function transcriptLine(f: ReturnType<typeof fullscreen>, row: number) { return f.lines()[row].slice(0, -1).trim(); }
beforeEach(() => patchAggregateViewport());
afterEach(() => {
	for (const f of fixtures.splice(0)) f.stop();
	restoreAggregateViewport();
	for (const unsubscribe of subscriptions.splice(0)) unsubscribe();
});

test("an immutable native layout hook degrades to local expansion instead of breaking paint", () => {
	const f = fixture();
	const run = new Run({}, "immutable-scroll");
	const component = host(run);
	f.document.addChild(component);
	Object.defineProperty(f.scroll, "updateLayout", { value: f.scroll.updateLayout, writable: false, configurable: true });
	assert.doesNotThrow(() => f.start());
	assert.doesNotThrow(() => toggleAggregateViewportRun(component, run));
	assert.equal(run.expanded, true);
	assert.doesNotThrow(() => f.paint());
});

test("SGR receipt click preserves the header before paint when its host migrates into earlier narration", () => {
	const f = fixture();
	const run = new Run({}, "migrating");
	const note = new Host(run, () => ({ lines: run.expanded ? [run.label(), "narration"] : [], titleRow: run.expanded ? 0 : undefined }));
	const firstTool = new Host(run, () => ({ lines: run.expanded ? Array(12).fill("first tool") : [] }));
	const lastTool = new Host(run, () => ({ lines: run.expanded ? Array(10).fill("last tool") : [run.label(), "receipt"], titleRow: run.expanded ? undefined : 0 }));
	const turn = new Tui.Container();
	turn.addChild(note); turn.addChild(firstTool); turn.addChild(lastTool);
	f.document.addChild(new Rows(5)); f.document.addChild(turn); f.document.addChild(new Rows(20, "final answer"));
	f.start(); scrollTo(f, 2);
	assert.equal(transcriptLine(f, 5), run.label());
	const counts = [note.renders, firstTool.renders, lastTool.renders];
	f.terminal.click(20, 6);
	assert.equal(run.toggles, 1);
	assert.ok(lastTool.events.includes("press") && lastTool.events.includes("release") && lastTool.events.includes("click"));
	assert.equal(run.expanded, true);
	f.paint();
	assert.equal(f.scroll.scrollTop, 2);
	assert.equal(transcriptLine(f, 5), run.label(), "the first painted expanded frame is already anchored");
	assert.deepEqual([note.renders, firstTool.renders, lastTool.renders], counts.map((n) => n + 1), "geometry collection must not render hosts");
	assert.equal(transcriptLine(f, 6), "narration");
});

for (const prefix of [1, 30]) {
	test(`toggle suppresses follow-end before mutation (${prefix === 1 ? "short-to-long" : "already scrolling"})`, () => {
		const f = fixture();
		const run = new Run({}, "follow");
		const component = host(run);
		f.document.addChild(new Rows(prefix)); f.document.addChild(component);
		f.start();
		assert.equal(f.scroll.isFollowingEnd, true);
		const oldTop = f.scroll.scrollTop;
		const headingRow = 2 + prefix - oldTop;
		run.onToggle = () => assert.equal(f.scroll.isFollowingEnd, false, "disable follow before the original toggle");
		toggleAggregateViewportRun(component, run);
		f.paint();
		assert.equal(f.scroll.scrollTop, oldTop);
		assert.equal(transcriptLine(f, headingRow), run.label());
		assert.equal(f.scroll.isFollowingEnd, false);
		f.document.addChild(new Rows(20, "streaming output")); f.paint();
		assert.equal(f.scroll.scrollTop, oldTop, "later output must not re-enable following");
	});
}

test("fixed collapse control targets only the current body and anchors the collapsed header", () => {
	const f = fixture();
	const run = new Run({}, "isolated"); run.expanded = true;
	const component = host(run, 35);
	f.document.addChild(new Rows(6)); f.document.addChild(component); f.document.addChild(new Rows(20, "final answer"));
	const selected = controlFor(run.owner);
	f.start(); scrollTo(f, 6);
	assert.equal(selected.current, undefined, "header exactly at transcript top needs no fixed control");
	scrollTo(f, 7);
	assert.equal(selected.current?.run, run);
	const retained = selected.current;
	const collapse = selected.current!.collapse;
	collapse();
	assert.equal(run.toggles, 1);
	f.paint();
	assert.equal(f.scroll.scrollTop, 6);
	assert.equal(transcriptLine(f, 2), run.label());
	assert.equal(selected.current, undefined);
	retained!.collapse();
	assert.equal(run.toggles, 1, "a stale control must not toggle again");
	assert.equal(f.scroll.isFollowingEnd, false);
});

test("an isolated short collapsed document clamps to its native start rather than following later growth", () => {
	const f = fixture();
	const run = new Run({}, "only-run"); run.expanded = true;
	f.document.addChild(host(run, 35));
	const selected = controlFor(run.owner);
	f.start(); scrollTo(f, 10);
	selected.current!.collapse(); f.paint();
	assert.equal(f.scroll.scrollTop, 0);
	assert.equal(transcriptLine(f, 2), run.label());
	assert.equal(f.scroll.isFollowingEnd, false);
	f.document.addChild(new Rows(30)); f.paint();
	assert.equal(f.scroll.scrollTop, 0);
});

test("duplicate labels select by run identity, never the next run or a final answer outside the ledger", () => {
	const f = fixture();
	const owner = {};
	const first = new Run(owner, "first"); first.expanded = true;
	const second = new Run(owner, "second"); second.expanded = true;
	f.document.addChild(host(first, 15));
	f.document.addChild(new Rows(9, "first final answer"));
	f.document.addChild(host(second, 15));
	f.document.addChild(new Rows(20, "last final answer"));
	const selected = controlFor(owner);
	f.start(); scrollTo(f, 1);
	assert.equal(selected.current?.run.id, "first");
	const control = selected.current;
	const emitted = selected.changes.length;
	f.paint(); f.paint();
	first.text = "live label"; f.paint();
	assert.equal(selected.current, control);
	assert.equal(selected.current?.run.label(), "live label");
	assert.equal(selected.changes.length, emitted, "a paint or live label change must not schedule a widget loop");
	scrollTo(f, 16);
	assert.equal(selected.current, undefined, "end boundary is exclusive even when the next ledger is visible below");
	scrollTo(f, 25);
	assert.equal(selected.current, undefined, "second header is still visible");
	scrollTo(f, 26);
	assert.equal(selected.current?.run.id, "second");
	scrollTo(f, 41);
	assert.equal(selected.current, undefined, "last final answer is not part of the expanded body");
	assert.equal(first.toggles + second.toggles, 0);
});

for (const gap of [0, 1, 3]) {
	test(`follow-end widget relayout keeps its selection without oscillation (${gap} spacer rows)`, () => {
		const { f, first, second, hosts, selected, changes } = bottomWidget(gap);
		const editor = new Tui.Input(); f.renderer.setFocus(editor);
		f.start();
		assert.equal(selected.current?.run, second);
		const before = hosts.map((component) => component.renders);
		const frames = Array.from({ length: 8 }, () => {
			f.paint();
			return { top: f.scroll.scrollTop, height: f.scroll.viewportHeight, run: selected.current?.run.id,
				visible: f.lines().some((line) => line.includes("Collapse")) };
		});
		assert.deepEqual(frames, Array(8).fill(frames[0]), JSON.stringify(frames));
		assert.equal(frames[0].run, second.id);
		assert.equal(frames[0].visible, true);
		assert.deepEqual(changes, [true], "the widget must mount only once");
		assert.deepEqual(hosts.map((component) => component.renders), before.map((count) => count + 8), "no extra child renders for geometry");
		assert.equal(f.scroll.isFollowingEnd, true);
		assert.equal(f.renderer.hasOverlay(), false);
		f.terminal.onInput!("typed");
		assert.equal(editor.getValue(), "typed");
		f.terminal.click(f.terminal.columns - 3, f.lines().findIndex((line) => line.includes("Collapse"))); f.paint();
		assert.equal(first.expanded, true);
		assert.equal(second.expanded, false, "the retained control still collapses its selected run");
		assert.equal(selected.current, undefined);
	});
}

test("native wheel, scrollbar drag and end navigation replace a dock-stabilized target", () => {
	const { f, first, second, selected } = bottomWidget();
	f.start(); f.paint();
	assert.equal(selected.current?.run, second);
	// One wheel step leaves top outside the body, so removing the dock must preserve absence.
	f.terminal.mouse(64, 10, 4); f.paint();
	assert.equal(selected.current, undefined);
	for (let i = 0; i < 4; i++) { f.paint(); assert.equal(selected.current, undefined); }
	f.terminal.mouse(64, 10, 4); f.paint(); f.paint();
	assert.equal(selected.current?.run, second);
	// Drag the native thumb to the beginning; no interception by the fixed control.
	f.terminal.mouse(0, 43, 6);
	f.terminal.mouse(32, 43, 2);
	f.terminal.mouse(0, 43, 2, true); f.paint(); f.paint();
	assert.equal(f.scroll.scrollTop, 0);
	assert.equal(selected.current, undefined);
	f.terminal.mouse(65, 10, 4); f.paint(); f.paint();
	assert.equal(selected.current?.run, first);
	f.scroll.scrollToEnd(); f.paint();
	assert.equal(selected.current, undefined, "end navigation reaches final text, not the previously selected run");
	for (let i = 0; i < 4; i++) { f.paint(); assert.equal(selected.current, undefined); }
});

test("same-height text updates do not restart dock visibility feedback", () => {
	const { f, second, final, selected, changes } = bottomWidget();
	f.start(); f.paint();
	for (let i = 0; i < 8; i++) {
		final.text = `streaming text or elapsed time ${i}`;
		f.paint();
		assert.equal(selected.current?.run, second);
	}
	assert.deepEqual(changes, [true]);
});

for (const change of ["follow", "final growth", "collapse", "remove", "invalidate", "branch", "resize"] as const) {
	test(`${change} clears a dock-stabilized target without remounting on the resulting layout`, () => {
		const { f, second, hosts, final, selected } = bottomWidget();
		f.start(); f.paint();
		const retained = selected.current!;
		assert.equal(retained.run, second);
		switch (change) {
			case "follow": f.scroll.scrollTo(f.scroll.scrollTop, { disableFollow: true }); break;
			case "final growth": final.count++; break;
			case "collapse": second.expanded = false; break;
			case "remove": f.document.removeChild(hosts[1]); break;
			case "invalidate": second.valid = false; break;
			case "branch": f.document.clear(); f.document.addChild(new Rows(49, "new branch")); break;
			case "resize": f.terminal.resize(40, 11); break;
		}
		if (change === "follow") {
			retained.collapse();
			assert.equal(second.toggles, 0, "a follow-state change invalidates the old control even before paint");
		}
		f.paint();
		assert.equal(selected.current, undefined);
		for (let i = 0; i < 4; i++) {
			f.paint();
			assert.equal(selected.current, undefined);
			assert.equal(f.widgets.children.length, 0, "no permanent blank dock slot");
		}
		retained.collapse();
		assert.equal(second.toggles, 0);
	});
}

test("owner reset clears the old dock control immediately and freshly recorded runs can be selected again", () => {
	const { f, owner, second, selected } = bottomWidget();
	f.start(); f.paint();
	const retained = selected.current!;
	resetAggregateViewportOwner(owner);
	assert.equal(selected.current, undefined);
	assert.equal(f.widgets.children.length, 0);
	retained.collapse();
	assert.equal(second.toggles, 0);
	f.paint(); f.paint();
	assert.equal(selected.current?.run, second, "native rendering records a new generation");
	assert.notEqual(selected.current, retained);
	const top = f.scroll.scrollTop;
	for (let i = 0; i < 4; i++) { f.paint(); assert.equal(f.scroll.scrollTop, top); assert.equal(selected.current?.run, second); }
});

test("overlay dismissal rediscovers a dock-stabilized target after hiding it", () => {
	const { f, second, selected } = bottomWidget();
	f.start(); f.paint();
	const retained = selected.current!;
	const overlay = f.renderer.showOverlay(new Rows(1, "details"), { width: 20 });
	retained.collapse();
	assert.equal(second.toggles, 0);
	for (let i = 0; i < 4; i++) { f.paint(); assert.equal(selected.current, undefined); }
	overlay.hide(); f.paint(); f.paint();
	assert.equal(selected.current?.run, second);
	const top = f.scroll.scrollTop;
	for (let i = 0; i < 4; i++) { f.paint(); assert.equal(f.scroll.scrollTop, top); assert.equal(selected.current?.run, second); }
});

test("real nonzero viewport origin, scrollbar width and resize use current cached widths", () => {
	const f = fixture({ top: 3, left: 7 });
	const run = new Run({}, "resize");
	const component = new Host(run, (width) => ({
		lines: ["", run.label(), ...Array(run.expanded ? Math.ceil(450 / width) : 1).fill("wrapped body")], titleRow: 1,
	}));
	f.document.addChild(new Rows(4)); f.document.addChild(component); f.document.addChild(new Rows(30));
	f.start(); scrollTo(f, 2);
	assert.equal(component.width, 44 - 7 - 1);
	f.terminal.resize(33, 15); f.paint();
	assert.equal(component.width, 33 - 7 - 1);
	f.terminal.click(10, 7); f.paint();
	assert.equal(run.toggles, 1);
	assert.equal(f.scroll.scrollTop, 2);
	assert.ok(f.lines()[6].includes(run.label()));
	const selected = controlFor(run.owner);
	scrollTo(f, 6);
	assert.equal(selected.current?.run.id, run.id);
	f.terminal.resize(40, 11); f.paint();
	assert.equal(component.width, 40 - 7 - 1);
	assert.equal(selected.current?.run.id, run.id);
	selected.current!.collapse(); f.paint();
	assert.equal(f.scroll.scrollTop, 5);
	assert.ok(f.lines()[3].includes(run.label()));
});

test("wheel and scrollbar remain native and control selection never takes focus", () => {
	const f = fixture();
	const run = new Run({}, "mouse"); run.expanded = true;
	f.document.addChild(host(run, 40)); f.document.addChild(new Rows(15));
	const focus = new Tui.Input(); f.renderer.setFocus(focus);
	const selected = controlFor(run.owner);
	f.start(); scrollTo(f, 0);
	f.terminal.mouse(65, 10, 5); f.paint();
	assert.equal(f.scroll.scrollTop, 1);
	assert.equal(selected.current?.run.id, run.id);
	assert.equal(focus.focused, true);
	const before = f.scroll.scrollTop;
	f.terminal.click(43, 8); f.paint();
	assert.ok(f.scroll.scrollTop > before, "clicking the native scrollbar track still scrolls");
	assert.equal(run.toggles, 0);
	assert.equal(focus.focused, true);
});

test("foreign overlays hide the target after native paint without intercepting overlay focus", () => {
	const f = fixture();
	const run = new Run({}, "overlay"); run.expanded = true;
	f.document.addChild(host(run, 35));
	const selected = controlFor(run.owner);
	const editor = new Tui.Input(); f.renderer.setFocus(editor);
	f.start(); scrollTo(f, 2);
	const retained = selected.current!;
	const foreign = new Tui.Input();
	const handle = f.renderer.showOverlay(foreign, { width: 20, row: 4 });
	assert.equal(foreign.focused, true);
	retained.collapse();
	assert.equal(run.toggles, 0, "an overlay opened since the last paint already blocks stale controls");
	f.paint();
	assert.equal(selected.current, undefined);
	assert.equal(f.renderer.hasOverlay(), true);
	assert.equal(foreign.focused, true);
	f.terminal.onInput!("hello");
	assert.equal(foreign.getValue(), "hello");
	handle.hide(); f.paint();
	assert.equal(selected.current?.run.id, run.id);
	assert.equal(editor.focused, true);
	const passive = f.renderer.showOverlay(new Rows(1), { nonCapturing: true, width: 20 });
	f.paint();
	assert.equal(selected.current, undefined, "even a foreign noncapturing overlay suppresses the fixed target");
	assert.equal(editor.focused, true);
	passive.hide();
});

test("stale runs, released regions and owner reset discard pending anchors and controls", () => {
	const f = fixture();
	const run = new Run({}, "stale"); run.expanded = true;
	const component = host(run, 35);
	f.document.addChild(new Rows(6)); f.document.addChild(component); f.document.addChild(new Rows(25));
	const selected = controlFor(run.owner);
	f.start(); scrollTo(f, 8);
	const retained = selected.current!;
	run.valid = false;
	retained.collapse(); f.paint();
	assert.equal(run.toggles, 0);
	assert.equal(selected.current, undefined);
	run.valid = true; f.paint();
	assert.ok(selected.current);
	toggleAggregateViewportRun(component, run);
	resetAggregateViewportOwner(run.owner);
	assert.equal(selected.current, undefined);
	f.paint();
	assert.equal(f.scroll.scrollTop, 8, "reset discarded the collapse-to-header transaction");
	run.expanded = true; f.paint();
	releaseAggregateViewportRegion(component);
	toggleAggregateViewportRun(component, run); f.paint();
	assert.equal(f.scroll.scrollTop, 8, "released receiver falls back to exactly one local toggle");
	assert.equal(run.toggles, 2);
});

test("a transaction is one-shot and discarded when fresh geometry no longer contains its run", () => {
	const f = fixture();
	const run = new Run({}, "removed");
	const component = host(run);
	f.document.addChild(new Rows(6)); f.document.addChild(component); f.document.addChild(new Rows(40));
	f.start(); scrollTo(f, 2);
	toggleAggregateViewportRun(component, run);
	f.document.removeChild(component); f.paint();
	f.document.addChild(component); f.paint();
	assert.equal(f.scroll.scrollTop, 2, "an unresolved transaction must not jump on a later unrelated frame");
	assert.equal(run.toggles, 1);
});

test("user scrolling or resizing before the pending paint wins over an old anchor transaction", () => {
	const f = fixture();
	const run = new Run({}, "interrupted");
	const component = host(run, 35);
	f.document.addChild(new Rows(6)); f.document.addChild(component); f.document.addChild(new Rows(40));
	f.start(); scrollTo(f, 2);
	toggleAggregateViewportRun(component, run);
	f.scroll.scrollBy(1); f.paint();
	assert.equal(f.scroll.scrollTop, 3, "do not rewind an intervening wheel/scroll action");
	scrollTo(f, 8);
	toggleAggregateViewportRun(component, run);
	f.terminal.resize(35, 13); f.paint();
	assert.equal(f.scroll.scrollTop, 8, "a resized frame discards its old viewport-coordinate transaction");
	assert.equal(run.toggles, 2);
});

test("identical targets notify when their owning renderer changes and collapse only scrolls that renderer", () => {
	const first = fixture(); const second = fixture();
	const run = new Run({}, "shared-owner"); run.expanded = true;
	first.document.addChild(host(run, 35)); first.document.addChild(new Rows(30));
	second.document.addChild(new Rows(6)); second.document.addChild(host(run, 35)); second.document.addChild(new Rows(30));
	const selected = controlFor(run.owner);
	first.start(); scrollTo(first, 2);
	const old = selected.current!;
	const changes = selected.changes.length;
	second.start(); scrollTo(second, 8);
	assert.notEqual(selected.current, old);
	assert.equal(selected.changes.length, changes + 1);
	old.collapse();
	assert.equal(run.toggles, 0);
	selected.current!.collapse(); second.paint();
	assert.equal(second.scroll.scrollTop, 6);
	assert.equal(first.scroll.scrollTop, 2);
	assert.equal(run.toggles, 1);
});

test("stop clears selection and instance hooks before native terminal teardown, then restart can rediscover", () => {
	const f = fixture();
	const run = new Run({}, "lifecycle"); run.expanded = true;
	f.document.addChild(host(run, 40));
	const selected = controlFor(run.owner);
	const nativeUpdate = f.scroll.updateLayout;
	f.start(); scrollTo(f, 2);
	assert.notEqual(f.scroll.updateLayout, nativeUpdate);
	f.terminal.onStop = () => {
		assert.equal(selected.current, undefined);
		assert.equal(f.scroll.updateLayout, nativeUpdate);
	};
	const retained = selected.current!;
	f.stop(); retained.collapse();
	assert.equal(run.toggles, 0);
	f.start(); scrollTo(f, 2);
	assert.equal(selected.current?.run.id, run.id);
});

test("restoration preserves later wrappers and disables retained render/layout/control closures", () => {
	const f = fixture();
	const run = new Run({}, "restore"); run.expanded = true;
	f.document.addChild(host(run, 40));
	const selected = controlFor(run.owner);
	f.start(); scrollTo(f, 2);
	const prototype = Tui.TuiAltScreen.prototype as any;
	const render = prototype.doRender;
	const stop = prototype.stop;
	const update = f.scroll.updateLayout;
	let renders = 0;
	const laterRender = function(...args: unknown[]) { renders++; return render.apply(this, args); };
	const laterStop = function(...args: unknown[]) { return stop.apply(this, args); };
	const laterUpdate = function(...args: Parameters<typeof update>) { return update.apply(this, args); };
	prototype.doRender = laterRender; prototype.stop = laterStop; f.scroll.updateLayout = laterUpdate;
	try {
		const retained = selected.current!;
		restoreAggregateViewport();
		assert.equal(selected.current, undefined);
		assert.equal(prototype.doRender, laterRender);
		assert.equal(prototype.stop, laterStop);
		assert.equal(f.scroll.updateLayout, laterUpdate);
		retained.collapse(); f.paint();
		assert.equal(run.toggles, 0);
		assert.equal(selected.current, undefined);
		assert.equal(renders, 1);
		patchAggregateViewport(); f.paint();
		assert.equal(selected.current?.run.id, run.id, "reload discovers renderers through later wrappers");
	} finally {
		restoreAggregateViewport();
		// Test wrappers own these slots; remove them without depending on the adapter's internals.
		prototype.doRender = render; prototype.stop = stop; f.scroll.updateLayout = update;
	}
});

test("unsupported hook capabilities, regular mode and undiscovered receivers fall back locally", () => {
	const run = new Run({}, "fallback");
	const component = host(run);
	toggleAggregateViewportRun(component, run);
	assert.equal(run.toggles, 1, "no initial fullscreen frame is required to toggle");
	restoreAggregateViewport();
	const prototype = Tui.TuiAltScreen.prototype as any;
	const descriptor = Object.getOwnPropertyDescriptor(prototype, "doRender")!;
	try {
		prototype.doRender = undefined;
		patchAggregateViewport();
		toggleAggregateViewportRun(component, run);
		assert.equal(run.toggles, 2);
	} finally { Object.defineProperty(prototype, "doRender", descriptor); }
	patchAggregateViewport();
	const terminal = new AggregateTerminal();
	const regular = new Tui.TuiMainScreen(terminal, false);
	const selected = controlFor(run.owner);
	regular.addChild(component);
	try {
		regular.start(); regular.renderNow();
		toggleAggregateViewportRun(component, run); regular.renderNow();
		assert.equal(run.toggles, 3);
		assert.equal(selected.current, undefined);
	} finally { regular.stop({ preserveScreen: true }); }
});

test("clipped primary viewport uses its clipped top, not terminal zero or its offscreen origin", () => {
	const f = fixture();
	const run = new Run({}, "clipped"); run.expanded = true;
	f.document.addChild(new Rows(5)); f.document.addChild(host(run, 25)); f.document.addChild(new Rows(25));
	const outer = new Tui.ScrollView(new Tui.VStack([
		{ component: new Rows(3), basis: 3 },
		{ component: f.scroll, basis: 14 },
		{ component: new Rows(20), basis: 20 },
	]));
	f.renderer.setLayoutRoot(outer);
	const selected = controlFor(run.owner);
	f.start(); outer.scrollTo(5, { disableFollow: true }); scrollTo(f, 4);
	const viewport = f.native.currentLayout.root.children[0].children[1];
	assert.equal(viewport.rect.y, -2);
	assert.equal(viewport.clip.y, 0);
	assert.equal(selected.current?.run.id, run.id);
	selected.current!.collapse(); f.paint();
	assert.equal(f.scroll.scrollTop, 3, "header document row 5 minus clipped inset 2");
	assert.equal(transcriptLine(f, 0), run.label());
	assert.equal(selected.current, undefined);
});

test("allocated native leaf lineOffset and clipping delimit the painted run body", () => {
	const f = fixture();
	const run = new Run({}, "line-offset"); run.expanded = true;
	const component = new Host(run, () => ({
		lines: [...Array(17).fill("hidden leading rows"), run.label(), "body", `${Tui.CURSOR_MARKER}cursor`], titleRow: 17,
	}));
	const scroll = new Tui.ScrollView(new Tui.VStack([
		{ component, basis: 4 }, { component: new Rows(20, "outside ledger"), basis: 20 },
	]), { primary: true });
	f.renderer.setLayoutRoot(scroll);
	const selected = controlFor(run.owner);
	f.start();
	assert.equal(f.native.currentLayout.root.children[0].children[0].lineOffset, 16);
	assert.equal(f.lines()[1].trim(), run.label());
	assert.equal(selected.current, undefined);
	scroll.scrollTo(2, { disableFollow: true }); f.paint();
	assert.equal(selected.current?.run.id, run.id);
	scroll.scrollTo(4, { disableFollow: true }); f.paint();
	assert.equal(selected.current, undefined, "intrinsic hidden rows do not extend the allocated body");
});
