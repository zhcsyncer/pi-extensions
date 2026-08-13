import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { applyTaskMutation } from "./state-reducer.js";

const emptyState = (): TaskState => ({
	tasks: [],
	nextId: 1,
	generation: 1,
	revision: 0,
});

const stateWith = (...tasks: Task[]): TaskState => ({
	tasks: [...tasks],
	nextId: Math.max(0, ...tasks.map((t) => t.id)) + 1,
	generation: 1,
	revision: 0,
});

const task = (overrides: Partial<Task> & { id: number; subject: string }): Task => ({
	status: "pending",
	...overrides,
});

describe("applyTaskMutation — create", () => {
	it("rejects empty subject", () => {
		const result = applyTaskMutation(emptyState(), "create", { subject: "" });
		expect(result.op).toEqual({ kind: "error", message: "subject required for create" });
		expect(result.state.tasks).toHaveLength(0);
		expect(result.state.nextId).toBe(1);
	});

	it("creates directly in_progress without an auxiliary activity label", () => {
		const result = applyTaskMutation(emptyState(), "create", { subject: "x", status: "in_progress" });
		expect(result.op).toEqual({ kind: "create", taskId: 1, status: "in_progress" });
		expect(result.state.tasks[0]).toMatchObject({ status: "in_progress" });
	});

	it("rejects direct in_progress create while another task is active", () => {
		const active = stateWith(task({ id: 1, subject: "active", status: "in_progress" }));
		expect(applyTaskMutation(active, "create", { subject: "next", status: "in_progress" }).op).toEqual({
			kind: "error",
			message: "cannot create #2 in_progress: #1 is already in_progress; complete or re-queue #1 first",
		});
	});

	it("rejects terminal initial status", () => {
		expect(applyTaskMutation(emptyState(), "create", { subject: "x", status: "completed" }).op).toEqual({
			kind: "error",
			message: "cannot create #1 with status completed; use pending or in_progress",
		});
	});

	it("creates with next id and preserves immutability", () => {
		const state = emptyState();
		const result = applyTaskMutation(state, "create", { subject: "write tests" });
		expect(result.state.tasks).toHaveLength(1);
		expect(result.state.tasks[0]).toMatchObject({ id: 1, subject: "write tests", status: "pending" });
		expect(result.state.nextId).toBe(2);
		expect(result.state.revision).toBe(1);
		expect(result.state.tasks).not.toBe(state.tasks);
		expect(result.op).toEqual({ kind: "create", taskId: 1, status: "pending" });
	});
});

describe("applyTaskMutation — update", () => {
	it("rejects id-only update", () => {
		const state = stateWith(task({ id: 1, subject: "x" }));
		const result = applyTaskMutation(state, "update", { id: 1 });
		expect(result.op).toEqual({ kind: "error", message: "update requires at least one mutable field" });
	});

	it("rejects illegal transition completed → in_progress", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "completed" }));
		const result = applyTaskMutation(state, "update", { id: 1, status: "in_progress" });
		expect(result.op).toEqual({
			kind: "error",
			message: "cannot update #1: illegal transition completed → in_progress",
		});
	});

	it("allows pending → completed reconciliation and in_progress → pending re-queue", () => {
		const pending = stateWith(task({ id: 1, subject: "x" }));
		const completed = applyTaskMutation(pending, "update", { id: 1, status: "completed" });
		expect(completed.op).toEqual({ kind: "update", id: 1, fromStatus: "pending", toStatus: "completed" });

		const active = stateWith(task({ id: 1, subject: "x", status: "in_progress" }));
		const requeued = applyTaskMutation(active, "update", { id: 1, status: "pending" });
		expect(requeued.op).toEqual({ kind: "update", id: 1, fromStatus: "in_progress", toStatus: "pending" });
	});

	it("enforces a single in-progress task", () => {
		const state = stateWith(task({ id: 1, subject: "a" }), task({ id: 2, subject: "b" }));
		const started = applyTaskMutation(state, "update", { id: 1, status: "in_progress" }).state;
		expect(
			applyTaskMutation(started, "update", {
				id: 2,
				status: "in_progress",
			}).op,
		).toEqual({
			kind: "error",
			message: "cannot start #2: #1 is already in_progress; complete or re-queue #1 before starting #2",
		});
	});

	it("completes an in-progress task", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "in_progress" }));
		const result = applyTaskMutation(state, "update", { id: 1, status: "completed" });
		expect(result.state.tasks[0].status).toBe("completed");
	});

	it("allows completed → deleted transition", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "completed" }));
		const result = applyTaskMutation(state, "update", { id: 1, status: "deleted" });
		expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "completed", toStatus: "deleted" });
		expect(result.state.tasks[0].status).toBe("deleted");
	});

	it("drops metadata key when value is null", () => {
		const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1, b: 2 } }));
		const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: null } });
		expect(result.state.tasks[0].metadata).toEqual({ b: 2 });
	});

	it("sets and overwrites metadata keys when value is non-null", () => {
		// Covers the merged[k] = v branch (non-null partial merge): a is overwritten,
		// b is preserved, c is added.
		const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1, b: 2 } }));
		const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: 99, c: 3 } });
		expect(result.state.tasks[0].metadata).toEqual({ a: 99, b: 2, c: 3 });
	});

	it("collapses metadata to undefined when every key is deleted", () => {
		// Covers the Object.keys(merged).length ? merged : undefined branch where
		// every existing key gets nulled out.
		const state = stateWith(task({ id: 1, subject: "x", metadata: { a: 1 } }));
		const result = applyTaskMutation(state, "update", { id: 1, metadata: { a: null } });
		expect("metadata" in result.state.tasks[0]).toBe(false);
	});
});

