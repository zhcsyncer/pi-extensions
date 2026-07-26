import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { STATUS_ICON_PRESETS } from "../config.js";
import type { Task, TaskStatus } from "../tool/types.js";
import { formatCommandTaskLine, formatOverlayTaskLine } from "./format.js";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
	bold: (text: string) => `<bold>${text}</bold>`,
	strikethrough: (text: string) => `<strike>${text}</strike>`,
} as unknown as Theme;

function task(id: number, subject: string, status: TaskStatus): Task {
	return { id, subject, status };
}

describe("status-aware task text styling", () => {
	it.each([
		[
			task(1, "waiting", "pending"),
			"<dim>[ ]</dim> <dim>#1</dim> <muted>waiting</muted>",
		],
		[
			task(2, "working", "in_progress"),
			"<accent>[>]</accent> <accent>#2</accent> <accent><bold>working</bold></accent>",
		],
		[
			task(3, "finished", "completed"),
			"<success>[x]</success> <dim>#3</dim> <dim><strike>finished</strike></dim>",
		],
		[
			task(4, "removed", "deleted"),
			"<error>[!]</error> <dim>#4</dim> <error><strike>removed</strike></error>",
		],
	] as const)("styles $status overlay rows by status", (value, expected) => {
		expect(formatOverlayTaskLine(value, theme, true, STATUS_ICON_PRESETS.ascii)).toBe(expected);
	});

	it("uses the same subject and id hierarchy in /todos output", () => {
		const value = task(2, "working", "in_progress");
		expect(formatCommandTaskLine(value, "<accent>[>]</accent>", theme)).toBe(
			"  <accent>[>]</accent> <accent>#2</accent> <accent><bold>working</bold></accent>",
		);
	});

	it("keeps dependency details dim", () => {
		const value = { ...task(1, "blocked", "pending"), blockedBy: [2, 3] };
		expect(formatCommandTaskLine(value, "<dim>[ ]</dim>", theme)).toContain(
			"<dim>    ⛓ #2,#3</dim>",
		);
	});
});
