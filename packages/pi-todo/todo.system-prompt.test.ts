import { describe, expect, it } from "vitest";
import { buildSessionEntries, createMockCtx, createMockPi, makeTodoToolResult } from "./test-fixtures.js";
import registerTodo from "./index.js";
import type { MutationDetailsV2, Task } from "./tool/types.js";

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
	const beforeAgentStart = captured.events.get("before_agent_start")?.[0];
	const context = captured.events.get("context")?.[0];
	const agentSettled = captured.events.get("agent_settled")?.[0];
	if (!beforeAgentStart || !context || !agentSettled) throw new Error("Todo prompt lifecycle not registered");
	return { captured, tool, beforeAgentStart, context, agentSettled };
}

async function call(tool: ReturnType<typeof setup>["tool"], params: Record<string, unknown>) {
	return tool.execute?.("tc", params as never, undefined as never, undefined as never, {} as never);
}

async function promptResult(handler: (...args: unknown[]) => unknown, systemPrompt = "BASE") {
	return handler({ systemPrompt } as never, createMockCtx() as never) as Promise<
		{ systemPrompt: string } | undefined
	>;
}

describe("before_agent_start Current Todo state", () => {
	it("appends the active summary at the system prompt tail on every run", async () => {
		const { captured, tool, beforeAgentStart } = setup();
		await call(tool, {
			action: "batch",
			operations: [
				{ action: "create", subject: "Implement", status: "in_progress" },
				{ action: "create", subject: "Verify" },
			],
		});

		for (const base of ["BASE ONE", "BASE TWO"]) {
			const result = await promptResult(beforeAgentStart, base);
			expect(result?.systemPrompt).toBe(
				`${base}\n\nCurrent Todo state:\n` +
					"- #1 in_progress: Implement\n" +
					"- #2 pending: Verify",
			);
			expect(result?.systemPrompt.endsWith("- #2 pending: Verify")).toBe(true);
		}
		expect(captured.entries).toEqual([]);
	});

	it("does not append a section when no active task exists", async () => {
		const { tool, beforeAgentStart } = setup();
		expect(await promptResult(beforeAgentStart)).toBeUndefined();
		await call(tool, {
			action: "batch",
			operations: [
				{ action: "create", subject: "Done", status: "in_progress" },
				{ action: "create", subject: "Also" },
			],
		});
		await call(tool, { action: "update", id: 1, status: "completed" });
		await call(tool, { action: "update", id: 2, status: "completed" });
		expect(await promptResult(beforeAgentStart)).toBeUndefined();
	});

	it("injects an ephemeral exact update after same-run mutation and overflow compaction", async () => {
		const { captured, tool, beforeAgentStart, context, agentSettled } = setup();
		await call(tool, {
			action: "batch",
			operations: [
				{ action: "create", subject: "Initial", status: "in_progress" },
				{ action: "create", subject: "Next" },
			],
		});
		await promptResult(beforeAgentStart);
		expect(await context({ messages: [] } as never, createMockCtx() as never)).toBeUndefined();

		const changed = await call(tool, { action: "create", subject: "Added after run start" });
		const branch = buildSessionEntries([makeTodoToolResult(changed?.details)]);
		await captured.events.get("session_compact")?.[0]?.(
			{ willRetry: true } as never,
			createMockCtx({ branch }) as never,
		);
		const update = await context({ messages: [] } as never, createMockCtx() as never) as {
			messages: Array<{ role: string; content?: string; display?: boolean }>;
		};
		expect(update.messages.at(-1)).toMatchObject({
			role: "custom",
			display: false,
			content:
				"Current Todo state update:\n" +
				"- #1 in_progress: Initial\n" +
				"- #2 pending: Next\n" +
				"- #3 pending: Added after run start",
		});
		expect(captured.entries).toEqual([]);

		await agentSettled({} as never, createMockCtx() as never);
		expect(await context({ messages: [] } as never, createMockCtx() as never)).toBeUndefined();
	});
});

describe("lifecycle replay feeds the next run summary", () => {
	it.each([
		["session_start", { reason: "resume" }],
		["session_compact", {}],
		["session_tree", {}],
	] as const)("restores exact state after %s", async (eventName, event) => {
		const { captured, beforeAgentStart } = setup();
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

		const result = await promptResult(beforeAgentStart, "RESTORED BASE");
		expect(result?.systemPrompt).toContain("- #41 in_progress: Recovered active");
		expect(result?.systemPrompt).toContain("- #42 pending: Recovered next");
		expect(result?.systemPrompt).toContain("- 1 completed task hidden");
		expect(result?.systemPrompt).not.toContain("omit me");
	});
});
