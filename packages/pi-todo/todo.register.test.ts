import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createMockPi, makeTheme } from "./test-fixtures.js";
import { describe, expect, it } from "vitest";
import { createTodoStore, registerTodoTool, TOOL_NAME } from "./todo.js";
import type { MutationDetailsV2, QueryDetailsV2 } from "./tool/types.js";

const theme = makeTheme() as unknown as Theme;

function setup() {
	const { pi, captured } = createMockPi();
	registerTodoTool(pi, createTodoStore());
	const tool = captured.tools.get(TOOL_NAME);
	if (!tool) throw new Error("tool not registered");
	return { tool, captured };
}

async function call(tool: ReturnType<typeof setup>["tool"], params: Record<string, unknown>) {
	return tool.execute?.("tc", params as never, undefined as never, undefined as never, {} as never);
}

describe("registerTodoTool — registration shape", () => {
	it("registers under the tool name 'todo' with the expected label and guidelines", () => {
		const { captured } = setup();
		const tool = captured.tools.get("todo")!;
		expect(tool.name).toBe("todo");
		expect(tool.label).toBe("Todo");
		expect(tool.renderShell).toBe("self");
		expect(tool.promptSnippet).toContain("multi-item execution plan");
		expect(tool.description).toContain("Never start a one-task Todo cycle");
		expect(tool.description).toContain("regardless of risk, duration, or importance");
		expect(tool.description).toContain("at least two independently valuable create operations");
		expect(tool.description).toContain("use top-level create only");
		expect(tool.description).toContain("such a batch rolls it over automatically");
		expect(Array.isArray(tool.promptGuidelines)).toBe(true);
		expect((tool.promptGuidelines as string[]).length).toBeGreaterThan(0);
	});

	it("exposes current actions and ordered batch semantics without model-callable clear", () => {
		const { tool } = setup();
		const raw = JSON.stringify(tool.parameters);
		for (const action of ["create", "update", "list", "get", "delete", "batch"]) {
			expect(raw).toContain(action);
		}
		expect(raw).not.toContain("clear");
		expect(tool.description).not.toContain("clear");
		expect(raw).toContain("create accepts only pending or in_progress");
		expect(raw).toContain("To start a fresh cycle, include at least two create operations");
		expect(raw).toContain("intended execution order");
		expect(raw).toContain("Ordered atomic");
		expect(raw).not.toContain("activeForm");
		expect(raw).not.toContain("blockedBy");
		expect(raw).not.toContain("addBlockedBy");
		expect(raw).not.toContain("removeBlockedBy");
	});
});

describe("registerTodoTool — execute mutates its injected store", () => {
	it("create checkpoints state while list returns only a query envelope", async () => {
		const { tool } = setup();
		const created = await call(tool, { action: "create", subject: "first" });
		const mutation = created?.details as MutationDetailsV2;
		expect(mutation).toMatchObject({ schemaVersion: 2, kind: "checkpoint", action: "create" });
		expect(mutation.state.tasks[0]?.subject).toBe("first");
		const listed = await call(tool, { action: "list" });
		expect(listed?.content[0]).toMatchObject({ text: expect.stringContaining("first") });
		expect(listed?.details as QueryDetailsV2).toEqual({
			schemaVersion: 2,
			kind: "query",
			action: "list",
		});
	});

	it("batch creates and starts the first task in one tool result", async () => {
		const { tool } = setup();
		const result = await call(tool, {
			action: "batch",
			operations: [
				{ action: "create", subject: "first", status: "in_progress" },
				{ action: "create", subject: "second" },
			],
		});
		const details = result?.details as MutationDetailsV2;
		expect(details.state.tasks.map(({ subject, status }) => ({ subject, status }))).toEqual([
			{ subject: "first", status: "in_progress" },
			{ subject: "second", status: "pending" },
		]);
		expect(result?.content[0]).toMatchObject({
			text: expect.stringContaining("Created #1: first (in_progress)"),
		});
	});
});

describe("registerTodoTool — transcript rendering", () => {
	const successContext = { isError: false } as never;

	it.each([
		{ action: "create", subject: "hello" },
		{ action: "update", id: 1 },
		{ action: "list", status: "in_progress" },
		{ action: "get", id: 1 },
		{ action: "delete", id: 1 },
		{ action: "clear" },
		{ action: "batch", operations: [{ action: "create", subject: "a" }] },
	])("renders no call lines for $action", (args) => {
		const { tool } = setup();
		const node = tool.renderCall?.(args as never, theme, undefined as never) as unknown as Text;
		expect(node).toBeInstanceOf(Text);
		expect(node.render(80)).toEqual([]);
	});

	it("renders no result lines for every successful action", async () => {
		const { tool } = setup();
		const results = [
			await call(tool, { action: "create", subject: "a" }),
			await call(tool, { action: "list" }),
			await call(tool, { action: "get", id: 1 }),
			await call(tool, { action: "update", id: 1, status: "in_progress" }),
			await call(tool, { action: "delete", id: 1 }),
			await call(tool, { action: "batch", operations: [{ action: "create", subject: "batched" }] }),
		];

		for (const result of results) {
			const node = tool.renderResult?.(result as never, {} as never, theme, successContext) as unknown as Text;
			expect(node.render(80)).toEqual([]);
		}
	});

	it("reports reducer validation failures as real tool errors", async () => {
		const { tool } = setup();
		await expect(call(tool, { action: "create" })).rejects.toThrow("subject required for create");
	});

	it("reveals every ordered batch operation in expanded mode", () => {
		const { tool } = setup();
		const callNode = tool.renderCall?.(
			{
				action: "batch",
				operations: [
					{ action: "create", subject: "first", status: "in_progress" },
					{ action: "update", id: 1, status: "completed" },
					{ action: "delete", id: 2 },
				],
			} as never,
			theme,
			{ expanded: true } as never,
		) as unknown as Text;
		const rendered = callNode.render(120).join("\n");
		expect(rendered).toContain("batch (3 operations)");
		expect(rendered).toContain("1. create “first” → in_progress");
		expect(rendered).toContain("2. update #1 → completed");
		expect(rendered).toContain("3. delete #2");
	});

	it("reveals successful call and result summaries in expanded mode", async () => {
		const { tool } = setup();
		const callNode = tool.renderCall?.(
			{ action: "create", subject: "audit me" } as never,
			theme,
			{ expanded: true } as never,
		) as unknown as Text;
		expect(callNode.render(80).join("\n")).toContain("todo create");
		expect(callNode.render(80).join("\n")).toContain("audit me");

		const result = await call(tool, { action: "create", subject: "audit me" });
		const resultNode = tool.renderResult?.(
			result as never,
			{ expanded: true } as never,
			theme,
			{ isError: false } as never,
		) as unknown as Text;
		expect(resultNode.render(80).join("\n")).toContain("Created #1");
	});

	it("keeps Pi execution errors visible when details are unavailable", () => {
		const { tool } = setup();
		const node = tool.renderResult?.(
			{ content: [{ type: "text", text: "runtime failure" }], details: undefined } as never,
			{} as never,
			theme,
			{ isError: true } as never,
		) as unknown as Text;
		expect(node.render(80).join("\n")).toContain("runtime failure");
	});

	it("hides a successful result even when details are unavailable", () => {
		const { tool } = setup();
		const node = tool.renderResult?.(
			{ content: [], details: undefined } as never,
			{} as never,
			theme,
			successContext,
		) as unknown as Text;
		expect(node.render(80)).toEqual([]);
	});
});
