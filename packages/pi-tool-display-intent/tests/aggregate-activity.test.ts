import assert from "node:assert/strict";
import test from "node:test";
import {
	initTheme,
	ToolExecutionComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	AggregateProjection,
	DEFAULT_AGGREGATE_RENDER_PASSTHROUGH,
	formatAggregateClock,
	formatAggregateTarget,
	getActiveAggregateProjection,
	normalizeAssistantNarration,
	patchAggregateToolExecutions,
	registerAggregateProjectionEvents,
	renderAggregateActivity,
	renderAggregateMemberRow,
	renderCollapsedAssistantNarration,
	renderExpandedAggregateSteer,
	restoreAggregateToolExecutions,
} from "../src/aggregate-activity.ts";

function userEntry(id: string, text = "request") {
	return {
		type: "message",
		id,
		message: { role: "user", content: text, timestamp: 1 },
	};
}

function assistantEntry(
	id: string,
	calls: Array<{ id: string; name: string; arguments: Record<string, unknown> }>,
	overrides: Record<string, unknown> = {},
) {
	return {
		type: "message",
		id,
		message: {
			role: "assistant",
			content: calls.map((call) => ({ type: "toolCall", ...call })),
			stopReason: "toolUse",
			...overrides,
		},
	};
}

function resultEntry(
	id: string,
	toolCallId: string,
	toolName: string,
	options: { text?: string; isError?: boolean; image?: boolean } = {},
) {
	return {
		type: "message",
		id,
		message: {
			role: "toolResult",
			toolCallId,
			toolName,
			content: options.image
				? [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }]
				: [{ type: "text", text: options.text ?? "ok" }],
			isError: options.isError ?? false,
		},
	};
}

function messages(entries: unknown[]): unknown[] {
	return entries
		.map((entry) => (entry as { message?: unknown }).message)
		.filter((message) => message !== undefined);
}

function createProjection(): AggregateProjection {
	return new AggregateProjection((toolName) =>
		(DEFAULT_AGGREGATE_RENDER_PASSTHROUGH as readonly string[]).includes(toolName));
}

function call(id: string, name: string, args: Record<string, unknown> = {}) {
	return { id, name, arguments: args };
}

function plainTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function visibleText(value: string): string {
	return value.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "").replace(/\x1b\[[0-9;]*[a-zA-Z]/g, "");
}

function createTool(name: string, callText = `ORIGINAL ${name}`, resultText = `RESULT ${name}`) {
	return {
		name,
		label: name,
		description: name,
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		renderShell: "self",
		renderCall: () => new Text(callText, 0, 0),
		renderResult: () => new Text(resultText, 0, 0),
	};
}

function createComponent(
	name: string,
	id: string,
	args: Record<string, unknown>,
	tool: unknown = createTool(name),
): ToolExecutionComponent {
	return new ToolExecutionComponent(
		name,
		id,
		args,
		{},
		tool as never,
		{ requestRender() {} } as never,
		process.cwd(),
	);
}

test("rebuild counts every built-in and custom call in one user-turn Tools summary", () => {
	const projection = createProjection();
	const branch = [
		userEntry("user-1"),
		assistantEntry("assistant-1", [
			call("read-1", "read", { path: "src/a.ts" }),
			call("ask-1", "ask_user_question", { questions: [] }),
		]),
		resultEntry("result-1", "read-1", "read"),
		resultEntry("result-2", "ask-1", "ask_user_question"),
		assistantEntry("assistant-2", [
			call("ls-1", "ls", { path: "src" }),
			call("bash-1", "bash", { command: "pnpm test" }),
		]),
		resultEntry("result-3", "ls-1", "ls"),
		resultEntry("result-4", "bash-1", "bash"),
	];
	projection.rebuild(branch, messages(branch));

	const view = projection.getView("bash-1");
	assert.deepEqual(view?.toolSummaries.map(({ toolName, count }) => ({ toolName, count })), [
		{ toolName: "read", count: 1 },
		{ toolName: "ask_user_question", count: 1 },
		{ toolName: "ls", count: 1 },
		{ toolName: "bash", count: 1 },
	]);
	assert.deepEqual(view?.displayRows, [], "restored history does not recreate transient done rows");
	assert.equal("modifiedFiles" in (view ?? {}), false);
	assert.equal("diffStats" in (view ?? {}), false);
});

test("call counts include running, failed, successful, and passthrough tools", () => {
	const projection = createProjection();
	projection.startUserGroup("user-counts");
	projection.markStarted("read-1", "read", { path: "a.ts" });
	projection.markComplete("read-1", { content: [{ type: "text", text: "ok" }] }, false);
	projection.markStarted("custom-1", "custom_probe", { query: "alpha" });
	projection.markFailed("custom-1", "failed");
	projection.markStarted("agent-1", "Agent", { prompt: "review" });

	const view = projection.getView("custom-1");
	assert.deepEqual(view?.toolSummaries.map(({ toolName, count }) => ({ toolName, count })), [
		{ toolName: "read", count: 1 },
		{ toolName: "custom_probe", count: 1 },
		{ toolName: "Agent", count: 1 },
	]);
	assert.equal(view?.failedCount, 1);
	assert.equal(view?.hasRunning, true);
});

