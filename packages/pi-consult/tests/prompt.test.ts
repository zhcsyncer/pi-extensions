import { describe, expect, it } from "vitest";
import { CONSULT_SYSTEM_PROMPT } from "../src/prompt.ts";

describe("consult advisor prompt", () => {
	it("follows the user's language without translating technical syntax", () => {
		expect(CONSULT_SYSTEM_PROMPT).toContain("primary language of the user's most recent substantive request");
		expect(CONSULT_SYSTEM_PROMPT).toContain("Keep JSON keys and verdict values in English");
		expect(CONSULT_SYSTEM_PROMPT).toContain("preserve file paths, identifiers, commands, and quoted code");
	});

	it("permits useful Markdown without wrapping the JSON contract", () => {
		expect(CONSULT_SYSTEM_PROMPT).toContain("may use concise Markdown when it improves clarity");
		expect(CONSULT_SYSTEM_PROMPT).toContain("Encode its newlines, quotes, and backslashes as a valid JSON string");
		expect(CONSULT_SYSTEM_PROMPT).toContain("Do not wrap the JSON object in a Markdown fence");
		expect(CONSULT_SYSTEM_PROMPT).not.toMatch(/no headings|no tables|no fenced code blocks/i);
	});
});