describe("applyTaskMutation — batch", () => {
	it("creates the first task in_progress and the remaining tasks pending in one batch", () => {
		const result = applyTaskMutation(emptyState(), "batch", {
			operations: [
				{ action: "create", subject: "first", status: "in_progress" },
				{ action: "create", subject: "second" },
				{ action: "create", subject: "third" },
			],
		});
		expect(result.op).toEqual({
			kind: "batch",
			operations: [
				{ kind: "create", taskId: 1, status: "in_progress" },
				{ kind: "create", taskId: 2, status: "pending" },
				{ kind: "create", taskId: 3, status: "pending" },
			],
		});
		expect(result.state.tasks.map(({ status }) => status)).toEqual(["in_progress", "pending", "pending"]);
	});

	it("commits ordered operations atomically", () => {
		const state = stateWith(
			task({ id: 1, subject: "first", status: "in_progress" }),
			task({ id: 2, subject: "second" }),
		);
		const result = applyTaskMutation(state, "batch", {
			operations: [
				{ action: "update", id: 1, status: "completed" },
				{ action: "update", id: 2, status: "in_progress" },
				{ action: "create", subject: "third" },
			],
		});
		expect(result.op.kind).toBe("batch");
		expect(result.state.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
			{ id: 1, status: "completed" },
			{ id: 2, status: "in_progress" },
			{ id: 3, status: "pending" },
		]);
	});

	it("reports both task ids when batch order tries to start a second active task", () => {
		const state = stateWith(
			task({ id: 3, subject: "current", status: "in_progress" }),
			task({ id: 4, subject: "next" }),
			task({ id: 5, subject: "later" }),
		);
		const result = applyTaskMutation(state, "batch", {
			operations: [
				{ action: "update", id: 3, status: "completed" },
				{ action: "update", id: 4, status: "in_progress" },
				{ action: "update", id: 5, status: "in_progress" },
			],
		});
		expect(result.op).toEqual({
			kind: "error",
			message:
				"batch operation 3 (update #5 → in_progress): cannot start #5: #4 is already in_progress; complete or re-queue #4 before starting #5",
		});
		expect(result.state).toBe(state);
	});

	it("rolls back every operation when one fails", () => {
		const state = emptyState();
		const result = applyTaskMutation(state, "batch", {
			operations: [
				{ action: "create", subject: "would be rolled back" },
				{ action: "update", id: 99, status: "in_progress" },
			],
		});
		expect(result.op).toEqual({
			kind: "error",
			message: "batch operation 2 (update #99 → in_progress): #99 not found",
		});
		expect(result.state).toBe(state);
		expect(result.state.tasks).toEqual([]);
	});

	it("rejects an empty batch", () => {
		expect(applyTaskMutation(emptyState(), "batch", { operations: [] }).op).toEqual({
			kind: "error",
			message: "operations required for batch",
		});
	});
});

