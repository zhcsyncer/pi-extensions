import assert from "node:assert/strict";
import test from "node:test";
import { InteractiveMode, initTheme } from "@earendil-works/pi-coding-agent";
import { Container, Text, stripTerminalSequences } from "@earendil-works/pi-tui";
import { AGGREGATE_COLLAPSE_WIDGET_KEY as KEY, retainAggregateWidgetPriority } from "../src/aggregate-widget-order.ts";

function host() {
	initTheme("dark", false);
	// Only shell state is supplied; insertion, replacement and composition use Pi's real methods.
	const mode = Object.assign(Object.create(InteractiveMode.prototype), {
		extensionWidgetsAbove: new Map(), extensionWidgetsBelow: new Map(),
		widgetContainerAbove: new Container(), widgetContainerBelow: new Container(),
		ui: { requestRender() {} },
	});
	const set = (key: string, text: string, placement: "aboveEditor" | "belowEditor" = "aboveEditor") =>
		mode.setExtensionWidget(key, () => new Text(text, 0, 0), { placement });
	const rows = (below = false): string[] => (below ? mode.widgetContainerBelow : mode.widgetContainerAbove)
		.render(80).map((line: string) => stripTerminalSequences(line).trim()).filter(Boolean);
	return { mode, set, rows };
}

test("collapse is first among above-editor widgets regardless of insertion and replacement order", () => {
	const { mode, set, rows } = host();
	const release = retainAggregateWidgetPriority();
	try {
		set("agent-progress", "Agent progress");
		set("status", "Status");
		set(KEY, "Collapse");
		assert.deepEqual(rows(), ["Collapse", "Agent progress", "Status"]);
		assert.deepEqual([...mode.extensionWidgetsAbove.keys()], ["agent-progress", "status", KEY], "do not rewrite other extensions' map order");
		set("agent-progress", "Agent updated");
		assert.deepEqual(rows(), ["Collapse", "Status", "Agent updated"]);
		mode.setExtensionWidget(KEY, undefined);
		assert.deepEqual(rows(), ["Status", "Agent updated"]);
		set(KEY, "Collapse again");
		assert.deepEqual(rows(), ["Collapse again", "Status", "Agent updated"]);
		set("later", "Later widget");
		assert.deepEqual(rows(), ["Collapse again", "Status", "Agent updated", "Later widget"]);
		set("below", "Below", "belowEditor");
		set(KEY, "Below collapse", "belowEditor");
		assert.deepEqual(rows(true), ["Below", "Below collapse"], "do not prioritize unrelated below-editor layout");
	} finally { release(); }
});

test("an old widget lease cannot remove a newer session's ordering", () => {
	const { mode, set, rows } = host();
	const oldRelease = retainAggregateWidgetPriority();
	const newRelease = retainAggregateWidgetPriority();
	try {
		set("other", "Other"); set(KEY, "Collapse");
		oldRelease(); oldRelease();
		mode.renderWidgets();
		assert.deepEqual(rows(), ["Collapse", "Other"]);
		newRelease();
		mode.renderWidgets();
		assert.deepEqual(rows(), ["Other", "Collapse"], "last release restores native insertion order");
	} finally { oldRelease(); newRelease(); }
});

test("an unavailable ordering capability is a no-op rather than losing the widget", () => {
	const prototype = InteractiveMode.prototype as unknown as { renderWidgetContainer?: unknown };
	const original = prototype.renderWidgetContainer;
	try {
		prototype.renderWidgetContainer = undefined;
		assert.doesNotThrow(() => retainAggregateWidgetPriority()());
	} finally { prototype.renderWidgetContainer = original; }
});
