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
		const guidance = guidelines.join("\n");
		expect(guidance).toContain("at least two independently valuable milestones");
		expect(guidance).toContain("Never start a one-task Todo cycle");
		expect(guidance).toContain("regardless of risk, duration, importance");
		expect(guidance).toContain("never split a tightly coupled edit-test loop or invent filler");
		expect(guidance).toContain("Never bootstrap a cycle with a top-level create or a one-item batch");
		expect(guidance).toContain("Use top-level create only to append a newly discovered milestone");
		expect(guidance).toContain("only one unfinished or visible task");
		expect(guidance).not.toContain("single-step, low-risk");
		expect(guidance).toContain("intended execution order");
		expect(guidance).toContain("Each batch operation sees prior results");
		expect(guidance).toContain("atomically re-queue the current task");
		expect(guidance).toContain("resume the original task");
		expect(guidance).toContain("pending task may move directly to completed");
		expect(guidance).toContain("only pending and in_progress");
		expect(guidance).toContain("reports hidden completed tasks");
		expect(guidance).toContain("start the next cycle with the required multi-create batch");
		expect(guidance).toContain("Previous-cycle tasks leave live state");
		expect(guidance).toContain("Current Todo state update");
		expect(guidance).toContain("User-confirmed reset");
		expect(guidance).not.toContain("clear");
		expect(guidance).not.toContain("blockedBy");
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
