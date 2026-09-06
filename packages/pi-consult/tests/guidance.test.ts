import { describe, expect, it } from "vitest";
import { DEFAULT_PROMPT_GUIDELINES, DEFAULT_PROMPT_SNIPPET } from "../src/guidance.ts";

describe("main-model Consult guidance", () => {
	const guidance = DEFAULT_PROMPT_GUIDELINES.join("\n");

	it("limits proactive Consult to explicit, consequential unresolved, or stuck cases", () => {
		expect(DEFAULT_PROMPT_SNIPPET).toContain("explicit advisor requests");
		expect(DEFAULT_PROMPT_SNIPPET).toContain("consequential unresolved structural choices");
		expect(DEFAULT_PROMPT_SNIPPET).toContain("genuinely stuck approaches");
		expect(guidance).toContain("materially different approaches");
		expect(guidance).toContain("current evidence does not favor one");
	});

	it("excludes named options, decided work, direct assessments, reversible choices, and mechanical next steps", () => {
		for (const phrase of [
			"merely because multiple options can be named",
			"user has already decided",
			"asking for your own assessment",
			"choice is reversible",
			"tool output already dictates the next mechanical step",
		]) {
			expect(guidance).toContain(phrase);
		}
	});

	it("treats advice as a challenge and makes rejection plus confirmation explicit", () => {
		expect(guidance).toContain("challenge, not authority");
		expect(guidance).toContain("rejecting it with evidence is a valid outcome");
		expect(guidance).toContain("CONSULT-LOG: adopt | changed: <reason>");
		expect(guidance).toContain("CONSULT-LOG: adopt | confirmed: <reason>");
		expect(guidance).toContain("CONSULT-LOG: reject | <reason>");
	});
});
