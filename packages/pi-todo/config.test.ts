import type { Theme } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	DEFAULT_STATUS_ICON_PRESET,
	resolveStatusIconPreset,
	resolveStatusIcons,
	STATUS_ICON_PRESETS,
} from "./config.js";
import { statusIcon } from "./view/format.js";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

describe("status icon presets", () => {
	it("defaults invalid or missing values to ASCII", () => {
		expect(DEFAULT_STATUS_ICON_PRESET).toBe("ascii");
		expect(resolveStatusIconPreset(undefined)).toBe("ascii");
		expect(resolveStatusIconPreset("unknown")).toBe("ascii");
		expect(resolveStatusIcons(undefined)).toBe(STATUS_ICON_PRESETS.ascii);
	});

	it("exposes independent heading icons and the selected status symbols", () => {
		expect(resolveStatusIcons("ascii").heading).toBe("[T]");
		expect(resolveStatusIcons("unicode")).toMatchObject({ heading: "≡", pending: "○", completed: "✓" });
		expect(resolveStatusIcons("nerd-font").heading).toBe("󰝖");
		expect(resolveStatusIcons("unicode").inProgressFrames).toEqual(["◉"]);
		expect(resolveStatusIcons("nerd-font").inProgressFrames).toEqual([
			"󰪞",
			"󰪟",
			"󰪠",
			"󰪡",
			"󰪢",
			"󰪣",
			"󰪤",
			"󰪥",
		]);
	});

	it("applies semantic theme colors independently of the selected glyph set", () => {
		const icons = STATUS_ICON_PRESETS.unicode;
		expect(statusIcon("pending", theme, icons)).toBe("<dim>○</dim>");
		expect(statusIcon("in_progress", theme, icons)).toBe("<accent>◉</accent>");
		expect(statusIcon("completed", theme, icons)).toBe("<success>✓</success>");
		expect(statusIcon("deleted", theme, icons)).toBe("<error>✗</error>");
	});
});
