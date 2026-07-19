import type { Theme } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import { createMockPi, makeTheme } from "@juicesharp/rpiv-test-utils";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { __resetState, registerTodoTool, type TaskDetails, TOOL_NAME } from "./todo.js";

const theme = makeTheme() as unknown as Theme;

function setup() {
	__resetState();
	const { pi, captured } = createMockPi();
	registerTodoTool(pi);
	const tool = captured.tools.get(TOOL_NAME);
	if (!tool) throw new Error("tool not registered");
	return { tool, captured };
}

async function call(tool: ReturnType<typeof setup>["tool"], params: Record<string, unknown>) {
	return tool.execute?.("tc", params as never, undefined as never, undefined as never, {} as never);
}

beforeEach(() => {
	__resetState();
});
afterEach(() => {
	__resetState();
});

describe("registerTodoTool — registration shape", () => {
	it("registers under the tool name 'todo' with the expected label and guidelines", () => {
		const { captured } = setup();
		const tool = captured.tools.get("todo")!;
		expect(tool.name).toBe("todo");
		expect(tool.label).toBe("Todo");
		expect(tool.renderShell).toBe("self");
		expect(tool.promptSnippet).toContain("task list");
		expect(Array.isArray(tool.promptGuidelines)).toBe(true);
		expect((tool.promptGuidelines as string[]).length).toBeGreaterThan(0);
	});

	it("exposes a typebox parameters schema declaring the six actions", () => {
		const { tool } = setup();
		const raw = JSON.stringify(tool.parameters);
		for (const action of ["create", "update", "list", "get", "delete", "clear"]) {
			expect(raw).toContain(action);
		}
	});
});

describe("registerTodoTool — execute mutates module state", () => {
	it("create → list returns the seeded row", async () => {
		const { tool } = setup();
		const r1 = await call(tool, { action: "create", subject: "first" });
		expect((r1?.details as TaskDetails).action).toBe("create");
		const r2 = await call(tool, { action: "list" });
		expect(r2?.content[0]).toMatchObject({ text: expect.stringContaining("first") });
	});

	it("clear resets module state and nextId", async () => {
		const { tool } = setup();
		await call(tool, { action: "create", subject: "a" });
		await call(tool, { action: "create", subject: "b" });
		const r = await call(tool, { action: "clear" });
		const d = r?.details as TaskDetails;
		expect(d.tasks).toEqual([]);
		expect(d.nextId).toBe(1);
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
			await call(tool, { action: "clear" }),
		];

		for (const result of results) {
			const node = tool.renderResult?.(result as never, {} as never, theme, successContext) as unknown as Text;
			expect(node.render(80)).toEqual([]);
		}
	});

	it("keeps reducer-level errors visible", async () => {
		const { tool } = setup();
		const result = await call(tool, { action: "create" });
		const node = tool.renderResult?.(result as never, {} as never, theme, successContext) as unknown as Text;
		expect(node.render(80).join("\n")).toContain("subject required for create");
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
