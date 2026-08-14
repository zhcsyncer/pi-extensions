import assert from "node:assert/strict";
import test from "node:test";
import {
	AssistantMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import {
	patchAggregateThinkingPlaceholders,
	restoreAggregateThinkingPlaceholders,
} from "../src/aggregate-thinking-placeholder.ts";

function assistant(content: unknown[], overrides: Record<string, unknown> = {}) {
	return {
		role: "assistant",
		content,
		stopReason: "toolUse",
		...overrides,
	};
}

function render(message: unknown, hideThinkingBlock: boolean): string[] {
	const component = new AssistantMessageComponent(
		message as never,
		hideThinkingBlock,
		undefined,
		"Thinking...",
		0,
		[],
	);
	return component.render(100);
}

test("aggregate hides only pure collapsed Thinking placeholders", () => {
	initTheme("dark", false);
	let aggregate = true;
	patchAggregateThinkingPlaceholders(() => aggregate);
	try {
		assert.deepEqual(
			render(assistant([
				{ type: "thinking", thinking: "reasoning" },
				{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
			]), true),
			[],
		);

		const withText = render(assistant([
			{ type: "thinking", thinking: "reasoning" },
			{ type: "text", text: "Visible answer" },
		]), true).join("\n");
		assert.match(withText, /Thinking\.\.\./);
		assert.match(withText, /Visible answer/);

		const revealed = render(assistant([
			{ type: "thinking", thinking: "reasoning" },
		]), false).join("\n");
		assert.match(revealed, /reasoning/);

		const error = render(assistant([
			{ type: "thinking", thinking: "reasoning" },
		], { stopReason: "error", errorMessage: "provider failed" }), true).join("\n");
		assert.match(error, /provider failed/);

		aggregate = false;
		assert.match(
			render(assistant([{ type: "thinking", thinking: "reasoning" }]), true).join("\n"),
			/Thinking\.\.\./,
		);
	} finally {
		restoreAggregateThinkingPlaceholders();
	}

	assert.match(
		render(assistant([{ type: "thinking", thinking: "reasoning" }]), true).join("\n"),
		/Thinking\.\.\./,
	);
});

test("aggregate thinking patch preserves a later outer renderer wrapper", () => {
	initTheme("dark", false);
	patchAggregateThinkingPlaceholders(() => true);
	const prototype = AssistantMessageComponent.prototype as unknown as {
		render(width: number): string[];
	};
	const patched = prototype.render;
	const outer = function outerRender(this: unknown, width: number): string[] {
		return patched.call(this, width);
	};
	prototype.render = outer;
	try {
		patchAggregateThinkingPlaceholders(() => true);
		assert.equal(prototype.render, outer);
		restoreAggregateThinkingPlaceholders();
		assert.match(
			render(assistant([{ type: "thinking", thinking: "reasoning" }]), true).join("\n"),
			/Thinking\.\.\./,
		);
	} finally {
		prototype.render = patched;
		restoreAggregateThinkingPlaceholders();
	}
});
