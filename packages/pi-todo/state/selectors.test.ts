import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import {
	formatCurrentTodoState,
	formatCurrentTodoStateUpdate,
	selectOverlayLayout,
} from "./selectors.js";
import type { TaskState } from "./state.js";

function stateWith(tasks: Task[]): TaskState {
	return {
		tasks,
		nextId: Math.max(0, ...tasks.map((task) => task.id)) + 1,
		generation: 1,
		revision: 0,
	};
}

function layout(tasks: Task[], budget: number) {
	return selectOverlayLayout(stateWith(tasks), budget);
}

describe("selectOverlayLayout overflow priority", () => {
	it("keeps a later in-progress task ahead of earlier pending tasks", () => {
		const result = layout(
			[
				{ id: 1, subject: "pending-1", status: "pending" },
				{ id: 2, subject: "pending-2", status: "pending" },
				{ id: 3, subject: "active", status: "in_progress" },
			],
			2,
		);

		expect(result.visible.map((task) => task.id)).toEqual([3]);
		expect(result.hiddenPending).toBe(2);
		expect(result.hiddenCompleted).toBe(0);
	});

	it("admits pending tasks before completed tasks", () => {
		const result = layout(
			[
				{ id: 1, subject: "completed-1", status: "completed" },
				{ id: 2, subject: "pending-1", status: "pending" },
				{ id: 3, subject: "completed-2", status: "completed" },
				{ id: 4, subject: "pending-2", status: "pending" },
			],
			3,
		);

		expect(result.visible.map((task) => task.id)).toEqual([2, 4]);
		expect(result.hiddenPending).toBe(0);
		expect(result.hiddenCompleted).toBe(2);
	});

	it("returns admitted tasks in natural store order rather than priority order", () => {
		const result = layout(
			[
				{ id: 1, subject: "pending-1", status: "pending" },
				{ id: 2, subject: "completed", status: "completed" },
				{ id: 3, subject: "active", status: "in_progress" },
				{ id: 4, subject: "pending-2", status: "pending" },
				{ id: 5, subject: "completed-2", status: "completed" },
			],
			4,
		);

		expect(result.visible.map((task) => task.id)).toEqual([1, 3, 4]);
		expect(result.hiddenCompleted).toBe(2);
	});
});

describe("formatCurrentTodoState", () => {
	it("includes only active ids, statuses, subjects, and completed count", () => {
		const summary = formatCurrentTodoState(
			stateWith([
				{ id: 10, subject: "Implement\nchanges", status: "in_progress", description: "secret" },
				{
					id: 11,
					subject: "Validate",
					status: "pending",
					metadata: { hidden: true },
				},
				{ id: 12, subject: "Done", status: "completed", description: "omit" },
				{ id: 13, subject: "Deleted", status: "deleted" },
			]),
		);
		expect(summary).toBe(
			"Current Todo state:\n" +
				"- #10 in_progress: Implement changes\n" +
				"- #11 pending: Validate\n" +
				"- 1 completed task hidden",
		);
		expect(summary).not.toContain("secret");
		expect(summary).not.toContain("metadata");
		expect(summary).not.toContain("Deleted");
	});

	it("returns undefined when no active task exists", () => {
		const terminal = stateWith([
			{ id: 1, subject: "done", status: "completed" },
			{ id: 2, subject: "gone", status: "deleted" },
		]);
		expect(formatCurrentTodoState(terminal)).toBeUndefined();
		expect(formatCurrentTodoStateUpdate(terminal)).toBe(
			"Current Todo state update:\n" +
				"- No pending or in_progress tasks\n" +
				"- 1 completed task hidden",
		);
	});
});
