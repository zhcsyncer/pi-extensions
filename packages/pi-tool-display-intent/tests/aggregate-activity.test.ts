import assert from "node:assert/strict";
import test from "node:test";
import {
	initTheme,
	ToolExecutionComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Container, Text } from "@earendil-works/pi-tui";
import {
	AGGREGATE_WRITE_DIFF_CUSTOM_TYPE,
	AggregateProjection,
	applyAggregateRendering,
	formatAggregateTarget,
	registerAggregateProjectionEvents,
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
	options: { text?: string; isError?: boolean; details?: unknown; image?: boolean } = {},
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
			details: options.details,
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
	return new AggregateProjection(() => true);
}

function call(id: string, name: string, args: Record<string, unknown>) {
	return { id, name, arguments: args };
}

test("rebuild groups by user message across low-level turns and restores latest leader", () => {
	const projection = createProjection();
	const branch = [
		userEntry("user-1"),
		assistantEntry("assistant-1", [call("read-1", "read", { path: "src/a.ts" })]),
		resultEntry("result-1", "read-1", "read"),
		assistantEntry("assistant-2", [call("bash-1", "bash", { command: "pnpm test" })]),
		resultEntry("result-2", "bash-1", "bash"),
		userEntry("user-2", "next request"),
		assistantEntry("assistant-3", [call("grep-1", "grep", { pattern: "Activity", path: "src" })]),
		resultEntry("result-3", "grep-1", "grep"),
	];
	projection.rebuild(branch, messages(branch));

	assert.equal(projection.getGroups().length, 2);
	assert.equal(projection.getGroups()[0]?.leaderToolCallId, "bash-1");
	assert.equal(projection.getGroups()[1]?.leaderToolCallId, "grep-1");
	assert.equal(projection.getView("read-1"), undefined);
	assert.deepEqual(projection.getView("bash-1")?.successCounts, [
		{ toolName: "read", count: 1 },
		{ toolName: "bash", count: 1 },
	]);
	assert.deepEqual(projection.getView("grep-1")?.successCounts, [
		{ toolName: "grep", count: 1 },
	]);
});

test("parallel completion order never changes source order or double-counts success", () => {
	const projection = createProjection();
	projection.startUserGroup("user-parallel");
	projection.ingestAssistantMessage({
		role: "assistant",
		content: [
			{ type: "toolCall", ...call("read-1", "read", { path: "a.ts" }) },
			{ type: "toolCall", ...call("bash-1", "bash", { command: "pnpm test" }) },
			{ type: "toolCall", ...call("grep-1", "grep", { pattern: "x", path: "src" }) },
			{ type: "toolCall", ...call("find-1", "find", { pattern: "*.ts", path: "src" }) },
			{ type: "toolCall", ...call("ls-1", "ls", { path: "src" }) },
		],
	});

	let view = projection.getView("ls-1");
	assert.deepEqual(view?.active.map((member) => member.toolCallId), ["read-1", "bash-1", "grep-1"]);
	assert.equal(view?.activeOverflow, 2);
	assert.deepEqual(view?.successCounts, []);

	projection.markComplete("find-1", { content: [{ type: "text", text: "ok" }] }, false);
	projection.markComplete("bash-1", { content: [{ type: "text", text: "ok" }] }, false);
	projection.markComplete("read-1", { content: [{ type: "text", text: "ok" }] }, false);
	projection.markComplete("bash-1", { content: [{ type: "text", text: "ok" }] }, false);
	view = projection.getView("ls-1");
	assert.deepEqual(view?.active.map((member) => member.toolCallId), ["grep-1", "ls-1"]);
	assert.equal(view?.activeOverflow, 0);
	assert.deepEqual(view?.successCounts, [
		{ toolName: "read", count: 1 },
		{ toolName: "bash", count: 1 },
		{ toolName: "find", count: 1 },
	]);
});

test("failures, aborted calls, and interrupted restored calls retain one-line summaries", () => {
	const live = createProjection();
	live.startUserGroup("user-error");
	live.markStarted("bash-1", "bash", { command: "pnpm test" });
	live.markComplete(
		"bash-1",
		{ content: [{ type: "text", text: "1 test failed\nstack trace" }] },
		true,
	);
	assert.equal(live.getView("bash-1")?.failed[0]?.errorSummary, "1 test failed");

	const abortedBranch = [
		userEntry("user-aborted"),
		assistantEntry(
			"assistant-aborted",
			[call("edit-aborted", "edit", { path: "src/a.ts", edits: [] })],
			{ stopReason: "aborted" },
		),
	];
	const aborted = createProjection();
	aborted.rebuild(abortedBranch, messages(abortedBranch));
	assert.equal(aborted.getView("edit-aborted")?.failed[0]?.errorSummary, "Operation aborted.");

	const interruptedBranch = [
		userEntry("user-interrupted"),
		assistantEntry("assistant-interrupted", [call("read-interrupted", "read", { path: "README.md" })]),
	];
	const interrupted = createProjection();
	interrupted.rebuild(interruptedBranch, messages(interruptedBranch));
	assert.equal(
		interrupted.getView("read-interrupted")?.failed[0]?.errorSummary,
		"Interrupted before a final result.",
	);
});

