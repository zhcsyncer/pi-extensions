import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { EMPTY_STATE, type TaskState } from "./state.js";
import { createTodoStore } from "./store.js";

function makeTask(id: number, subject = `t${id}`): Task {
	return { id, subject, status: "pending" };
}

describe("rpiv-todo/state/store — isolated accessors and seams", () => {
	it("isolates state between extension runtimes", () => {
		const first = createTodoStore();
		const second = createTodoStore();
		first.commitState({ tasks: [makeTask(1, "first")], nextId: 2 });
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
		const next: TaskState = { tasks: [makeTask(1)], nextId: 2 };
		store.commitState(next);
		expect(store.getTodos()).toBe(next.tasks);
		expect(store.getTodos()).toEqual([makeTask(1)]);
	});

	it("getState() matches the task and next-id accessors", () => {
		const store = createTodoStore();
		const next: TaskState = { tasks: [makeTask(7, "lucky")], nextId: 8 };
		store.commitState(next);
		const snap = store.getState();
		expect(snap).toBe(next);
		expect(snap.tasks).toBe(store.getTodos());
		expect(snap.nextId).toBe(store.getNextId());
	});

	it("replaceState() publishes a replayed cell wholesale", () => {
		const store = createTodoStore();
		const replayed: TaskState = {
			tasks: [makeTask(10, "from-branch"), makeTask(11, "from-branch-2")],
			nextId: 12,
		};
		store.replaceState(replayed);
		expect(store.getState()).toBe(replayed);
		expect(store.getTodos()).toEqual(replayed.tasks);
		expect(store.getNextId()).toBe(12);
	});

	it("reset() clears only that store", () => {
		const first = createTodoStore();
		const second = createTodoStore();
		first.commitState({ tasks: [makeTask(1)], nextId: 2 });
		second.commitState({ tasks: [makeTask(2)], nextId: 3 });
		first.reset();
		expect(first.getTodos()).toEqual([]);
		expect(first.getNextId()).toBe(1);
		expect(second.getTodos()).toEqual([makeTask(2)]);
	});
});
