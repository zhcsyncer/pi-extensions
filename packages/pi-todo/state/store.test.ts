import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";
import { createTodoStore } from "./store.js";

function makeTask(id: number, subject = `t${id}`): Task {
	return { id, subject, status: "pending" };
}

function makeState(tasks: Task[], nextId: number, generation = 1, revision = 0): TaskState {
	return { tasks, nextId, generation, revision };
}

describe("rpiv-todo/state/store — isolated accessors and seams", () => {
	it("isolates state between extension runtimes", () => {
		const first = createTodoStore();
		const second = createTodoStore();
		first.commitState(makeState([makeTask(1, "first")], 2));
		expect(first.getTodos()).toEqual([makeTask(1, "first")]);
		expect(second.getTodos()).toEqual([]);
		expect(second.getNextId()).toBe(1);
	});

	it("starts with a fresh EMPTY_STATE shape", () => {
		const store = createTodoStore();
		expect(store.getTodos()).toEqual(EMPTY_STATE.tasks);
		expect(store.getNextId()).toBe(EMPTY_STATE.nextId);
		expect(store.getTodos()).not.toBe(EMPTY_STATE.tasks);
	});

	it("getTodos() returns the live tasks reference (read-only typed)", () => {
		const store = createTodoStore();
		const next = makeState([makeTask(1)], 2);
		store.commitState(next);
		expect(store.getTodos()).toBe(next.tasks);
		expect(store.getTodos()).toEqual([makeTask(1)]);
	});

	it("getState() matches the task and next-id accessors", () => {
		const store = createTodoStore();
		const next = makeState([makeTask(7, "lucky")], 8);
		store.commitState(next);
		const snap = store.getState();
		expect(snap).toBe(next);
		expect(snap.tasks).toBe(store.getTodos());
		expect(snap.nextId).toBe(store.getNextId());
	});

	it("replaceState() publishes a replayed cell wholesale", () => {
		const store = createTodoStore();
		const replayed = makeState(
			[makeTask(10, "from-branch"), makeTask(11, "from-branch-2")],
			12,
			3,
			8,
		);
		store.replaceState(replayed);
		expect(store.getState()).toBe(replayed);
		expect(store.getTodos()).toEqual(replayed.tasks);
		expect(store.getNextId()).toBe(12);
	});

	it("reset() clears only that store while preserving its next id", () => {
		const first = createTodoStore();
		const second = createTodoStore();
		first.commitState(makeState([makeTask(1)], 2, 2, 5));
		second.commitState(makeState([makeTask(2)], 3));
		first.reset();
		expect(first.getTodos()).toEqual([]);
		expect(first.getNextId()).toBe(2);
		expect(first.getState()).toMatchObject({ generation: 3, revision: 6 });
		expect(second.getTodos()).toEqual([makeTask(2)]);
	});
});
