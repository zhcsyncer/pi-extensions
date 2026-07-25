import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { isTransitionValid } from "./invariants.js";
import type { TaskState } from "./state.js";
import { applyTaskMutation } from "./state-reducer.js";

const emptyState = (): TaskState => ({ tasks: [], nextId: 1 });

const stateWith = (...tasks: Task[]): TaskState => ({
	tasks: [...tasks],
	nextId: Math.max(0, ...tasks.map((t) => t.id)) + 1,
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

	it("rejects activeForm on a pending create", () => {
		const result = applyTaskMutation(emptyState(), "create", { subject: "x", activeForm: "Working" });
		expect(result.op).toEqual({
			kind: "error",
			message: "activeForm is only valid when status is in_progress",
		});
	});

	it("rejects dangling blockedBy", () => {
		const result = applyTaskMutation(emptyState(), "create", { subject: "x", blockedBy: [99] });
		expect(result.op).toEqual({ kind: "error", message: "blockedBy: #99 not found" });
		expect(result.state.nextId).toBe(1);
	});

	it("rejects deleted blockedBy", () => {
		const state = stateWith(task({ id: 1, subject: "done", status: "deleted" }));
		const result = applyTaskMutation(state, "create", { subject: "new", blockedBy: [1] });
		expect(result.op).toEqual({ kind: "error", message: "blockedBy: #1 is deleted" });
	});

	it("creates with next id and preserves immutability", () => {
		const state = emptyState();
		const result = applyTaskMutation(state, "create", { subject: "write tests" });
		expect(result.state.tasks).toHaveLength(1);
		expect(result.state.tasks[0]).toMatchObject({ id: 1, subject: "write tests", status: "pending" });
		expect(result.state.nextId).toBe(2);
		expect(result.state.tasks).not.toBe(state.tasks);
		expect(result.op).toEqual({ kind: "create", taskId: 1 });
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
			message: "illegal transition completed → in_progress",
		});
	});

	it("rejects pending → completed but allows re-queuing in_progress → pending", () => {
		const pending = stateWith(task({ id: 1, subject: "x" }));
		expect(applyTaskMutation(pending, "update", { id: 1, status: "completed" }).op).toEqual({
			kind: "error",
			message: "illegal transition pending → completed",
		});
		const active = stateWith(task({ id: 1, subject: "x", status: "in_progress", activeForm: "Working" }));
		const requeued = applyTaskMutation(active, "update", { id: 1, status: "pending" });
		expect(requeued.op).toEqual({ kind: "update", id: 1, fromStatus: "in_progress", toStatus: "pending" });
		expect("activeForm" in requeued.state.tasks[0]).toBe(false);
	});

	it("requires activeForm and enforces a single in-progress task", () => {
		const state = stateWith(task({ id: 1, subject: "a" }), task({ id: 2, subject: "b" }));
		expect(applyTaskMutation(state, "update", { id: 1, status: "in_progress" }).op).toEqual({
			kind: "error",
			message: "activeForm required when status is in_progress",
		});
		const started = applyTaskMutation(state, "update", {
			id: 1,
			status: "in_progress",
			activeForm: "Working on a",
		}).state;
		expect(
			applyTaskMutation(started, "update", {
				id: 2,
				status: "in_progress",
				activeForm: "Working on b",
			}).op,
		).toEqual({ kind: "error", message: "another task is already in_progress: #1" });
	});

	it("prevents blocked tasks from starting until dependencies complete", () => {
		const state = stateWith(task({ id: 1, subject: "base" }), task({ id: 2, subject: "next", blockedBy: [1] }));
		const result = applyTaskMutation(state, "update", {
			id: 2,
			status: "in_progress",
			activeForm: "Working",
		});
		expect(result.op).toEqual({ kind: "error", message: "#2 is blocked by incomplete task #1" });
	});

	it("clears activeForm when an in-progress task completes", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "in_progress", activeForm: "Working" }));
		const result = applyTaskMutation(state, "update", { id: 1, status: "completed" });
		expect(result.state.tasks[0].status).toBe("completed");
		expect("activeForm" in result.state.tasks[0]).toBe(false);
	});

	it("allows completed → deleted transition", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "completed" }));
		const result = applyTaskMutation(state, "update", { id: 1, status: "deleted" });
		expect(result.op).toEqual({ kind: "update", id: 1, fromStatus: "completed", toStatus: "deleted" });
		expect(result.state.tasks[0].status).toBe("deleted");
	});

	it("rejects self-block via addBlockedBy", () => {
		const state = stateWith(task({ id: 1, subject: "x" }));
		const result = applyTaskMutation(state, "update", { id: 1, addBlockedBy: [1] });
		expect(result.op).toEqual({ kind: "error", message: "cannot block #1 on itself" });
	});

	it("rejects cycle in blockedBy graph", () => {
		const state = stateWith(task({ id: 1, subject: "a", blockedBy: [2] }), task({ id: 2, subject: "b" }));
		const result = applyTaskMutation(state, "update", { id: 2, addBlockedBy: [1] });
		expect(result.op).toEqual({
			kind: "error",
			message: "addBlockedBy would create a cycle in the blockedBy graph",
		});
	});

	it("drops blockedBy field when merged set becomes empty", () => {
		const state = stateWith(task({ id: 1, subject: "a", blockedBy: [2] }), task({ id: 2, subject: "b" }));
		const result = applyTaskMutation(state, "update", { id: 1, removeBlockedBy: [2] });
		const updated = result.state.tasks[0];
		expect("blockedBy" in updated).toBe(false);
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
	it("commits ordered operations atomically", () => {
		const state = stateWith(
			task({ id: 1, subject: "first", status: "in_progress", activeForm: "Working" }),
			task({ id: 2, subject: "second" }),
		);
		const result = applyTaskMutation(state, "batch", {
			operations: [
				{ action: "update", id: 1, status: "completed" },
				{ action: "update", id: 2, status: "in_progress", activeForm: "Working on second" },
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

	it("rolls back every operation when one fails", () => {
		const state = emptyState();
		const result = applyTaskMutation(state, "batch", {
			operations: [
				{ action: "create", subject: "would be rolled back" },
				{ action: "update", id: 99, status: "in_progress", activeForm: "Missing" },
			],
		});
		expect(result.op).toEqual({ kind: "error", message: "batch operation 2: #99 not found" });
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

describe("applyTaskMutation — list/get/delete/clear", () => {
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

	it("delete emits Op and clears an in-progress label", () => {
		const state = stateWith(task({ id: 1, subject: "x", status: "in_progress", activeForm: "Working" }));
		const result = applyTaskMutation(state, "delete", { id: 1 });
		expect(result.op).toEqual({ kind: "delete", id: 1, subject: "x" });
		expect(result.state.tasks[0].status).toBe("deleted");
		expect("activeForm" in result.state.tasks[0]).toBe(false);
	});

	it("clear emits Op with prior count and resets nextId to 1", () => {
		const state = stateWith(task({ id: 5, subject: "x" }));
		const result = applyTaskMutation(state, "clear", {});
		expect(result.op).toEqual({ kind: "clear", count: 1 });
		expect(result.state.tasks).toHaveLength(0);
		expect(result.state.nextId).toBe(1);
	});

	it("get emits Op with the resolved task", () => {
		const state = stateWith(task({ id: 1, subject: "alpha" }));
		const result = applyTaskMutation(state, "get", { id: 1 });
		expect(result.op).toEqual({ kind: "get", task: state.tasks[0] });
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

	it("rejects pending completion shortcuts but allows blocker-driven requeue", () => {
		expect(isTransitionValid("pending", "completed")).toBe(false);
		expect(isTransitionValid("in_progress", "pending")).toBe(true);
	});
});
