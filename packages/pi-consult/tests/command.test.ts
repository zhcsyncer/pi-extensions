import { describe, expect, it } from "vitest";
import { applyConsultSetting } from "../src/command.ts";
import { DEFAULT_CONSULT_CONFIG } from "../src/config.ts";
import { NONE_VALUE, OFF_VALUE } from "../src/messages.ts";

describe("consult settings", () => {
	it("defaults a new advisor to high effort", () => {
		const config = applyConsultSetting(DEFAULT_CONSULT_CONFIG, "panel0", "anthropic/claude-fable-5");
		expect(config.panel).toEqual([{ model: "anthropic/claude-fable-5", effort: "high" }]);
	});

	it("clears the panel when advisor 1 is none", () => {
		const config = applyConsultSetting(
			{ ...DEFAULT_CONSULT_CONFIG, panel: [{ model: "a/b" }, { model: "c/d" }], fanout: true },
			"panel0",
			NONE_VALUE,
		);
		expect(config.panel).toEqual([]);
		expect(config.fanout).toBe(false);
	});

	it("sets advisor 2 only after advisor 1 exists", () => {
		const empty = applyConsultSetting(DEFAULT_CONSULT_CONFIG, "panel1", "x/y");
		expect(empty.panel).toEqual([]);
		const withFirst = applyConsultSetting({ ...DEFAULT_CONSULT_CONFIG, panel: [{ model: "a/b" }] }, "panel1", "x/y");
		expect(withFirst.panel).toEqual([{ model: "a/b" }, { model: "x/y" }]);
	});

	it("clears effort with off and toggles gates", () => {
		const withEffort = applyConsultSetting(
			{ ...DEFAULT_CONSULT_CONFIG, panel: [{ model: "a/b", effort: "high" }] },
			"effort0",
			OFF_VALUE,
		);
		expect(withEffort.panel[0]).toEqual({ model: "a/b" });
		expect(applyConsultSetting(DEFAULT_CONSULT_CONFIG, "loop", "off").gates.loop).toBe(0);
		expect(applyConsultSetting(DEFAULT_CONSULT_CONFIG, "loop", "5").gates.loop).toBe(5);
		expect(applyConsultSetting(DEFAULT_CONSULT_CONFIG, "fanout", "on").fanout).toBe(true);
	});
});
