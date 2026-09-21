import { describe, expect, it } from "vitest";
import { buildSessionEntries, createMockCtx, createMockPi, makeTodoToolResult } from "./test-fixtures.js";
import registerTodo from "./index.js";
import type { MutationDetailsV2, QueryDetailsV2, Task } from "./tool/types.js";

function checkpoint(tasks: Task[], nextId: number, generation = 1, revision = 1): MutationDetailsV2 {
	return {
		schemaVersion: 2,
		kind: "checkpoint",
		action: "create",
		params: {},
		state: { tasks, nextId, generation, revision },
	};
}

function setup() {
	const { pi, captured } = createMockPi();
	registerTodo(pi);
	const tool = captured.tools.get("todo");
	if (!tool) throw new Error("todo tool not registered");
	return { captured, tool };
}

async function call(tool: ReturnType<typeof setup>["tool"], params: Record<string, unknown>) {
	return tool.execute?.("tc", params as never, undefined as never, undefined as never, {} as never);
}

describe("todo does not inject live state into the model prompt", () => {
	it("does not register prompt or context injection hooks", () => {
		const { captured } = setup();
		expect(captured.events.get("before_agent_start") ?? []).toEqual([]);
		expect(captured.events.get("context") ?? []).toEqual([]);
		expect(captured.events.get("agent_settled") ?? []).toEqual([]);
	});
});

describe("lifecycle replay restores the store without prompt injection", () => {
	it.each([
		["session_start", { reason: "resume" }],
		["session_compact", {}],
		["session_tree", {}],
	] as const)("list returns recovered tasks after %s", async (eventName, event) => {
		const { captured, tool } = setup();
		const details = checkpoint(
			[
				{ id: 41, subject: "Recovered active", status: "in_progress", description: "omit me" },
				{ id: 42, subject: "Recovered next", status: "pending" },
				{ id: 43, subject: "Recovered done", status: "completed" },
			],
			44,
			7,
			19,
		);
		const branch = buildSessionEntries([
			makeTodoToolResult(details),
			makeTodoToolResult({ schemaVersion: 2, kind: "query", action: "list" }),
		]);
		const ctx = createMockCtx({ branch });
		const lifecycle = captured.events.get(eventName)?.[0];
		if (!lifecycle) throw new Error(`${eventName} not registered`);
		await lifecycle(event as never, ctx as never);

		const listed = await call(tool, { action: "list" });
		expect(listed?.details as QueryDetailsV2).toEqual({
			schemaVersion: 2,
			kind: "query",
			action: "list",
		});
		expect(listed?.content[0]).toMatchObject({
			text: expect.stringContaining("[in_progress] #41 Recovered active"),
		});
		expect(listed?.content[0]).toMatchObject({
			text: expect.stringContaining("[pending] #42 Recovered next"),
		});
		expect(listed?.content[0]).toMatchObject({
			text: expect.stringContaining("1 completed task hidden"),
		});
		expect(listed?.content[0]).not.toMatchObject({
			text: expect.stringContaining("omit me"),
		});
	});
});
