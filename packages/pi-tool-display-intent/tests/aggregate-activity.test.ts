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
	formatAggregateTarget,
	patchAggregateToolExecutions,
	registerAggregateProjectionEvents,
	renderAggregateActivity,
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
	assert.match(rendered, /^! Tools · 1 failed · read ×1 · edit ×1 · custom_probe ×1/m);
	assert.doesNotMatch(rendered, /network exploded/);
	assert.match(renderAggregateActivity(view, 500, plainTheme(), true).join("\n"), /network exploded/);
	assert.doesNotMatch(rendered, /files|Changes|\+\d|−\d/);
});

test("expanded Tools shows one bounded last-target summary per tool type and no raw output", () => {
	const projection = createProjection();
	projection.startUserGroup("user-expand");
	projection.markStarted("read-1", "read", { path: "src/a.ts" });
	projection.markComplete("read-1", { content: [{ type: "text", text: "RAW SECRET" }] }, false);
	projection.markStarted("bash-1", "bash", { command: "pnpm test" });
	projection.markComplete("bash-1", { content: [{ type: "text", text: "RAW OUTPUT" }] }, false);
	projection.collapseRetainedDone();
	const view = projection.getView("bash-1");
	assert.ok(view);
	const collapsed = renderAggregateActivity(view, 500, plainTheme(), false).join("\n");
	assert.doesNotMatch(collapsed, /last:/);
	const expanded = renderAggregateActivity(view, 500, plainTheme(), true).join("\n");
	assert.match(expanded, /read ×1 · last: Read\(src\/a\.ts\)/);
	assert.match(expanded, /bash ×1 · last: Bash\(pnpm test\)/);
	assert.doesNotMatch(expanded, /RAW SECRET|RAW OUTPUT|files|\+\d|−\d/);
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
		assert.match(completed, /custom_probe.*done/);
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
});
