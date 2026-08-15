import { describe, expect, it } from "vitest";
import type { TaskState } from "../state/state.js";
import type { Op } from "../state/state-reducer.js";
import { buildToolResult, formatContent } from "./response-envelope.js";
import type { Task } from "./types.js";

const stateWith = (...tasks: Task[]): TaskState => ({
	tasks,
	nextId: Math.max(0, ...tasks.map((task) => task.id)) + 1,
	generation: 1,
	revision: 0,
});

const t = (over: Partial<Task> & { id: number; subject: string }): Task => ({ status: "pending", ...over });

describe("formatContent", () => {
	it("create — reports the initial status captured by the operation", () => {
		const state = stateWith(t({ id: 1, subject: "alpha", status: "in_progress" }));
		expect(formatContent({ kind: "create", taskId: 1, status: "in_progress" }, state)).toBe(
			"Created #1: alpha (in_progress)",
		);
	});

	it("update — emits transition tuple when statuses differ", () => {
		const state = stateWith(t({ id: 1, subject: "x", status: "in_progress" }));
		const op: Op = { kind: "update", id: 1, fromStatus: "pending", toStatus: "in_progress" };
		expect(formatContent(op, state)).toBe("Updated #1 (pending → in_progress)");
	});

	it("update — omits transition when from === to (e.g. subject-only update)", () => {
		const state = stateWith(t({ id: 1, subject: "x" }));
		const op: Op = { kind: "update", id: 1, fromStatus: "pending", toStatus: "pending" };
		expect(formatContent(op, state)).toBe("Updated #1");
	});

	it("delete — 'Deleted #id: subject'", () => {
		const state = stateWith(t({ id: 1, subject: "ship", status: "deleted" }));
		expect(formatContent({ kind: "delete", id: 1, subject: "ship" }, state)).toBe("Deleted #1: ship");
	});

	it("list — 'No tasks' when no active or completed task exists", () => {
		const state = stateWith(t({ id: 1, subject: "x", status: "deleted" }));
		expect(formatContent({ kind: "list", includeDeleted: false }, state)).toBe("No tasks");
	});

	it("list — joins per-task '[status] #id subject' lines", () => {
		const state = stateWith(
			t({ id: 1, subject: "a" }),
			t({ id: 2, subject: "b", status: "in_progress" }),
		);
		expect(formatContent({ kind: "list", includeDeleted: false }, state)).toBe(
			"[pending] #1 a\n[in_progress] #2 b",
		);
	});

	it("get — emits description and owner without dependency graph fields", () => {
		const state = stateWith(
			t({ id: 1, subject: "root" }),
			t({ id: 2, subject: "leaf", description: "details", owner: "Sergii" }),
		);
		const op: Op = { kind: "get", task: state.tasks[1]! };
		expect(formatContent(op, state)).toBe(
			"#2 [pending] leaf\n  description: details\n  owner: Sergii",
		);
	});

	it("get — status and subject are sufficient for an in_progress task", () => {
		const state = stateWith(t({ id: 1, subject: "build", status: "in_progress" }));
		const op: Op = { kind: "get", task: state.tasks[0]! };
		expect(formatContent(op, state)).toBe("#1 [in_progress] build");
	});

	it("list — defaults to active tasks and reports hidden completed count", () => {
		const state = stateWith(
			t({ id: 1, subject: "a", status: "pending" }),
			t({ id: 2, subject: "b", status: "in_progress" }),
			t({ id: 3, subject: "c", status: "completed" }),
			t({ id: 4, subject: "d", status: "completed" }),
			t({ id: 5, subject: "gone", status: "deleted" }),
		);
		expect(formatContent({ kind: "list", includeDeleted: false }, state)).toBe(
			"[pending] #1 a\n[in_progress] #2 b\n2 completed tasks hidden",
		);
	});

	it.each([
		["in_progress", "[in_progress] #2 b"],
		["completed", "[completed] #3 c"],
		["deleted", "[deleted] #4 gone"],
	] as const)("list — explicit %s status queries current live state", (statusFilter, expected) => {
		const state = stateWith(
			t({ id: 1, subject: "a", status: "pending" }),
			t({ id: 2, subject: "b", status: "in_progress" }),
			t({ id: 3, subject: "c", status: "completed" }),
			t({ id: 4, subject: "gone", status: "deleted" }),
		);
		expect(formatContent({ kind: "list", includeDeleted: false, statusFilter }, state)).toBe(expected);
	});

	it("list — includeDeleted=true surfaces tombstoned rows", () => {
		const state = stateWith(t({ id: 1, subject: "x", status: "deleted" }));
		expect(formatContent({ kind: "list", includeDeleted: true }, state)).toBe("[deleted] #1 x");
	});

	it("create — defensive fallback when op.taskId is unknown to state", () => {
		// Defensive branch — exercises the early-return when find() returns undefined.
		expect(formatContent({ kind: "create", taskId: 999, status: "pending" }, stateWith())).toBe(
			"Created #999 (pending)",
		);
	});

	it("batch — summarizes each committed operation", () => {
		const state = stateWith(t({ id: 1, subject: "alpha" }), t({ id: 2, subject: "beta", status: "deleted" }));
		expect(
			formatContent(
				{
					kind: "batch",
					operations: [
						{ kind: "create", taskId: 1, status: "pending" },
						{ kind: "delete", id: 2, subject: "beta" },
					],
				},
				state,
			),
		).toBe("Applied 2 todo operations\n- Created #1: alpha (pending)\n- Deleted #2: beta");
	});

	it("error — 'Error: <message>'", () => {
		expect(formatContent({ kind: "error", message: "subject required for create" }, stateWith())).toBe(
			"Error: subject required for create",
		);
	});
});

