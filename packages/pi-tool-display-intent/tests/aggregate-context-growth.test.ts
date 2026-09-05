import assert from "node:assert/strict";
import test from "node:test";
import { AssistantMessageComponent, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	AggregateProjection,
	patchAggregateToolExecutions,
	registerAggregateProjectionEvents,
	renderAggregateActivity,
	restoreAggregateToolExecutions,
} from "../src/aggregate-activity.ts";
import { patchAggregateThinkingPlaceholders, restoreAggregateThinkingPlaceholders } from "../src/aggregate-thinking-placeholder.ts";

const theme = { fg: (_: string, text: string) => text, bold: (text: string) => text };
const text = (value: string) => ({ type: "text", text: value });
const entry = (id: string, message: unknown) => ({ id, type: "message", message });
const user = entry("user", { role: "user", content: "request", timestamp: 1 });
function assistant(id: string, input: number, output: number, toolName?: string) {
	return {
		id, role: "assistant", provider: "test", api: "test-api", model: "test-model",
		timestamp: id === "a" ? 2 : 4,
		stopReason: toolName ? "toolUse" : "stop",
		content: toolName ? [{ type: "toolCall", id: "call-a", name: toolName, arguments: { path: "a.ts" } }] : [text("Final answer")],
		usage: { input, output, cacheRead: 500, cacheWrite: 0 },
	};
}
const result = {
	role: "toolResult", toolName: "read", toolCallId: "call-a", timestamp: 3,
	content: [text("x".repeat(400))],
	usage: { input: 90_000, output: 20_000, cacheRead: 0, cacheWrite: 0 },
};
function fixture() {
	const a = assistant("a", 1000, 20, "read");
	const b = assistant("b", 1600, 30);
	return { a, b, branch: [user, entry("a", a), entry("result", result), entry("b", b)] };
}
function projection(enabled: () => boolean = () => true, layout: () => "flat" | "turns" = () => "turns") {
	const value = new AggregateProjection((name) => name === "Agent", layout, enabled);
	value.setRenderTheme(theme);
	return value;
}
function clean(value: string) { return value.replace(/\x1b\[[0-9;]*m/g, "").replace(/[ \t]+$/gm, ""); }

test("reported request growth belongs to the preceding turn and final text contributes only once to the run", () => {
	const p = projection();
	const { b, branch } = fixture();
	const original = structuredClone(branch);
	p.rebuild(branch);
	const turn = p.renderExpandedToolRow("call-a", 120).join("\n");
	assert.match(turn, /↻ 1\/2 · 1 call · ctx \+600/);
	assert.equal((turn.match(/ctx/g) ?? []).length, 1);
	const view = p.getView("call-a")!;
	assert.deepEqual(view.contextGrowth, { tokens: 630, estimated: true });
	assert.match(renderAggregateActivity(view, 240, theme).join("\n"), /ctx ≈\+630 · tok/);
	assert.match(p.getAssistantContextLines(b, true).join("\n"), /↻ 2\/2 · ctx ≈\+30/);
	assert.deepEqual(branch, original, "measuring must not change the Session");
	p.rebuild(branch);
	assert.deepEqual(p.getView("call-a")!.contextGrowth, view.contextGrowth);
});

test("a live turn measures final branch messages, never provisional streaming usage", async () => {
	const p = projection();
	const handlers = new Map<string, (event: any, ctx?: any) => unknown>();
	const pi = { on(name: string, handler: (event: any, ctx?: any) => unknown) { handlers.set(name, handler); } } as unknown as ExtensionAPI;
	const { a, b } = fixture();
	const branch: unknown[] = [user];
	const ctx = { sessionManager: { getBranch: () => branch } };
	registerAggregateProjectionEvents(pi, p);
	try {
		p.rebuild(branch);
		await handlers.get("message_update")!({ message: a });
		assert.doesNotMatch(p.renderExpandedToolRow("call-a", 120).join("\n"), /ctx/);
		branch.push(entry("a", a), entry("result", result));
		await handlers.get("message_end")!({ message: result });
		await handlers.get("turn_end")!({ message: a, toolResults: [result] }, ctx);
		assert.match(p.renderExpandedToolRow("call-a", 120).join("\n"), /ctx ≈\+120/);

		await handlers.get("message_update")!({ message: { ...b, usage: { ...b.usage, input: 90_000 } } });
		assert.match(p.renderExpandedToolRow("call-a", 120).join("\n"), /ctx ≈\+120/);
		branch.push(entry("b", b));
		await handlers.get("turn_end")!({ message: b, toolResults: [] }, ctx);
		assert.match(p.renderExpandedToolRow("call-a", 120).join("\n"), /ctx \+600/);
		const live = p.getView("call-a")!.contextGrowth;
		p.rebuild(branch);
		assert.deepEqual(p.getView("call-a")!.contextGrowth, live);
	} finally {
		await handlers.get("session_shutdown")?.({ reason: "reload" });
		restoreAggregateToolExecutions();
	}
});

for (const [name, boundary] of [
	["steer", entry("steer", { role: "user", content: "also check this", timestamp: 3.5 })],
	["injection", entry("injection", { role: "custom", customType: "injected", content: "injected text" })],
	["persisted visible injection", { type: "custom_message", id: "injected", customType: "injected", content: "injected text", display: true }],
	["persisted hidden injection", { type: "custom_message", id: "injected", customType: "injected", content: "injected text", display: false }],
	["compaction", { type: "compaction", id: "compact", summary: "summary" }],
	["model", { type: "model_change", id: "model-change", modelId: "changed" }],
	["thinking", { type: "thinking_level_change", id: "thinking", thinkingLevel: "high" }],
] as const) {
	test(`${name} boundary is not charged as the preceding turn's measured growth`, () => {
		const p = projection();
		const { a, b } = fixture();
		p.rebuild([user, entry("a", a), entry("result", result), boundary, entry("b", b)]);
		assert.match(p.renderExpandedToolRow("call-a", 120).join("\n"), /ctx ≈\+120/);
		assert.match(renderAggregateActivity(p.getView("call-a")!, 240, theme).join("\n"), /ctx n\/a/);
	});
}

test("a finalized timestamp replacement reconciles the streamed turn and its existing tool members", () => {
	const p = projection();
	const a = { ...assistant("a", 1000, 20, "read"), id: undefined };
	const b = { ...assistant("b", 1600, 30), id: undefined };
	p.rebuild([user]);
	p.ingestAssistantMessage(a);
	p.ingestToolResult(result);
	// Pi applies later message_end replacements to the original object in place.
	a.timestamp = 20;
	const branch = [user, entry("a", a), entry("result", result)];
	p.finishContextTurn(a, [result], branch);
	branch.push(entry("b", b));
	p.finishContextTurn(b, [], branch);
	const live = p.getView("call-a")!;
	assert.equal(live.agentTurnCount, 2);
	assert.deepEqual(live.contextGrowth, { tokens: 630, estimated: true });
	assert.match(p.renderExpandedToolRow("call-a", 120).join("\n"), /↻ 1\/2 · 1 call · ctx \+600/);
	p.rebuild(branch);
	assert.deepEqual(p.getView("call-a")!.contextGrowth, live.contextGrowth);
	assert.equal(p.getView("call-a")!.agentTurnCount, live.agentTurnCount);
});

test("changes outside a completed run do not invalidate that run's own growth", () => {
	const p = projection();
	const { branch } = fixture();
	p.rebuild([
		...branch,
		{ type: "model_change", id: "later-model", modelId: "new-model" },
		entry("new-user", { role: "user", content: "another request", timestamp: 10 }),
		entry("c", { ...assistant("c", 4000, 50), timestamp: 11, model: "new-model" }),
	]);
	assert.deepEqual(p.getView("call-a")!.contextGrowth, { tokens: 630, estimated: true });
});

test("toggle and flat layout only change presentation, not accumulated measurements", () => {
	let enabled = false;
	let layout: "flat" | "turns" = "turns";
	const p = projection(() => enabled, () => layout);
	const { b, branch } = fixture();
	p.rebuild(branch);
	assert.doesNotMatch(p.renderExpandedToolRow("call-a", 120).join("\n"), /ctx/);
	assert.deepEqual(p.getAssistantContextLines(b, true), []);
	assert.equal(p.getView("call-a")!.contextGrowth, undefined);
	enabled = true;
	assert.match(p.renderExpandedToolRow("call-a", 120).join("\n"), /ctx \+600/);
	layout = "flat";
	assert.doesNotMatch(p.renderExpandedToolRow("call-a", 120).join("\n"), /ctx|↻/);
	assert.deepEqual(p.getAssistantContextLines(b, true), []);
	assert.deepEqual(p.getView("call-a")!.contextGrowth, { tokens: 630, estimated: true });
});

test("final text receives a bounded expanded turn footer without changing its answer", () => {
	initTheme("dark", false);
	let enabled = true;
	const p = projection(() => enabled);
	const { b, branch } = fixture();
	p.rebuild(branch);
	patchAggregateToolExecutions(p);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		const component = new AssistantMessageComponent(b as never, true);
		assert.doesNotMatch(component.render(100).join("\n"), /ctx/);
		(component as unknown as { setExpanded(value: boolean): void }).setExpanded(true);
		const lines = component.render(100);
		assert.match(clean(lines.join("\n")), /Final answer\n  ↻ 2\/2 · ctx ≈\+30/);
		assert.equal((clean(lines.join("\n")).match(/ctx/g) ?? []).length, 1);
		assert.ok(component.render(20).every((line) => visibleWidth(line) <= 20));
		enabled = false;
		assert.doesNotMatch(component.render(100).join("\n"), /ctx/);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("a newly created final answer inherits an already expanded transcript", () => {
	initTheme("dark", false);
	const p = projection();
	const { a, b, branch } = fixture();
	p.rebuild(branch);
	patchAggregateToolExecutions(p);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		const existing = new AssistantMessageComponent(a as never, true);
		(existing as unknown as { setExpanded(value: boolean): void }).setExpanded(true);
		// Pi creates streaming assistant components without calling setExpanded.
		const created = new AssistantMessageComponent(b as never, true);
		assert.match(clean(created.render(100).join("\n")), /↻ 2\/2 · ctx ≈\+30/);
		(existing as unknown as { setExpanded(value: boolean): void }).setExpanded(false);
		assert.doesNotMatch(created.render(100).join("\n"), /ctx/);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("passthrough-only and text-only turns can show context without manufacturing a Tools frame", () => {
	const p = projection();
	const a = assistant("a", 1000, 20, "Agent");
	const b = assistant("b", 1600, 30);
	p.rebuild([user, entry("a", a), entry("result", { ...result, toolName: "Agent" }), entry("b", b)]);
	assert.equal(p.getView("call-a"), undefined);
	assert.match(p.getAssistantContextLines(a, true).join("\n"), /↻ 1\/2 · 1 call · ctx \+600/);
	assert.match(p.getAssistantContextLines(b, false).join("\n"), /^ctx ≈\+630$/);
	p.rebuild([user, entry("b", b)]);
	assert.deepEqual(p.getAssistantContextLines(b, false), ["ctx ≈+30"]);
	assert.deepEqual(p.getAssistantContextLines(b, true), ["↻ 1/1 · ctx ≈+30"]);
});
