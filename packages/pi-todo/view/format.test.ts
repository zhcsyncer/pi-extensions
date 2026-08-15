import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { STATUS_ICON_PRESETS } from "../config.js";
import type { Task, TaskStatus } from "../tool/types.js";
import { formatOverlayTaskLine } from "./format.js";

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
			"<dim>[ ]</dim> <muted>waiting</muted>",
		],
		[
			task(2, "working", "in_progress"),
			"<accent>[>]</accent> <accent><bold>working</bold></accent>",
		],
		[
			task(3, "finished", "completed"),
			"<success>[x]</success> <dim><strike>finished</strike></dim>",
		],
		[
			task(4, "removed", "deleted"),
			"<error>[!]</error> <error><strike>removed</strike></error>",
		],
	] as const)("styles $status overlay rows by status", (value, expected) => {
		expect(formatOverlayTaskLine(value, theme, STATUS_ICON_PRESETS.ascii)).toBe(expected);
	});
});