test("edit/write successes aggregate unique files and exact available diff stats", () => {
	const projection = createProjection();
	projection.startUserGroup("user-diff");
	projection.markStarted("write-1", "write", { path: "src/a.ts", content: "new\nkeep\n" });
	projection.recordWritePrevious("write-1", {
		fileExistedBeforeWrite: true,
		previousContent: "old\nkeep\n",
	});
	projection.markComplete("write-1", { content: [{ type: "text", text: "ok" }] }, false);
	projection.markStarted("edit-1", "edit", { path: "src/a.ts", edits: [{ oldText: "new", newText: "newer" }] });
	projection.markComplete(
		"edit-1",
		{
			content: [{ type: "text", text: "ok" }],
			details: { patch: "--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-new\n+newer\n" },
		},
		false,
	);

	const view = projection.getView("edit-1");
	assert.deepEqual(view?.modifiedFiles, ["src/a.ts"]);
	assert.deepEqual(view?.diffStats, { additions: 2, deletions: 2 });
	assert.deepEqual(view?.successCounts, [
		{ toolName: "write", count: 1 },
		{ toolName: "edit", count: 1 },
	]);
});

test("write diff stats persist outside raw results and survive branch rebuilds", async () => {
	const projection = createProjection();
	const handlers = new Map<string, Array<(event: any, ctx?: any) => unknown>>();
	const appendedEntries: unknown[] = [];
	const api = {
		on(event: string, handler: (event: any, ctx?: any) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
		appendEntry(customType: string, data: unknown) {
			appendedEntries.push({
				type: "custom",
				id: `custom-${appendedEntries.length + 1}`,
				customType,
				data,
			});
		},
	} as unknown as ExtensionAPI;
	registerAggregateProjectionEvents(api, projection);

	projection.startUserGroup("user-persist-write");
	projection.markStarted("write-persist", "write", {
		path: "src/persist.ts",
		content: "new\nkeep\n",
	});
	projection.recordWritePrevious("write-persist", {
		fileExistedBeforeWrite: true,
		previousContent: "old\nkeep\n",
	});
	const rawResult = { content: [{ type: "text", text: "Successfully wrote file" }] };
	await handlers.get("tool_execution_end")?.[0]?.({
		toolCallId: "write-persist",
		toolName: "write",
		result: rawResult,
		isError: false,
	});

	assert.deepEqual(rawResult, { content: [{ type: "text", text: "Successfully wrote file" }] });
	assert.equal(appendedEntries.length, 1);
	assert.equal((appendedEntries[0] as { customType?: unknown }).customType, AGGREGATE_WRITE_DIFF_CUSTOM_TYPE);
	assert.deepEqual(projection.getView("write-persist")?.diffStats, { additions: 1, deletions: 1 });

	const branch = [
		userEntry("user-persist-write"),
		assistantEntry("assistant-persist-write", [
			call("write-persist", "write", { path: "src/persist.ts", content: "new\nkeep\n" }),
		]),
		...appendedEntries,
		resultEntry("result-persist-write", "write-persist", "write", { text: "Successfully wrote file" }),
	];
	const restored = createProjection();
	for (const reason of ["reload", "before_agent_start", "tree", "compaction"]) {
		restored.rebuild(branch, messages(branch));
		assert.deepEqual(
			restored.getView("write-persist")?.diffStats,
			{ additions: 1, deletions: 1 },
			`${reason} preserves persisted write stats`,
		);
	}
});

test("image and unknown/custom tools are never silently absorbed", () => {
	const projection = createProjection();
	projection.startUserGroup("user-boundary");
	projection.ingestAssistantMessage({
		role: "assistant",
		content: [
			{ type: "toolCall", ...call("custom-1", "ask_user", { question: "Continue?" }) },
			{ type: "toolCall", ...call("read-1", "read", { path: "diagram.png" }) },
		],
	});
	assert.equal(projection.getMember("custom-1"), undefined);
	projection.markComplete(
		"read-1",
		{ content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] },
		false,
	);
	assert.equal(projection.getMember("read-1")?.state, "needsAttention");
	assert.equal(projection.getView("read-1"), undefined);
});

