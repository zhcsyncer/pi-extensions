import { describe, expect, it } from "vitest";
import { cloneCompanionConfig } from "../src/config.ts";
import {
	applyFixedCompanionSetting,
	buildCompanionSettingItems,
	formatBlockedRules,
	parseBlockedRulesText,
} from "../src/config-ui.ts";

describe("companion config TUI model", () => {
	it("exposes every configuration group and explicit save/discard actions", () => {
		const ids = buildCompanionSettingItems(cloneCompanionConfig()).map((item) => item.id);
		expect(ids).toEqual([
			"runtime.injectSystemPrompt",
			"process.defaultDirection",
			"process.defaultShell",
			"edit-ratio",
			"edit-timeout",
			"process.defaultLifetime",
			"edit-events",
			"edit-tools",
			"reset",
			"save",
			"discard",
		]);
	});

	it("applies fixed settings to a draft without touching unrelated groups", () => {
		const draft = cloneCompanionConfig();
		applyFixedCompanionSetting(draft, "runtime.injectSystemPrompt", "off");
		applyFixedCompanionSetting(draft, "process.defaultDirection", "right");
		applyFixedCompanionSetting(draft, "process.defaultShell", "pane");
		expect(draft.runtime.injectSystemPrompt).toBe(false);
		expect(draft.process.defaultDirection).toBe("right");
		expect(draft.process.defaultShell).toBe("pane");
		expect(draft.blocked.tools).toEqual([{ name: "ask_user_question", label: "question" }]);
		expect(() => applyFixedCompanionSetting(draft, "btw.tools", "none")).toThrow(/Unknown companion setting/);
	});

	it("round-trips editable event/tool rules and validates exact names", () => {
		const events = parseBlockedRulesText("# comment\nreview:blocked = review\napproval:blocked", "events");
		expect(events).toEqual([
			{ name: "review:blocked", label: "review" },
			{ name: "approval:blocked", label: "approval:blocked" },
		]);
		expect(formatBlockedRules(events)).toBe("review:blocked = review\napproval:blocked = approval:blocked");
		expect(parseBlockedRulesText("ask_user_question = question", "tools"))
			.toEqual([{ name: "ask_user_question", label: "question" }]);
		expect(() => parseBlockedRulesText("herdr:blocked = loop", "events")).toThrow(/must not proxy/);
	});
});