describe("buildToolResult", () => {
	it("mutation details contain a V2 checkpoint and canonical live state", () => {
		const state = { ...stateWith(t({ id: 1, subject: "alpha" })), revision: 1 };
		const env = buildToolResult("create", { subject: "alpha" }, state, {
			kind: "create",
			taskId: 1,
			status: "pending",
		});
		expect(env).toEqual({
			content: [{ type: "text", text: "Created #1: alpha (pending)" }],
			details: {
				schemaVersion: 2,
				kind: "checkpoint",
				action: "create",
				params: { subject: "alpha" },
				state,
			},
		});
		expect(env.details).not.toHaveProperty("tasks");
		expect(env.details).not.toHaveProperty("nextId");
	});

	it("drops retired and unknown fields from top-level and nested batch params", () => {
		const state = { ...stateWith(t({ id: 1, subject: "first" })), revision: 1 };
		const env = buildToolResult(
			"batch",
			{
				action: "batch",
				blockedBy: [99],
				unknown: "drop me",
				operations: [
					{
						action: "create",
						subject: "first",
						status: "pending",
						blockedBy: [99],
						unknown: "drop me too",
					},
					{ action: "update", id: 1, status: "completed", addBlockedBy: [2] },
					{ action: "delete", id: 2, removeBlockedBy: [1], subject: "ignored" },
				],
			},
			state,
			{ kind: "batch", operations: [] },
		);
		expect(env.details).toMatchObject({
			kind: "checkpoint",
			params: {
				action: "batch",
				operations: [
					{ action: "create", subject: "first", status: "pending" },
					{ action: "update", id: 1, status: "completed" },
					{ action: "delete", id: 2 },
				],
			},
		});
		expect(JSON.stringify(env.details)).not.toContain("blockedBy");
		expect(JSON.stringify(env.details)).not.toContain("unknown");
	});

	it.each(["list", "get"] as const)("%s details are lightweight query envelopes", (action) => {
		const state = stateWith(t({ id: 1, subject: "alpha" }));
		const op: Op = action === "list"
			? { kind: "list", includeDeleted: false }
			: { kind: "get", task: state.tasks[0]! };
		const env = buildToolResult(action, action === "get" ? { id: 1 } : {}, state, op);
		expect(env.details).toEqual({ schemaVersion: 2, kind: "query", action });
		expect(env.details).not.toHaveProperty("state");
		expect(env.details).not.toHaveProperty("tasks");
		expect(env.details).not.toHaveProperty("nextId");
		expect(env.details).not.toHaveProperty("params");
	});
});
