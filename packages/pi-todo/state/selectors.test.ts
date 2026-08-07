import { describe, expect, it } from "vitest";
import type { Task } from "../tool/types.js";
import { selectOverlayLayout } from "./selectors.js";

function layout(tasks: Task[], budget: number) {
	return selectOverlayLayout({ tasks, nextId: tasks.length + 1 }, budget);
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
