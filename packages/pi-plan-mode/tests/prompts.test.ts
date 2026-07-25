import { describe, expect, it } from "vitest";
import { appendPlanningPrompt, buildPlanningPrompt } from "../src/prompts.ts";

describe("Plan Mode prompts", () => {
	it("requires English content and section headings for en", () => {
		const prompt = buildPlanningPrompt("en");
		expect(prompt).toContain("Configured content language: en");
		expect(prompt).toContain("title, section headings, prose, and list items in English");
		expect(prompt).toContain("## Goal");
		expect(prompt).toContain("## Execution steps");
		expect(prompt).not.toContain("## 执行步骤");
	});

	it("requires Simplified Chinese content and section headings for zh-CN", () => {
		const prompt = buildPlanningPrompt("zh-CN");
		expect(prompt).toContain("Configured content language: zh-CN");
		expect(prompt).toContain("title, section headings, prose, and list items in Simplified Chinese");
		expect(prompt).toContain("## 目标");
		expect(prompt).toContain("## 执行步骤");
		expect(prompt).not.toContain("## Execution steps");
	});

	it("documents language following and both heading sets for auto", () => {
		const prompt = buildPlanningPrompt("auto");
		expect(prompt).toContain("Configured content language: auto");
		expect(prompt).toContain("match the current user's language");
		expect(prompt).toContain("## Execution steps");
		expect(prompt).toContain("## 执行步骤");
	});

	it("keeps the current Plan reference when applying a configured language", () => {
		const prompt = appendPlanningPrompt("BASE", {
			planId: "plan-1",
			title: "现有计划",
			revision: 2,
			status: "draft",
			planPath: "/plans/plan-1/revisions/r2.md",
		}, "zh-CN");
		expect(prompt).toContain("BASE");
		expect(prompt).toContain("Configured content language: zh-CN");
		expect(prompt).toContain("Plan ID: plan-1");
		expect(prompt).toContain("Revision: r2");
	});
});