test("public events rebuild reload/resume/tree/compaction projections on the current branch", async () => {
	const projection = createProjection();
	const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
	const api = {
		on(event: string, handler: (event: any, ctx: any) => unknown) {
			handlers.set(event, [...(handlers.get(event) ?? []), handler]);
		},
	} as unknown as ExtensionAPI;
	registerAggregateProjectionEvents(api, projection);

	const branch = [
		userEntry("user-1"),
		assistantEntry("assistant-1", [call("read-1", "read", { path: "a.ts" })]),
		resultEntry("result-1", "read-1", "read"),
		assistantEntry("assistant-2", [call("bash-1", "bash", { command: "pnpm test" })]),
		resultEntry("result-2", "bash-1", "bash"),
	];
	const context = {
		sessionManager: {
			getBranch: () => branch,
			buildSessionContext: () => ({ messages: messages(branch) }),
		},
	};
	for (const reason of ["reload", "resume"] as const) {
		await handlers.get("session_start")?.[0]?.({ reason }, context);
		assert.equal(projection.getGroups()[0]?.leaderToolCallId, "bash-1");
	}

	const compactedContext = {
		sessionManager: {
			getBranch: () => branch,
			buildSessionContext: () => ({
				messages: messages(branch).filter((message) => {
					const content = (message as { content?: unknown[] }).content;
					return !Array.isArray(content) || !content.some((entry) => (entry as { id?: string }).id === "bash-1");
				}),
			}),
		},
	};
	await handlers.get("session_compact")?.[0]?.({}, compactedContext);
	assert.equal(projection.getGroups()[0]?.leaderToolCallId, "read-1");
	assert.equal(projection.getView("read-1")?.successCounts.length, 2, "raw branch statistics survive compaction");

	const treeBranch = [
		userEntry("tree-user"),
		assistantEntry("tree-assistant", [call("find-tree", "find", { pattern: "*.ts", path: "src" })]),
		resultEntry("tree-result", "find-tree", "find"),
	];
	await handlers.get("session_tree")?.[0]?.({}, {
		sessionManager: {
			getBranch: () => treeBranch,
			buildSessionContext: () => ({ messages: messages(treeBranch) }),
		},
	});
	assert.equal(projection.getGroups()[0]?.leaderToolCallId, "find-tree");
});

test("public ToolExecutionComponent supports true zero rows, leader transfer, and Ctrl+O invariance", () => {
	initTheme("dark", false);
	const projection = createProjection();
	projection.startUserGroup("user-render");
	let requestedRenders = 0;
	const baseTool = {
		name: "read",
		label: "read",
		description: "read",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
		renderCall: () => new Text("INDEPENDENT READ", 0, 0),
		renderResult: () => new Container(),
	};
	const aggregateTool = applyAggregateRendering(baseTool, projection);
	const ui = { requestRender: () => { requestedRenders += 1; } };
	projection.ingestAssistantMessage({
		role: "assistant",
		content: [{ type: "toolCall", ...call("read-1", "read", { path: "a.ts" }) }],
	});
	const first = new ToolExecutionComponent(
		"read", "read-1", { path: "a.ts" }, {}, aggregateTool as never, ui as never, process.cwd(),
	);
	assert.ok(first.render(100).some((line) => line.includes("Activity")));
	projection.ingestAssistantMessage({
		role: "assistant",
		content: [{ type: "toolCall", ...call("read-2", "read", { path: "b.ts" }) }],
	});
	const second = new ToolExecutionComponent(
		"read", "read-2", { path: "b.ts" }, {}, aggregateTool as never, ui as never, process.cwd(),
	);
	assert.deepEqual(first.render(100), [], "old leader is a genuine zero-row component");
	const collapsed = [...second.render(100)];
	assert.ok(collapsed.some((line) => line.includes("Activity")));
	second.setExpanded(true);
	assert.deepEqual([...second.render(100)], collapsed, "Ctrl+O does not expand grouped members");
	assert.ok(requestedRenders > 0, "leader transfer used context.invalidate");

	projection.markComplete("read-1", { content: [{ type: "text", text: "ok" }] }, false);
	projection.markComplete("read-2", { content: [{ type: "text", text: "ok" }] }, false);
	second.updateResult({ content: [{ type: "text", text: "raw hidden output" }], isError: false });
	assert.deepEqual(first.render(100), [], "settled non-leaders remain true zero rows");
	const settled = second.render(100).join("\n");
	assert.match(settled, /read ×2/);
	assert.doesNotMatch(settled, /raw hidden output/);
});

