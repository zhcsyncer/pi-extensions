import assert from "node:assert/strict";
import test from "node:test";
import { AggregateProjection, formatAggregateTarget, renderAggregateMemberRow } from "../src/aggregate-activity.ts";
import { setAggregateCallPresentationLookup } from "../src/call-presentation-registry.ts";

const theme = { fg: (_: string, value: string) => value };
function recorded(args: Record<string, unknown>, details: Record<string, unknown> = {}, isError = false) {
	const p = new AggregateProjection();
	const result = { role: "toolResult", toolCallId: "agent-call", toolName: "Agent", isError, details,
		content: [{ type: "text", text: isError || details.status === "error" || details.status === "stopped" ? "Task did not finish" : "tool receipt" }] };
	p.rebuild([
		{ type: "message", id: "user", message: { role: "user", content: "request" } },
		{ type: "message", id: "assistant", message: { role: "assistant", stopReason: "toolUse", content: [
			{ type: "toolCall", id: "agent-call", name: "Agent", arguments: args },
		] } },
		{ type: "message", id: "result", message: result },
	]);
	return { p, result, lines: () => renderAggregateMemberRow(p.getMember("agent-call")!, 100, theme).join("\n") };
}

test("Agent target contains only the agent type and short task, with prompt and flags in details", () => {
	assert.equal(formatAggregateTarget({ toolName: "Agent", args: {
		prompt: "PRIVATE_LONG_PROMPT".repeat(500), description: "检查账本交互", subagent_type: "Explore", run_in_background: true, inherit_context: true,
	} }), "Agent(Explore · 检查账本交互)");
	assert.equal(formatAggregateTarget({ toolName: "Agent", args: { resume: "task-123", description: "继续检查", prompt: "more instructions" } }), "Agent(resume · 继续检查)");
	assert.equal(formatAggregateTarget({ toolName: "Agent", args: { resume: "task-123", prompt: "more instructions" } }), "Agent(resume · task-123)");
	assert.equal(formatAggregateTarget({ toolName: "Agent", args: { prompt: "instructions" } }), "Agent");
});

test("explicit call presentation still wins over the built-in Agent short target", () => {
	setAggregateCallPresentationLookup((name) => name === "Agent" ? { target: "Custom task title" } : undefined);
	try { assert.equal(formatAggregateTarget({ toolName: "Agent", args: { description: "ignored", subagent_type: "Explore" } }), "Agent(Custom task title)"); }
	finally { setAggregateCallPresentationLookup(undefined); }
});

test("background receipts do not claim child completion, including mode resolved outside call arguments", () => {
	const { lines, result } = recorded({ description: "Inspect", subagent_type: "Explore", run_in_background: false }, { status: "background" });
	assert.match(lines(), /↗ Agent\(Explore · Inspect\).*dispatched/);
	assert.doesNotMatch(lines(), /✓|completed/);
	result.details.status = "completed";
	assert.match(lines(), /dispatched/, "the receipt is not a second live child status feed");
});

test("completed foreground and resume results override the requested background flag", () => {
	for (const args of [{ run_in_background: true }, { run_in_background: true, resume: "old-task" }]) {
		const { lines } = recorded({ ...args, description: "Review", subagent_type: "Plan" }, { status: "completed" });
		assert.match(lines(), /✓ Agent/);
		assert.doesNotMatch(lines(), /dispatched/);
	}
});

test("queued and scheduled receipts are visibly distinct from completed work", () => {
	assert.match(recorded({ description: "Inspect" }, { status: "queued" }).lines(), /◷ Agent.*queued/);
	assert.match(recorded({ description: "Inspect", schedule: "every hour" }).lines(), /◷ Agent.*scheduled/);
});

test("unknown legacy receipts are conservative instead of claiming task completion", () => {
	assert.match(recorded({ description: "Inspect" }).lines(), /↗ Agent.*returned/);
	assert.match(recorded({ description: "Inspect", run_in_background: true }).lines(), /↗ Agent.*dispatched/);
});

test("dispatch errors and explicit failed task receipts remain failures rather than successful dispatch", () => {
	for (const [status, error] of [["background", true], ["error", false], ["stopped", false]] as const) {
		const { p, lines } = recorded({ description: "Inspect", run_in_background: true }, { status }, error);
		assert.match(lines(), /! Agent/);
		assert.doesNotMatch(lines(), /✓|↗|dispatched/);
		assert.equal(p.getView("agent-call")?.failedCount, 1);
	}
});
