import { describe, expect, it } from "vitest";
import { filterSelectItems, isBackspace, isPrintable } from "../src/picker.ts";

describe("consult picker filter", () => {
	const items = [
		{ value: "anthropic/claude-fable-5", label: "Claude Fable 5  (anthropic)" },
		{ value: "openai-codex/gpt-5.6-sol", label: "GPT-5.6 Sol  (openai-codex)" },
		{ value: "__none__", label: "None" },
	];

	it("filters by label or model key", () => {
		expect(filterSelectItems(items, "fable").map((item) => item.value)).toEqual(["anthropic/claude-fable-5"]);
		expect(filterSelectItems(items, "openai").map((item) => item.value)).toEqual(["openai-codex/gpt-5.6-sol"]);
		expect(filterSelectItems(items, "  ").map((item) => item.value)).toEqual(items.map((item) => item.value));
	});

	it("treats backspace and printable keys", () => {
		expect(isBackspace("\u007f")).toBe(true);
		expect(isPrintable("f")).toBe(true);
		expect(isPrintable("\n")).toBe(false);
	});
});