test("history rows created before session_start become visible only after branch rebuild", () => {
	initTheme("dark", false);
	const projection = createProjection();
	const tool = applyAggregateRendering({
		name: "read",
		label: "read",
		description: "read",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [] }),
		renderCall: () => new Text("RAW READ", 0, 0),
		renderResult: () => new Container(),
	}, projection);
	const ui = { requestRender() {} };
	const first = new ToolExecutionComponent(
		"read", "restored-1", { path: "a.ts" }, {}, tool as never, ui as never, process.cwd(),
	);
	const second = new ToolExecutionComponent(
		"read", "restored-2", { path: "b.ts" }, {}, tool as never, ui as never, process.cwd(),
	);
	assert.deepEqual(first.render(100), []);
	assert.deepEqual(second.render(100), []);

	const branch = [
		userEntry("restored-user"),
		assistantEntry("restored-assistant", [
			call("restored-1", "read", { path: "a.ts" }),
			call("restored-2", "read", { path: "b.ts" }),
		]),
		resultEntry("restored-result-1", "restored-1", "read"),
		resultEntry("restored-result-2", "restored-2", "read"),
	];
	projection.rebuild(branch, messages(branch));
	assert.deepEqual(first.render(100), []);
	assert.match(second.render(100).join("\n"), /Activity.*read ×2/);
});

test("image results fail open to the original tool renderer", () => {
	initTheme("dark", false);
	const projection = createProjection();
	projection.startUserGroup("user-image-render");
	const tool = applyAggregateRendering({
		name: "read",
		label: "read",
		description: "read",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [] }),
		renderCall: () => new Text("INDEPENDENT IMAGE READ", 0, 0),
		renderResult: () => new Container(),
	}, projection);
	projection.markStarted("image-1", "read", { path: "diagram.png" });
	const component = new ToolExecutionComponent(
		"read", "image-1", { path: "diagram.png" }, {}, tool as never,
		{ requestRender() {} } as never, process.cwd(),
	);
	projection.markComplete(
		"image-1",
		{ content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }] },
		false,
	);
	component.updateResult({
		content: [{ type: "image", data: "aW1hZ2U=", mimeType: "image/png" }],
		isError: false,
	});
	assert.match(component.render(100).join("\n"), /INDEPENDENT IMAGE READ/);
});

test("tree and compaction rebuilds invalidate then release stale renderer callbacks", () => {
	initTheme("dark", false);
	const projection = createProjection();
	const tool = applyAggregateRendering({
		name: "read",
		label: "read",
		description: "read",
		parameters: { type: "object", properties: {} },
		execute: async () => ({ content: [] }),
		renderCall: () => new Text("RAW READ", 0, 0),
		renderResult: () => new Container(),
	}, projection);
	const ui = { requestRender() {} };
	const branchA = [
		userEntry("user-a"),
		assistantEntry("assistant-a", [call("read-a", "read", { path: "a.ts" })]),
		resultEntry("result-a", "read-a", "read"),
	];
	projection.rebuild(branchA, messages(branchA));
	const oldRow = new ToolExecutionComponent(
		"read", "read-a", { path: "a.ts" }, {}, tool as never, ui as never, process.cwd(),
	);
	assert.match(oldRow.render(100).join("\n"), /Activity/);
	assert.equal(projection.getConnectedRendererCount(), 1);

	const branchB = [
		userEntry("user-b"),
		assistantEntry("assistant-b", [call("read-b", "read", { path: "b.ts" })]),
		resultEntry("result-b", "read-b", "read"),
	];
	projection.rebuild(branchB, messages(branchB));
	assert.deepEqual(oldRow.render(100), [], "removed branch row is invalidated to zero height");
	assert.equal(projection.getConnectedRendererCount(), 0, "removed row callback is released");
	oldRow.invalidate();
	assert.equal(projection.getMember("read-a"), undefined, "stale callback cannot recreate membership");
	assert.equal(projection.getGroups()[0]?.leaderToolCallId, "read-b");
	assert.equal(projection.getConnectedRendererCount(), 0, "stale rerender cannot retain itself again");

	const currentRow = new ToolExecutionComponent(
		"read", "read-b", { path: "b.ts" }, {}, tool as never, ui as never, process.cwd(),
	);
	assert.equal(projection.getConnectedRendererCount(), 1);
	projection.rebuild(branchB, []);
	assert.deepEqual(currentRow.render(100), [], "compacted-away row becomes zero height");
	assert.equal(projection.getGroups()[0]?.leaderToolCallId, undefined);
	assert.equal(projection.getConnectedRendererCount(), 0, "compaction releases invisible callbacks");
});

test("deterministic targets never use model intent", () => {
	assert.equal(
		formatAggregateTarget({
			toolName: "grep",
			args: { pattern: "leader", path: "src", displaySummary: "Secret model intent" },
		}),
		"Search(/leader/ in src)",
	);
	assert.equal(
		formatAggregateTarget({ toolName: "bash", args: { command: "pnpm\ntest" } }),
		"Bash(pnpm test)",
	);
});