test("Agent stays renderer-passthrough but remains in counts and never steals the leader", () => {
	const projection = createProjection();
	projection.startUserGroup("user-agent");
	projection.markStarted("read-1", "read", { path: "a.ts" });
	projection.markComplete("read-1", { content: [{ type: "text", text: "ok" }] }, false);
	projection.markStarted("agent-1", "Agent", { prompt: "review" });

	assert.equal(projection.getGroups()[0]?.leaderToolCallId, "read-1");
	assert.equal(projection.getView("Agent"), undefined);
	assert.deepEqual(projection.getView("read-1")?.toolSummaries.map(({ toolName }) => toolName), ["read", "Agent"]);

	projection.markStarted("bash-1", "bash", { command: "pnpm test" });
	assert.equal(projection.getGroups()[0]?.leaderToolCallId, "bash-1");
});

test("parallel running rows have priority and done rows are replaceable and bounded", () => {
	const projection = createProjection();
	projection.startUserGroup("user-parallel");
	for (const index of [1, 2, 3, 4]) {
		projection.markStarted(`tool-${index}`, `custom_${index}`, { value: index });
	}
	assert.deepEqual(
		projection.getView("tool-4")?.displayRows.map((member) => member.toolCallId),
		["tool-1", "tool-2", "tool-3"],
	);
	assert.equal(projection.getView("tool-4")?.activeOverflow, 1);

	projection.markComplete("tool-1", { content: [{ type: "text", text: "ok" }] }, false);
	assert.deepEqual(
		projection.getView("tool-4")?.displayRows.map((member) => member.toolCallId),
		["tool-2", "tool-3", "tool-4"],
	);
	for (const index of [2, 3, 4]) {
		projection.markComplete(`tool-${index}`, { content: [{ type: "text", text: "ok" }] }, false);
	}
	assert.deepEqual(
		projection.getView("tool-4")?.displayRows.map((member) => member.toolCallId),
		["tool-2", "tool-3", "tool-4"],
	);
});

test("in-progress Tools ledger pins the latest narration above the tool rows", () => {
	const projection = createProjection();
	projection.startUserGroup("user-narration-budget");
	projection.ingestAssistantMessage({
		role: "assistant",
		id: "assistant-1",
		stopReason: "toolUse",
		content: [{ type: "text", text: "先定位两边的设计与实现入口" }],
	});
	for (const index of [1, 2, 3, 4]) {
		projection.markStarted(`tool-${index}`, `custom_${index}`, { value: index });
	}
	const view = projection.getView("tool-4");
	assert.equal(view?.latestNarration, "先定位两边的设计与实现入口");
	assert.equal(view?.callCount, 4);
	assert.equal(view?.agentTurnCount, 1);
	assert.equal(view?.settled, false);
	assert.deepEqual(view?.displayRows.map((member) => member.toolCallId), ["tool-1", "tool-2", "tool-3"]);
	const rendered = renderAggregateActivity(view!, 120, plainTheme());
	assert.match(rendered.join("\n"), /Tools \(4 calls · 1 turn\)/);
	assert.match(rendered.join("\n"), /custom_1/);
	assert.match(rendered.join("\n"), /› 先定位两边的设计与实现入口/);
	assert.ok(
		rendered.findIndex((line) => line.includes("先定位两边的设计与实现入口"))
			< rendered.findIndex((line) => /◐ custom_1(?:\s|$)/.test(line)),
	);
	const wrapped = renderAggregateActivity({
		...view!,
		latestNarration: "先定位两边的设计与实现入口，再对照分组、渲染、状态和边界。",
	}, 24, plainTheme());
	assert.ok(wrapped.filter((line) => /先定位|再对照|分组|渲染/.test(line)).length >= 2);
});

