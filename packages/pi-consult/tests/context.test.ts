import { describe, expect, it } from "vitest";
import type { Message } from "@earendil-works/pi-ai";
import { appendWhyToLastUser, prepareConsultMessages, stripInflightConsultCall } from "../src/context.ts";
import { CONSULT_TOOL_NAME, MSG_CONSULT_NUDGE } from "../src/messages.ts";

function assistantWithConsult(): Message {
	return {
		role: "assistant",
		content: [
			{ type: "text", text: "I will ask." },
			{ type: "toolCall", id: "1", name: CONSULT_TOOL_NAME, arguments: { why: "x" } },
		],
		timestamp: 1,
	} as unknown as Message;
}

describe("consult context tail", () => {
	it("strips the current in-flight consult tool call", () => {
		const stripped = stripInflightConsultCall(
			[
				{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
				assistantWithConsult(),
			],
			"1",
		);
		const last = stripped[stripped.length - 1];
		expect(last.role).toBe("assistant");
		if (last.role === "assistant") {
			expect(last.content.some((part) => part.type === "toolCall")).toBe(false);
			expect(last.content).toContainEqual({ type: "text", text: "I will ask." });
		}
	});

	it("drops a consult-only assistant tail", () => {
		const stripped = stripInflightConsultCall(
			[
				{ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 0 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "1", name: CONSULT_TOOL_NAME, arguments: { why: "x" } }],
					timestamp: 1,
				} as unknown as Message,
			],
			"1",
		);
		expect(stripped).toHaveLength(1);
		expect(stripped[0].role).toBe("user");
	});

	it("ensures a user tail that includes why", () => {
		const messages = prepareConsultMessages([assistantWithConsult()], "two approaches will lock the layout", "1");
		expect(messages[messages.length - 1]?.role).toBe("user");
		const last = messages[messages.length - 1];
		if (last?.role === "user" && Array.isArray(last.content)) {
			const text = last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			expect(text).toContain(MSG_CONSULT_NUDGE);
			expect(text).toContain("two approaches will lock the layout");
		}
	});

	it("does not duplicate the nudge when the tail is already a user message", () => {
		const messages = appendWhyToLastUser(
			[{ role: "user", content: [{ type: "text", text: MSG_CONSULT_NUDGE }], timestamp: 0 }],
			"why now",
		);
		const last = messages[0];
		if (last.role === "user" && Array.isArray(last.content)) {
			const text = last.content.map((part) => (part.type === "text" ? part.text : "")).join("");
			expect(text.split(MSG_CONSULT_NUDGE).length - 1).toBe(1);
			expect(text).toContain("why now");
		}
	});

	it("preserves user images while appending the consult reason", () => {
		const image = { type: "image" as const, data: "aGVsbG8=", mimeType: "image/png" };
		const messages = prepareConsultMessages(
			[
				{ role: "user", content: [{ type: "text", text: "Review this screenshot" }, image], timestamp: 0 },
				{
					role: "assistant",
					content: [{ type: "toolCall", id: "1", name: CONSULT_TOOL_NAME, arguments: { why: "x" } }],
					timestamp: 1,
				} as unknown as Message,
			],
			"the screenshot changes the choice",
			"1",
		);
		const last = messages.at(-1);
		expect(last?.role).toBe("user");
		if (last?.role === "user" && Array.isArray(last.content)) {
			expect(last.content).toContainEqual(image);
			const text = last.content.map((part) => (part.type === "text" ? part.text : "")).join("\n");
			expect(text).toContain("Review this screenshot");
			expect(text).toContain("the screenshot changes the choice");
		}
	});
});
