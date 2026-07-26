import { createMockPi } from "./test-fixtures.js";
import { describe, expect, it } from "vitest";
import type { TodoConfig } from "./config.js";
import {
	createTodoStore,
	DEFAULT_PROMPT_GUIDELINES,
	DEFAULT_PROMPT_SNIPPET,
	registerTodoTool,
	TOOL_NAME,
} from "./todo.js";

const DEFAULT_GUIDELINES_LENGTH = DEFAULT_PROMPT_GUIDELINES.length;

function registerWithConfig(config: TodoConfig) {
	const { pi, captured } = createMockPi();
	registerTodoTool(pi, createTodoStore(), config);
	return captured.tools.get(TOOL_NAME)!;
}

describe("registerTodoTool — guidance overrides", () => {
	it("uses built-in defaults when config is empty", () => {
		const tool = registerWithConfig({});
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		const guidelines = tool.promptGuidelines as string[];
		expect(guidelines).toHaveLength(DEFAULT_GUIDELINES_LENGTH);
		expect(guidelines.join("\n")).toContain("single-step");
		expect(guidelines.join("\n")).toContain("batch");
		expect(guidelines.join("\n")).toContain("Each operation sees prior results");
		expect(guidelines.join("\n")).toContain("create it directly with status in_progress");
		expect(guidelines.join("\n")).toContain("pending task may move directly to completed");
		expect(guidelines.join("\n")).toContain("independently valuable milestones");
	});

	it("uses built-in defaults when config has no guidance field", () => {
		const tool = registerWithConfig({});
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
	});

	it("overrides promptSnippet with valid value", () => {
		const tool = registerWithConfig({ guidance: { promptSnippet: "Custom todo snippet" } });
		expect(tool.promptSnippet).toBe("Custom todo snippet");
		expect((tool.promptGuidelines as string[]).length).toBe(DEFAULT_GUIDELINES_LENGTH);
	});

	it("overrides promptGuidelines with valid value", () => {
		const tool = registerWithConfig({ guidance: { promptGuidelines: ["Rule one", "Rule two"] } });
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect(tool.promptGuidelines).toEqual(["Rule one", "Rule two"]);
	});

	it("overrides both promptSnippet and promptGuidelines", () => {
		const tool = registerWithConfig({ guidance: { promptSnippet: "Custom", promptGuidelines: ["Rule"] } });
		expect(tool.promptSnippet).toBe("Custom");
		expect(tool.promptGuidelines).toEqual(["Rule"]);
	});

	it("falls back to defaults on empty promptSnippet", () => {
		const tool = registerWithConfig({ guidance: { promptSnippet: "" } });
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
	});

	it("falls back to defaults on wrong types", () => {
		const tool = registerWithConfig({
			guidance: { promptSnippet: 123, promptGuidelines: "not-array" } as never,
		});
		expect(tool.promptSnippet).toBe(DEFAULT_PROMPT_SNIPPET);
		expect((tool.promptGuidelines as string[]).length).toBe(DEFAULT_GUIDELINES_LENGTH);
	});

	it("falls back to defaults on promptGuidelines with empty string item", () => {
		const tool = registerWithConfig({ guidance: { promptGuidelines: ["valid", ""] } });
		expect((tool.promptGuidelines as string[]).length).toBe(DEFAULT_GUIDELINES_LENGTH);
	});
});