test("collapsed narration keeps markdown source and renders inline styles", () => {
	initTheme("dark", false);
	const projection = createProjection();
	projection.startUserGroup("user-narration-markdown");
	projection.ingestAssistantMessage({
		role: "assistant",
		id: "assistant-md",
		stopReason: "toolUse",
		content: [
			{ type: "text", text: "先对照 **两边入口** 和 `src/index.ts`" },
			{ type: "toolCall", ...call("read-md", "read", { path: "src/index.ts" }) },
		],
	});
	projection.markStarted("read-md", "read", { path: "src/index.ts" });
	const view = projection.getView("read-md");
	assert.equal(view?.latestNarration, "先对照 **两边入口** 和 `src/index.ts`");
	const rendered = visibleText(renderAggregateActivity(view!, 120, plainTheme()).join("\n"));
	assert.match(rendered, /› 先对照 两边入口 和 src\/index\.ts/);
	assert.doesNotMatch(rendered, /\*\*|`/);
});

test("collapsed narration markdown stays within the three-row pin", () => {
	initTheme("dark", false);
	const rendered = renderCollapsedAssistantNarration(
		["# 入口", "", "- 一边", "- 另一边", "- 还要第三项", "- 不应出现"].join("\n"),
		80,
		plainTheme(),
	);
	assert.ok(rendered.length > 0 && rendered.length <= 3);
	assert.match(visibleText(rendered.join("\n")), /入口/);
	assert.doesNotMatch(visibleText(rendered.join("\n")), /不应出现/);
});

test("normalizeAssistantNarration keeps markdown structure and drops control noise", () => {
	assert.equal(
		normalizeAssistantNarration("先对照 **两边入口**\u0007\n\n`src/index.ts`"),
		"先对照 **两边入口**\n\n`src/index.ts`",
	);
	assert.equal(normalizeAssistantNarration("   \n\n  "), undefined);
});

test("settled Tools ledger shows duration, tokens, cache, and completion time under the header", () => {
	const startedAt = Date.parse("2026-04-08T14:30:00");
	const endedAt = Date.parse("2026-04-08T14:32:14");
	const projection = createProjection();
	const branch = [
		{
			type: "message",
			id: "user-stats",
			timestamp: startedAt,
			message: { role: "user", content: "request", timestamp: startedAt },
		},
		{
			type: "message",
			id: "assistant-stats",
			timestamp: endedAt,
			message: {
				role: "assistant",
				content: [{ type: "toolCall", ...call("read-stats", "read", { path: "a.ts" }) }],
				stopReason: "toolUse",
				timestamp: endedAt,
				usage: { input: 62_000, output: 8_400, cacheRead: 120_000, cacheWrite: 4_100 },
			},
		},
		{
			type: "message",
			id: "result-stats",
			timestamp: endedAt,
			message: {
				role: "toolResult",
				toolCallId: "read-stats",
				toolName: "read",
				content: [{ type: "text", text: "ok" }],
				isError: false,
				timestamp: endedAt,
			},
		},
	];
	projection.rebuild(branch, messages(branch));
	const view = projection.getView("read-stats");
	assert.equal(view?.settled, true);
	assert.equal(view?.durationMs, endedAt - startedAt);
	assert.deepEqual(view?.usage, {
		input: 62_000,
		output: 8_400,
		cacheRead: 120_000,
		cacheWrite: 4_100,
	});
	const rendered = renderAggregateActivity(view!, 120, plainTheme());
	assert.match(rendered[0] ?? "", /Tools \(1 call · 1 turn\)/);
	assert.equal(rendered[1], `  took 2m14s · tok ↑62k ↓8.4k R120k W4.1k · at ${formatAggregateClock(endedAt)}`);
	assert.doesNotMatch(rendered.join("\n"), /›/);
});

test("a steered user message stays on the same Tools ledger", () => {
	const startedAt = Date.parse("2026-04-08T14:30:00");
	const steeredAt = Date.parse("2026-04-08T14:31:20");
	const projection = createProjection();
	projection.startUserGroup("user-before-steer", startedAt);
	projection.ingestAssistantMessage({
		role: "assistant",
		id: "assistant-before-steer",
		stopReason: "toolUse",
		timestamp: startedAt + 20_000,
		content: [
			{ type: "text", text: "合并已完成。接下来按 AGENTS.md 审视受影响包的用户可见 README：只留来源差异、功能和用法。" },
			{ type: "toolCall", ...call("read-before-steer", "read", { path: "README.md" }) },
		],
		usage: { input: 1_200, output: 80, cacheRead: 0, cacheWrite: 0 },
	});
	projection.markStarted("read-before-steer", "read", { path: "README.md" });
	const live = projection.getView("read-before-steer");
	assert.equal(live?.settled, false);
	assert.equal(live?.failedCount, 0);
	assert.match(renderAggregateActivity(live!, 160, plainTheme()).join("\n"), /› 合并已完成/);

	const kind = projection.ingestUserMessage({
		role: "user",
		content: "先确定方案",
		timestamp: steeredAt,
	}, { streamingBehavior: "steer" });
	assert.equal(kind, "steer");
	const same = projection.getView("read-before-steer");
	assert.equal(same?.settled, false);
	assert.equal(same?.failedCount, 0);
	assert.equal(same?.steerCount, 1);
	assert.equal(same?.groupId, live?.groupId);
	assert.equal(same?.hasRunning, true);
	const rendered = renderAggregateActivity(same!, 160, plainTheme());
	assert.match(rendered[0] ?? "", /Tools \(1 call · 1 turn · 1 steer\)/);
	assert.match(rendered.join("\n"), /↳ 先确定方案/);
	assert.match(rendered.join("\n"), /› 合并已完成/);
	assert.ok(
		rendered.findIndex((line) => line.includes("↳"))
			< rendered.findIndex((line) => line.includes("›")),
	);
	assert.doesNotMatch(rendered.join("\n"), /took /);
});

test("multiple steers pin first lines in arrival order", () => {
	const projection = createProjection();
	projection.startUserGroup("user-multi-steer");
	projection.ingestAssistantMessage({
		role: "assistant",
		id: "assistant-multi-steer",
		stopReason: "toolUse",
		content: [
			{ type: "text", text: "正在按新约束改 README" },
			{ type: "toolCall", ...call("edit-multi", "edit", { path: "README.md" }) },
		],
	});
	projection.markStarted("edit-multi", "edit", { path: "README.md" });
	projection.ingestUserMessage({
		role: "user",
		content: "先确定方案\n后面还有一段不应钉住",
		timestamp: 2,
	});
	projection.ingestUserMessage({
		role: "user",
		content: "不要改 grok，用 xai",
		timestamp: 3,
	});
	const view = projection.getView("edit-multi");
	assert.equal(view?.steerCount, 2);
	assert.deepEqual(view?.pinnedSteers.map((steer) => steer.firstLine), [
		"先确定方案",
		"不要改 grok，用 xai",
	]);
	const rendered = renderAggregateActivity(view!, 80, plainTheme());
	assert.match(rendered[0] ?? "", /· 2 steers\)/);
	const pinLines = rendered.filter((line) => line.includes("↳"));
	assert.equal(pinLines.length, 2);
	assert.match(pinLines[0] ?? "", /↳ 先确定方案/);
	assert.doesNotMatch(pinLines[0] ?? "", /不应钉住/);
	assert.match(pinLines[1] ?? "", /↳ 不要改 grok，用 xai/);
	assert.ok(
		rendered.findIndex((line) => line.includes("先确定方案"))
			< rendered.findIndex((line) => line.includes("正在按新约束改 README")),
	);
});

test("settling replaces first-line pins with one steer reminder", () => {
	const startedAt = Date.parse("2026-04-08T14:30:00");
	const endedAt = Date.parse("2026-04-08T14:32:14");
	const projection = createProjection();
	projection.startUserGroup("user-settle-steers", startedAt);
	projection.ingestAssistantMessage({
		role: "assistant",
		id: "assistant-settle-steers",
		stopReason: "toolUse",
		timestamp: startedAt + 1_000,
		content: [{ type: "toolCall", ...call("read-settle-steers", "read", { path: "a.ts" }) }],
	});
	projection.markStarted("read-settle-steers", "read", { path: "a.ts" });
	projection.ingestUserMessage({
		role: "user",
		content: "先确定方案",
		timestamp: startedAt + 2_000,
	});
	projection.ingestUserMessage({
		role: "user",
		content: "不要改 grok，用 xai",
		timestamp: startedAt + 3_000,
	});
	projection.markComplete("read-settle-steers", { content: [{ type: "text", text: "ok" }] }, false);
	projection.markGroupSettled("user-settle-steers", endedAt);
	const view = projection.getView("read-settle-steers");
	assert.equal(view?.settled, true);
	assert.equal(view?.steerCount, 2);
	assert.deepEqual(view?.pinnedSteers, []);
	assert.equal(view?.durationMs, endedAt - startedAt);
	const rendered = renderAggregateActivity(view!, 160, plainTheme());
	assert.match(rendered[0] ?? "", /Tools \(1 call · 1 turn · 2 steers\)/);
	assert.equal(rendered[1], "  ↳ 2 steers");
	assert.doesNotMatch(rendered.join("\n"), /先确定方案|不要改 grok/);
	assert.match(rendered.join("\n"), /took 2m14s/);
	assert.ok(
		rendered.findIndex((line) => line.includes("↳ 2 steers"))
			< rendered.findIndex((line) => line.includes("took 2m14s")),
	);
});

test("expanded steer rows highlight the first line and keep framed gaps", () => {
	const rendered = renderExpandedAggregateSteer("先确定方案\n后面还有一段", 80, {
		fg: (color, text) => color === "accent" ? `[accent]${text}` : text,
	});
	assert.equal(rendered.length, 4);
	assert.match(rendered[0] ?? "", /│\s*$/);
	assert.match(rendered[1] ?? "", /│.*\[accent\]↳ 先确定方案/);
	assert.match(rendered[2] ?? "", /│.*后面还有一段/);
	assert.doesNotMatch(rendered[2] ?? "", /\[accent\]/);
	assert.match(rendered[3] ?? "", /[│└]\s*$/);
});

test("a follow-up after a final assistant starts a new Tools group", () => {
	const projection = createProjection();
	projection.startUserGroup("user-original");
	projection.ingestAssistantMessage({
		role: "assistant",
		id: "assistant-original",
		stopReason: "toolUse",
		content: [{ type: "toolCall", ...call("read-original", "read", { path: "a.ts" }) }],
	});
	projection.markStarted("read-original", "read", { path: "a.ts" });
	projection.markComplete("read-original", { content: [{ type: "text", text: "ok" }] }, false);
	projection.ingestAssistantMessage({
		role: "assistant",
		id: "assistant-final",
		stopReason: "stop",
		content: [{ type: "text", text: "做完了" }],
	});
	assert.equal(projection.getView("read-original")?.settled, true);

	const kind = projection.ingestUserMessage({
		role: "user",
		content: "再帮我改测试",
		timestamp: 9,
	});
	assert.equal(kind, "group");
	projection.ingestAssistantMessage({
		role: "assistant",
		id: "assistant-follow-up",
		stopReason: "toolUse",
		content: [{ type: "toolCall", ...call("edit-follow-up", "edit", { path: "a.ts" }) }],
	});
	const original = projection.getView("read-original");
	const followUp = projection.getView("edit-follow-up");
	assert.equal(original?.steerCount, 0);
	assert.equal(original?.callCount, 1);
	assert.notEqual(followUp?.groupId, original?.groupId);
	assert.equal(followUp?.callCount, 1);
	assert.equal(followUp?.steerCount, 0);
});

test("rebuild treats a user after toolResult as a steer on the same group", () => {
	const projection = createProjection();
	const branch = [
		userEntry("user-1", "原始任务"),
		assistantEntry("assistant-1", [call("read-1", "read", { path: "a.ts" })]),
		resultEntry("result-1", "read-1", "read"),
		userEntry("user-steer", "先确定方案"),
		assistantEntry("assistant-2", [call("edit-1", "edit", { path: "a.ts" })]),
		resultEntry("result-2", "edit-1", "edit"),
	];
	projection.rebuild(branch, messages(branch));
	const view = projection.getView("edit-1");
	assert.equal(view?.callCount, 2);
	assert.equal(view?.steerCount, 1);
	assert.equal(view?.agentTurnCount, 2);
	assert.equal(projection.getGroups().length, 1);
	assert.equal(projection.getSteer("steer:user-1:0")?.firstLine, "先确定方案");
	assert.match(renderAggregateActivity(view!, 120, plainTheme())[0] ?? "", /· 1 steer\)/);
});

test("rebuild keeps a follow-up after a final assistant on a new group", () => {
	const projection = createProjection();
	const branch = [
		userEntry("user-1", "原始任务"),
		assistantEntry("assistant-1", [call("read-1", "read", { path: "a.ts" })]),
		resultEntry("result-1", "read-1", "read"),
		{
			type: "message",
			id: "assistant-final",
			message: {
				role: "assistant",
				id: "assistant-final",
				stopReason: "stop",
				content: [{ type: "text", text: "做完了" }],
			},
		},
		userEntry("user-2", "再改测试"),
		assistantEntry("assistant-2", [call("edit-1", "edit", { path: "a.ts" })]),
		resultEntry("result-2", "edit-1", "edit"),
	];
	projection.rebuild(branch, messages(branch));
	assert.equal(projection.getGroups().length, 2);
	assert.equal(projection.getView("read-1")?.steerCount, 0);
	assert.equal(projection.getView("edit-1")?.steerCount, 0);
	assert.notEqual(projection.getView("read-1")?.groupId, projection.getView("edit-1")?.groupId);
});

test("custom messages do not open a group or count as steers", () => {
	const projection = createProjection();
	const branch = [
		userEntry("user-1", "原始任务"),
		assistantEntry("assistant-1", [call("read-1", "read", { path: "a.ts" })]),
		resultEntry("result-1", "read-1", "read"),
		{
			type: "custom_message",
			id: "custom-1",
			customType: "subagent-notification",
			message: { role: "custom", content: "child done", timestamp: 2 },
		},
		userEntry("user-steer", "先确定方案"),
	];
	projection.rebuild(branch, messages(branch));
	assert.equal(projection.ingestUserMessage({ role: "custom", content: "child done" }), undefined);
	assert.equal(projection.getGroups().length, 1);
	assert.equal(projection.getView("read-1")?.steerCount, 1);
});

test("a new passthrough call still replaces the oldest retained done row", () => {
	const projection = createProjection();
	projection.startUserGroup("user-agent-replace");
	projection.markStarted("read-1", "read", { path: "a.ts" });
	projection.markComplete("read-1", { content: [{ type: "text", text: "ok" }] }, false);
	assert.equal(projection.getMember("read-1")?.retainedDone, true);
	projection.markStarted("agent-1", "Agent", { prompt: "review" });
	assert.equal(projection.getMember("read-1")?.retainedDone, false);
});

test("agent settled folds done rows after grace while failures remain", async () => {
	const projection = createProjection();
	const handlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
	const api = {
		on(event: string, handler: (event: any, ctx?: any) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	registerAggregateProjectionEvents(api, projection, { doneSettleDelayMs: 10 });
	try {
		projection.startUserGroup("user-settle");
		projection.markStarted("custom-done", "custom_probe", {});
		projection.markComplete("custom-done", { content: [{ type: "text", text: "ok" }] }, false);
		await handlers.get("agent_settled")?.[0]?.({});
		assert.equal(projection.getView("custom-done")?.displayRows.length, 1);
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.deepEqual(projection.getView("custom-done")?.displayRows, []);

		projection.startUserGroup("user-failed");
		projection.markStarted("custom-failed", "custom_probe", {});
		projection.markFailed("custom-failed", "failed");
		await handlers.get("agent_settled")?.[0]?.({});
		await new Promise((resolve) => setTimeout(resolve, 25));
		assert.equal(projection.getView("custom-failed")?.failed.length, 1);
	} finally {
		await handlers.get("session_shutdown")?.[0]?.({ reason: "reload" });
		restoreAggregateToolExecutions();
	}
});

test("event registration never appends file or diff statistics to the Session", async () => {
	const projection = createProjection();
	const handlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
	const appended: unknown[] = [];
	const api = {
		on(event: string, handler: (event: any, ctx?: any) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(...args: unknown[]) {
			appended.push(args);
		},
	} as unknown as ExtensionAPI;
	registerAggregateProjectionEvents(api, projection);
	try {
		projection.startUserGroup("user-write");
		projection.markStarted("write-1", "write", { path: "a.ts", content: "new" });
		await handlers.get("tool_execution_end")?.[0]?.({
			toolCallId: "write-1",
			toolName: "write",
			result: { content: [{ type: "text", text: "ok" }], details: { patch: "-old\n+new" } },
			isError: false,
		});
		assert.deepEqual(appended, []);
	} finally {
		await handlers.get("session_shutdown")?.[0]?.({ reason: "reload" });
		restoreAggregateToolExecutions();
	}
});

test("rendered Tools header keeps failed first and treats every tool uniformly", () => {
	const projection = createProjection();
	projection.startUserGroup("user-render-summary");
	projection.markStarted("read-1", "read", { path: "a.ts" });
	projection.markComplete("read-1", { content: [{ type: "text", text: "ok" }] }, false);
	projection.markStarted("edit-1", "edit", { path: "a.ts", edits: [] });
	projection.markComplete("edit-1", { content: [{ type: "text", text: "ok" }], details: { patch: "+new" } }, false);
	projection.markStarted("custom-1", "custom_probe", {});
	projection.markFailed("custom-1", "network exploded");
	const view = projection.getView("custom-1");
	assert.ok(view);
	const rendered = renderAggregateActivity(view, 500, plainTheme()).join("\n");
	assert.match(rendered, /^! Tools \(3 calls · 1 turn\) · 1 failed · read ×1 · edit ×1 · custom_probe ×1/m);
	assert.doesNotMatch(rendered, /network exploded/);
	const failed = projection.getMember("custom-1");
	assert.ok(failed);
	assert.match(renderAggregateMemberRow(failed, 500, plainTheme()).join("\n"), /network exploded/);
	assert.doesNotMatch(rendered, /files|Changes|\+\d|−\d/);
});

test("expanded tool rows leave the Tools ledger and show one summary per call", () => {
	initTheme("dark", false);
	const projection = createProjection();
	patchAggregateToolExecutions(projection);
	try {
		projection.startUserGroup("user-expand");
		projection.markStarted("read-1", "read", { path: "src/a.ts" });
		const read = createComponent("read", "read-1", { path: "src/a.ts" });
		projection.markComplete("read-1", { content: [{ type: "text", text: "RAW SECRET" }] }, false);
		read.updateResult({ content: [{ type: "text", text: "RAW SECRET" }], isError: false });
		projection.markStarted("bash-1", "bash", { command: "pnpm test" });
		const bash = createComponent("bash", "bash-1", { command: "pnpm test" });
		projection.markComplete("bash-1", { content: [{ type: "text", text: "RAW OUTPUT" }] }, false);
		bash.updateResult({ content: [{ type: "text", text: "RAW OUTPUT" }], isError: false });
		projection.collapseRetainedDone();

		const collapsedLeader = bash.render(120);
		assert.equal(collapsedLeader[0], "");
		assert.equal(collapsedLeader[collapsedLeader.length - 1], "");
		assert.match(collapsedLeader.join("\n"), /Tools.*read ×1.*bash ×1/);
		assert.deepEqual(read.render(120), []);

		read.setExpanded(true);
		bash.setExpanded(true);
		const expandedRead = read.render(120);
		const expandedBash = bash.render(120);
		assert.match(expandedRead.join("\n"), /Tools.*read ×1.*bash ×1/);
		assert.doesNotMatch(expandedRead.join("\n"), /Tools[^\n]*\n\n.*[│└]/);
		assert.doesNotMatch(expandedRead.join("\n"), /[│└][^\n]*\n\n/);
		assert.notEqual(expandedRead[expandedRead.length - 1], "");
		assert.doesNotMatch(expandedRead.join("\n"), /│.*Tools/);
		assert.doesNotMatch(expandedBash.join("\n"), /Tools.*read ×1.*bash ×1/);
		assert.match(expandedRead.join("\n"), /│.*Read\(src\/a\.ts\)/);
		assert.match(expandedBash.join("\n"), /└.*Bash\(pnpm test\)/);
		assert.doesNotMatch(expandedRead.join("\n"), /RAW SECRET|files|\+\d|−\d/);
		assert.doesNotMatch(expandedBash.join("\n"), /RAW OUTPUT|files|\+\d|−\d/);
	} finally {
		restoreAggregateToolExecutions();
	}
});

test("expanded Tools summary stays on the first visible framed row after empty thinking", () => {
	initTheme("dark", false);
	const projection = createProjection();
	patchAggregateToolExecutions(projection);
	try {
		projection.startUserGroup("user-empty-thinking");
		projection.ingestAssistantMessage({
			role: "assistant",
			id: "assistant-empty",
			stopReason: "toolUse",
			content: [{ type: "thinking", thinking: "hidden" }],
		});
		projection.markStarted("read-1", "read", { path: "src/a.ts" });
		const read = createComponent("read", "read-1", { path: "src/a.ts" });
		read.setExpanded(true);
		const expanded = read.render(120).join("\n");
		assert.match(expanded, /Tools.*read ×1/);
		assert.match(expanded, /[│└].*Read\(src\/a\.ts\)/);
	} finally {
		restoreAggregateToolExecutions();
	}
});

test("prototype patch aggregates an arbitrary custom tool without changing its definition", () => {
	initTheme("dark", false);
	const projection = createProjection();
	patchAggregateToolExecutions(projection);
	const customTool = createTool("custom_probe", "ORIGINAL CUSTOM CALL", "ORIGINAL CUSTOM RESULT");
	try {
		projection.startUserGroup("user-custom");
		projection.ingestAssistantMessage({
			role: "assistant",
			content: [{ type: "toolCall", ...call("custom-1", "custom_probe", { query: "alpha" }) }],
		});
		const component = createComponent("custom_probe", "custom-1", { query: "alpha" }, customTool);
		const running = component.render(120).join("\n");
		assert.match(running, /Tools.*custom_probe ×1/);
		assert.match(running, /\x1b\[/, "custom-only summaries still use the active public theme");
		assert.doesNotMatch(running, /ORIGINAL CUSTOM/);

		projection.markComplete("custom-1", { content: [{ type: "text", text: "ok" }] }, false);
		component.updateResult({ content: [{ type: "text", text: "RAW CUSTOM RESULT" }], isError: false });
		const completed = component.render(120).join("\n");
		assert.match(completed, /✓.*custom_probe/);
		assert.doesNotMatch(completed, /ORIGINAL CUSTOM|RAW CUSTOM/);
		assert.equal(customTool.renderCall?.().render(120).join("\n").trimEnd(), "ORIGINAL CUSTOM CALL");
	} finally {
		restoreAggregateToolExecutions();
	}
});

test("a stale patch is reinstalled after an earlier external wrapper restores first", () => {
	initTheme("dark", false);
	const prototype = ToolExecutionComponent.prototype as unknown as {
		render(width: number): string[];
	};
	const baseRender = prototype.render;
	const externalRender = function externalRender(this: ToolExecutionComponent, width: number): string[] {
		return baseRender.call(this, width);
	};
	prototype.render = externalRender;
	const first = createProjection();
	patchAggregateToolExecutions(first);
	try {
		// Simulate an earlier wrapper restoring aggressively before our cleanup.
		prototype.render = baseRender;
		restoreAggregateToolExecutions();

		const second = createProjection();
		patchAggregateToolExecutions(second);
		second.startUserGroup("user-repatch");
		second.markStarted("custom-repatch", "custom_probe", {});
		const component = createComponent("custom_probe", "custom-repatch", {});
		assert.match(component.render(120).join("\n"), /Tools.*custom_probe ×1/);
	} finally {
		restoreAggregateToolExecutions();
		prototype.render = baseRender;
	}
});

test("Agent passthrough preserves its original renderer while another leader counts it", () => {
	initTheme("dark", false);
	const projection = createProjection();
	patchAggregateToolExecutions(projection);
	try {
		projection.startUserGroup("user-agent-ui");
		projection.markStarted("read-1", "read", { path: "a.ts" });
		const readComponent = createComponent("read", "read-1", { path: "a.ts" });
		projection.markStarted("agent-1", "Agent", { prompt: "review" });
		const agentComponent = createComponent("Agent", "agent-1", { prompt: "review" }, createTool("Agent", "AGENT PROGRESS"));
		assert.match(agentComponent.render(120).join("\n"), /AGENT PROGRESS/);
		assert.match(readComponent.render(120).join("\n"), /Tools.*read ×1.*Agent ×1/);
	} finally {
		restoreAggregateToolExecutions();
	}
});

test("ask_user_question result is hidden in aggregate and restored by individual renderer", () => {
	initTheme("dark", false);
	const projection = createProjection();
	patchAggregateToolExecutions(projection);
	const askTool = {
		...createTool("ask_user_question"),
		renderCall: () => new Container(),
		renderResult: () => new Text("✓ 1 answer received\n  → Aggregate", 0, 0),
	};
	const component = createComponent("ask_user_question", "ask-1", { questions: [] }, askTool);
	try {
		projection.startUserGroup("user-ask");
		projection.markStarted("ask-1", "ask_user_question", { questions: [] });
		projection.markComplete("ask-1", { content: [{ type: "text", text: "Aggregate" }] }, false);
		component.updateResult({ content: [{ type: "text", text: "Aggregate" }], isError: false });
		assert.match(component.render(120).join("\n"), /Tools.*ask_user_question ×1/);
		assert.doesNotMatch(component.render(120).join("\n"), /answer received|Aggregate$/m);
	} finally {
		restoreAggregateToolExecutions();
	}
	assert.match(component.render(120).join("\n"), /1 answer received/);
	assert.match(component.render(120).join("\n"), /Aggregate/);
});

test("reload shutdown restores original custom history renderers", async () => {
	initTheme("dark", false);
	const projection = createProjection();
	const handlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
	const api = {
		on(event: string, handler: (event: any, ctx?: any) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	registerAggregateProjectionEvents(api, projection);
	const askTool = {
		...createTool("ask_user_question"),
		renderCall: () => new Container(),
		renderResult: () => new Text("✓ restored answer", 0, 0),
	};
	projection.startUserGroup("user-reload-ask");
	projection.markStarted("ask-reload", "ask_user_question", { questions: [] });
	projection.markComplete("ask-reload", { content: [{ type: "text", text: "answer" }] }, false);
	const component = createComponent("ask_user_question", "ask-reload", { questions: [] }, askTool);
	component.updateResult({ content: [{ type: "text", text: "answer" }], isError: false });
	assert.doesNotMatch(component.render(120).join("\n"), /restored answer/);

	await handlers.get("session_shutdown")?.[0]?.({ reason: "reload" });
	assert.match(component.render(120).join("\n"), /restored answer/);
});

test("image results fail open to the original custom renderer", () => {
	initTheme("dark", false);
	const projection = createProjection();
	patchAggregateToolExecutions(projection);
	try {
		projection.startUserGroup("user-image");
		projection.markStarted("image-1", "custom_image", {});
		const component = createComponent("custom_image", "image-1", {}, createTool("custom_image", "ORIGINAL IMAGE TOOL"));
		const result = {
			content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
			isError: false,
		};
		projection.markComplete("image-1", result, false);
		component.updateResult(result);
		assert.match(component.render(120).join("\n"), /ORIGINAL IMAGE TOOL/);
		assert.equal(projection.getMember("image-1")?.state, "needsAttention");
	} finally {
		restoreAggregateToolExecutions();
	}
});

test("branch rebuild invalidates and releases tool rows removed by tree or compaction", () => {
	const projection = createProjection();
	projection.startUserGroup("live");
	projection.markStarted("old-1", "custom_old", {});
	let oldInvalidations = 0;
	projection.connectRenderer("old-1", "custom_old", {}, () => { oldInvalidations += 1; });
	const branch = [
		userEntry("new-user"),
		assistantEntry("new-assistant", [call("new-1", "custom_new")]),
		resultEntry("new-result", "new-1", "custom_new"),
	];
	projection.rebuild(branch, messages(branch));
	assert.ok(oldInvalidations > 0);
	assert.equal(projection.getConnectedRendererCount(), 0);
	assert.equal(projection.getGroups()[0]?.leaderToolCallId, "new-1");
});

test("deterministic targets never invent intent for generic custom tools", () => {
	assert.equal(formatAggregateTarget({ toolName: "read", args: { path: "/tmp/a.ts" } }), "Read(/tmp/a.ts)");
	assert.equal(formatAggregateTarget({ toolName: "grep", args: { pattern: "x", path: "src" } }), "Search(/x/ in src)");
	assert.equal(formatAggregateTarget({ toolName: "custom_probe", args: { displaySummary: "Secret intent" } }), "custom_probe");
	assert.equal(
		formatAggregateTarget({ toolName: "read", args: { path: "/tmp/\x1b]8;;https://evil.example\x07secret.ts" } }),
		"Read(/tmp/secret.ts)",
	);
});

test("streaming assistant updates keep one turn identity after the first tool call appears", () => {
	const projection = createProjection();
	projection.startUserGroup("user-stable-turn");
	projection.ingestAssistantMessage({
		role: "assistant",
		id: "assistant-stream",
		stopReason: "pending",
		content: [{ type: "text", text: "先定位两边的设计与实现入口" }],
		usage: { input: 10, output: 2, cacheRead: 0, cacheWrite: 0 },
	});
	projection.ingestAssistantMessage({
		role: "assistant",
		id: "assistant-stream",
		stopReason: "toolUse",
		content: [
			{ type: "text", text: "先定位两边的设计与实现入口" },
			{ type: "toolCall", ...call("read-stream", "read", { path: "a.ts" }) },
		],
		usage: { input: 12, output: 4, cacheRead: 0, cacheWrite: 0 },
	});
	const view = projection.getView("read-stream");
	assert.equal(view?.agentTurnCount, 1);
	assert.deepEqual(view?.usage, { input: 12, output: 4, cacheRead: 0, cacheWrite: 0 });
});

test("a later child projection cannot steal the host Tools ledger", () => {
	initTheme("dark", false);
	const host = createProjection();
	const child = createProjection();
	patchAggregateToolExecutions(host);
	try {
		host.startUserGroup("host-user");
		host.markStarted("host-read", "read", { path: "src/a.ts" });
		const hostRow = createComponent("read", "host-read", { path: "src/a.ts" });
		assert.match(hostRow.render(120).join("\n"), /Tools.*read ×1/);

		patchAggregateToolExecutions(child);
		child.rebuild([]);
		assert.equal(getActiveAggregateProjection(), host);
		assert.equal(host.getMember("host-read")?.toolName, "read");
		assert.match(hostRow.render(120).join("\n"), /Tools.*read ×1/);
		assert.notDeepEqual(hostRow.render(120), []);
	} finally {
		restoreAggregateToolExecutions();
	}
});

test("child session_start and before_agent_start keep the host ledger pointer", async () => {
	initTheme("dark", false);
	const host = createProjection();
	const child = createProjection();
	const hostHandlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
	const childHandlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
	const hostApi = {
		on(event: string, handler: (event: any, ctx?: any) => unknown) {
			hostHandlers.set(event, [...(hostHandlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	const childApi = {
		on(event: string, handler: (event: any, ctx?: any) => unknown) {
			childHandlers.set(event, [...(childHandlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	const hostCtx = {
		hasUI: true,
		sessionManager: {
			getBranch: () => [
				userEntry("host-user"),
				assistantEntry("host-assistant", [call("host-read", "read", { path: "src/a.ts" })]),
			],
			buildSessionContext: () => ({ messages: [] }),
		},
	};
	const childCtx = {
		hasUI: false,
		sessionManager: {
			getBranch: () => [],
			buildSessionContext: () => ({ messages: [] }),
		},
	};
	registerAggregateProjectionEvents(hostApi, host);
	try {
		await hostHandlers.get("session_start")?.[0]?.({}, hostCtx);
		host.markStarted("host-read", "read", { path: "src/a.ts" });
		assert.equal(getActiveAggregateProjection(), host);

		registerAggregateProjectionEvents(childApi, child);
		await childHandlers.get("session_start")?.[0]?.({}, childCtx);
		await childHandlers.get("before_agent_start")?.[0]?.({}, childCtx);

		assert.equal(getActiveAggregateProjection(), host);
		assert.equal(host.getMember("host-read")?.toolName, "read");
		assert.equal(child.getMember("host-read"), undefined);
	} finally {
		await childHandlers.get("session_shutdown")?.[0]?.({ reason: "reload" });
		await hostHandlers.get("session_shutdown")?.[0]?.({ reason: "reload" });
		restoreAggregateToolExecutions();
	}
});
