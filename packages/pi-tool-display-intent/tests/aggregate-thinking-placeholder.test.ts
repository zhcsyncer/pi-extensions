import assert from "node:assert/strict";
import test from "node:test";
import {
	AssistantMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import {
	AggregateProjection,
	DEFAULT_AGGREGATE_RENDER_PASSTHROUGH,
	patchAggregateToolExecutions,
	restoreAggregateToolExecutions,
} from "../src/aggregate-activity.ts";
import {
	isInterimAssistantNarration,
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

function createComponent(message: unknown, hideThinkingBlock: boolean): AssistantMessageComponent {
	return new AssistantMessageComponent(
		message as never,
		hideThinkingBlock,
		undefined,
		"Thinking...",
		0,
		[],
	);
}

function render(message: unknown, hideThinkingBlock: boolean): string[] {
	return createComponent(message, hideThinkingBlock).render(100);
}

test("aggregate strips collapsed Thinking placeholders but keeps final assistant text", () => {
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

		const withTextLines = render(assistant([
			{ type: "thinking", thinking: "reasoning" },
			{ type: "text", text: "Visible answer" },
		], { stopReason: "stop" }), true);
		const withText = withTextLines.join("\n");
		assert.doesNotMatch(withText, /Thinking\.\.\./);
		assert.match(withText, /Visible answer/);
		assert.notEqual(withTextLines[0], "");

		const revealed = render(assistant([
			{ type: "thinking", thinking: "reasoning" },
		], { stopReason: "stop" }), false).join("\n");
		assert.match(revealed, /reasoning/);

		const error = render(assistant([
			{ type: "thinking", thinking: "reasoning" },
		], { stopReason: "error", errorMessage: "provider failed" }), true).join("\n");
		assert.doesNotMatch(error, /Thinking\.\.\./);
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

test("aggregate hides interim narration until Ctrl+O restores it in place", () => {
	initTheme("dark", false);
	const projection = new AggregateProjection((toolName) =>
		(DEFAULT_AGGREGATE_RENDER_PASSTHROUGH as readonly string[]).includes(toolName));
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		projection.startUserGroup("user-narration");
		const message = assistant([
			{ type: "thinking", thinking: "reasoning" },
			{ type: "text", text: "先定位两边的设计与实现入口" },
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
		], { id: "assistant-narration" });
		projection.ingestAssistantMessage(message);
		const component = createComponent(message, true);
		assert.equal(isInterimAssistantNarration(component), true);
		assert.deepEqual(component.render(100), []);

		const expandable = component as AssistantMessageComponent & { setExpanded(expanded: boolean): void };
		expandable.setExpanded(true);
		const expanded = component.render(100);
		assert.match(expanded.join("\n"), /│.*›.*先定位两边的设计与实现入口/);
		assert.doesNotMatch(expanded.join("\n"), /│.*Tools/);
		assert.doesNotMatch(expanded.join("\n"), /Thinking\.\.\./);

		expandable.setExpanded(false);
		assert.deepEqual(component.render(100), []);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("final assistant conclusions stay unmarked and do not use a captured Pi theme", () => {
	initTheme("dark", false);
	const projection = new AggregateProjection((toolName) =>
		(DEFAULT_AGGREGATE_RENDER_PASSTHROUGH as readonly string[]).includes(toolName));
	const theme = {
		fgColors: new Map([["muted", "x"]]),
		fg(this: { fgColors?: Map<string, string> }, color: string, text: string) {
			if (!this.fgColors) {
				throw new TypeError("Cannot read properties of undefined (reading 'fgColors')");
			}
			return `${color}:${text}`;
		},
	};
	projection.setRenderTheme(theme);
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		const rendered = render(assistant([
			{ type: "text", text: "Visible answer" },
		], { stopReason: "stop" }), true).join("\n");
		assert.doesNotMatch(rendered, /›|✦/);
		assert.match(rendered, /Visible answer/);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
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
			render(assistant([{ type: "thinking", thinking: "reasoning" }], { stopReason: "stop" }), true).join("\n"),
			/Thinking\.\.\./,
		);
	} finally {
		prototype.render = patched;
		restoreAggregateThinkingPlaceholders();
	}
});

test("a stop message keeps only the final text outside the Tools frame", () => {
	initTheme("dark", false);
	const projection = new AggregateProjection((toolName) =>
		(DEFAULT_AGGREGATE_RENDER_PASSTHROUGH as readonly string[]).includes(toolName));
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		projection.startUserGroup("user-stop-text");
		const message = assistant([
			{ type: "thinking", thinking: "The user asked me to implement S-M15-12. Let me write a clear Chinese summary" },
			{ type: "text", text: "已按你的拍板直接改生产..." },
		], { id: "assistant-stop", stopReason: "stop" });
		projection.ingestAssistantMessage(message);
		const component = createComponent(message, true);
		assert.equal(isInterimAssistantNarration(component), false);
		const collapsed = component.render(100);
		assert.doesNotMatch(collapsed.join("\n"), /The user asked me|S-M15-12|Thinking\.\.\./);
		assert.match(collapsed.join("\n"), /已按你的拍板直接改生产/);
		assert.doesNotMatch(collapsed.join("\n"), /›|│|└/);

		const expandable = component as AssistantMessageComponent & { setExpanded(expanded: boolean): void };
		expandable.setExpanded(true);
		const expanded = component.render(100);
		assert.doesNotMatch(expanded.join("\n"), /The user asked me|S-M15-12|Thinking\.\.\./);
		assert.match(expanded.join("\n"), /已按你的拍板直接改生产/);
		assert.doesNotMatch(expanded.join("\n"), /›|│|└/);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("mid-turn thinking is not framed as narration", () => {
	initTheme("dark", false);
	const projection = new AggregateProjection((toolName) =>
		(DEFAULT_AGGREGATE_RENDER_PASSTHROUGH as readonly string[]).includes(toolName));
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		projection.startUserGroup("user-thinking-only");
		const message = assistant([
			{ type: "thinking", thinking: "The user wants me to inspect the current renderer first." },
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
		], { id: "assistant-thinking-only" });
		projection.ingestAssistantMessage(message);
		const frameId = "assistant-before:read-1";
		assert.equal(projection.getFramedItemIds(frameId).includes(frameId), false);

		const component = createComponent(message, true);
		assert.equal(isInterimAssistantNarration(component), true);
		assert.deepEqual(component.render(100), []);

		const expandable = component as AssistantMessageComponent & { setExpanded(expanded: boolean): void };
		expandable.setExpanded(true);
		const expanded = component.render(100);
		assert.deepEqual(expanded, []);
		assert.doesNotMatch(expanded.join("\n"), /›|The user wants me/);
		assert.equal(projection.getFramedItemIds(frameId).includes(frameId), false);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});