describe("applyTaskMutation — list/get/delete", () => {
	it("list emits Op with includeDeleted flag and optional statusFilter", () => {
		const state = stateWith(
			task({ id: 1, subject: "a", status: "pending" }),
			task({ id: 2, subject: "b", status: "deleted" }),
		);
		const result = applyTaskMutation(state, "list", { includeDeleted: true, status: "deleted" });
		expect(result.op).toEqual({ kind: "list", includeDeleted: true, statusFilter: "deleted" });
		expect(result.state).toBe(state);
	});

	it("delete on already-deleted task errors", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "deleted" }));
		const result = applyTaskMutation(state, "delete", { id: 1 });
		expect(result.op).toEqual({ kind: "error", message: "#1 is already deleted" });
	});

	it("delete emits Op and tombstones an in-progress task", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "in_progress" }));
		const result = applyTaskMutation(state, "delete", { id: 1 });
		expect(result.op).toEqual({ kind: "delete", id: 1, subject: "x" });
		expect(result.state.tasks[0].status).toBe("deleted");
		expect(result.state.revision).toBe(1);
	});

	it("get emits Op with the resolved task", () => {
		const state = stateWith(task({ id: 1, subject: "alpha" }));
		const result = applyTaskMutation(state, "get", { id: 1 });
		expect(result.op).toEqual({ kind: "get", task: state.tasks[0] });
	});
});

describe("applyTaskMutation — rollover and revisions", () => {
	it("rolls terminal live state over before a top-level create without reusing ids", () => {
		const state: TaskState = {
			tasks: [
				task({ id: 10, subject: "done", status: "completed" }),
				task({ id: 11, subject: "gone", status: "deleted" }),
			],
			nextId: 12,
			generation: 4,
			revision: 9,
		};
		const result = applyTaskMutation(state, "create", { subject: "new cycle" });
		expect(result.state).toEqual({
			tasks: [{ id: 12, subject: "new cycle", status: "pending" }],
			nextId: 13,
			generation: 5,
			revision: 10,
		});
		expect(applyTaskMutation(result.state, "get", { id: 10 }).op).toEqual({
			kind: "error",
			message: "#10 not found",
		});
	});

	it("rolls over once before a create-containing batch", () => {
		const state: TaskState = {
			tasks: [task({ id: 5, subject: "done", status: "completed" })],
			nextId: 6,
			generation: 2,
			revision: 4,
		};
		const result = applyTaskMutation(state, "batch", {
			operations: [
				{ action: "create", subject: "first", status: "in_progress" },
				{ action: "create", subject: "second" },
			],
		});
		expect(result.state.tasks.map((item) => item.id)).toEqual([6, 7]);
		expect(result.state.generation).toBe(3);
		expect(result.state.revision).toBe(5);
	});

	it("does not roll over again when a batch becomes terminal before creating", () => {
		const state: TaskState = {
			tasks: [task({ id: 10, subject: "current", status: "in_progress" })],
			nextId: 11,
			generation: 3,
			revision: 7,
		};
		const result = applyTaskMutation(state, "batch", {
			operations: [
				{ action: "update", id: 10, status: "completed" },
				{ action: "create", subject: "same cycle" },
			],
		});
		expect(result.state.tasks.map(({ id, status }) => ({ id, status }))).toEqual([
			{ id: 10, status: "completed" },
			{ id: 11, status: "pending" },
		]);
		expect(result.state.generation).toBe(3);
		expect(result.state.revision).toBe(8);
	});

	it("rolls back a pre-batch rollover when an operation fails", () => {
		const state: TaskState = {
			tasks: [task({ id: 4, subject: "done", status: "completed" })],
			nextId: 5,
			generation: 2,
			revision: 3,
		};
		const result = applyTaskMutation(state, "batch", {
			operations: [
				{ action: "create", subject: "temporary" },
				{ action: "update", id: 99, status: "in_progress" },
			],
		});
		expect(result.state).toBe(state);
		expect(result.state.generation).toBe(2);
		expect(result.state.nextId).toBe(5);
	});

	it("does not increment revision for list/get queries or failed mutations", () => {
		const state = stateWith(task({ id: 1, subject: "x" }));
		expect(applyTaskMutation(state, "list", {}).state).toBe(state);
		expect(applyTaskMutation(state, "get", { id: 1 }).state).toBe(state);
		expect(applyTaskMutation(state, "create", { subject: "" }).state).toBe(state);
		expect(state.revision).toBe(0);
	});
});

describe("isTransitionValid", () => {
	it("is idempotent on same→same", () => {
		expect(isTransitionValid("completed", "completed")).toBe(true);
	});

	it("rejects completed → in_progress", () => {
		expect(isTransitionValid("completed", "in_progress")).toBe(false);
	});

	it("allows completed → deleted", () => {
		expect(isTransitionValid("completed", "deleted")).toBe(true);
	});

	it("allows pending completion reconciliation and interrupt-driven requeue", () => {
		expect(isTransitionValid("pending", "completed")).toBe(true);
		expect(isTransitionValid("in_progress", "pending")).toBe(true);
	});
});
