import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";
import { __resetState, commitState, getNextId, getState, getTodos, replaceState } from "./store.js";

function makeTask(id: number, subject = `t${id}`): Task {
	return { id, subject, status: "pending" };
}

describe("rpiv-todo/state/store — accessors and seams", () => {
	it("__resetState() restores EMPTY_STATE shape (independent of EMPTY_STATE.tasks identity)", () => {
		__resetState();
		expect(getTodos()).toEqual(EMPTY_STATE.tasks);
		expect(getNextId()).toBe(EMPTY_STATE.nextId);
		// Reset clones — must NOT alias EMPTY_STATE.tasks (else mutations leak).
		expect(getTodos()).not.toBe(EMPTY_STATE.tasks);
	});

	it("getTodos() returns the live tasks reference (read-only typed)", () => {
		__resetState();
		const next: TaskState = { tasks: [makeTask(1)], nextId: 2 };
		commitState(next);
		expect(getTodos()).toBe(next.tasks);
		expect(getTodos()).toEqual([makeTask(1)]);
	});

	it("getNextId() reflects the current cell value", () => {
		__resetState();
		commitState({ tasks: [], nextId: 42 });
		expect(getNextId()).toBe(42);
	});

	it("getState() returns the same cell that getTodos/getNextId read from", () => {
		__resetState();
		const next: TaskState = { tasks: [makeTask(7, "lucky")], nextId: 8 };
		commitState(next);
		const snap = getState();
		expect(snap).toBe(next);
		expect(snap.tasks).toBe(getTodos());
		expect(snap.nextId).toBe(getNextId());
	});

	it("replaceState() publishes a new cell wholesale (replay seam)", () => {
		__resetState();
		const replayed: TaskState = {
			tasks: [makeTask(10, "from-branch"), makeTask(11, "from-branch-2")],
			nextId: 12,
		};
		replaceState(replayed);
		expect(getState()).toBe(replayed);
		expect(getTodos()).toEqual(replayed.tasks);
		expect(getNextId()).toBe(12);
	});

	it("commitState() and replaceState() are interchangeable seams over the same cell", () => {
		__resetState();
		commitState({ tasks: [makeTask(1)], nextId: 2 });
		expect(getNextId()).toBe(2);
		replaceState({ tasks: [], nextId: 99 });
		expect(getTodos()).toEqual([]);
		expect(getNextId()).toBe(99);
	});

	it("__resetState() after a commit clears the cell (test-isolation contract)", () => {
		commitState({ tasks: [makeTask(1)], nextId: 2 });
		__resetState();
		expect(getTodos()).toEqual([]);
		expect(getNextId()).toBe(1);
	});
});
