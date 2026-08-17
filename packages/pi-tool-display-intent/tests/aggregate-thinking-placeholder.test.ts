import assert from "node:assert/strict";
import test from "node:test";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import {
	AggregateProjection,
	DEFAULT_AGGREGATE_RENDER_PASSTHROUGH,
	patchAggregateToolExecutions,
	restoreAggregateToolExecutions,
} from "../src/aggregate-activity.ts";
import {
	patchNativeUserMessagePrototype,
	type PatchableUserMessagePrototype,
} from "../src/user-message-box-renderer.ts";
import { resolveAggregateSteerUserPresentation } from "../src/user-message-box-native.ts";
import { unregisterUserMessageRenderPrototypePatch } from "../src/user-message-box-patch.ts";
import {
	isInterimAssistantNarration,
	omitThinkingContentBlocks,
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
		assert.equal(withTextLines[0], "");

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

test("a direct final answer keeps a blank row under the user prompt", () => {
	initTheme("dark", false);
	const projection = new AggregateProjection((toolName) =>
		(DEFAULT_AGGREGATE_RENDER_PASSTHROUGH as readonly string[]).includes(toolName));
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		projection.startUserGroup("user-direct-final");
		const message = assistant([
			{ type: "text", text: "就是：换地方画 Tools，上面照样空一行。" },
		], { id: "assistant-direct-final", stopReason: "stop" });
		projection.ingestAssistantMessage(message);
		const rendered = createComponent(message, true).render(100);
		assert.equal(rendered[0], "");
		assert.match(rendered.join("\n"), /换地方画 Tools/);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("a final answer after Tools does not stack a second blank on the ledger", () => {
	initTheme("dark", false);
	const projection = new AggregateProjection((toolName) =>
		(DEFAULT_AGGREGATE_RENDER_PASSTHROUGH as readonly string[]).includes(toolName));
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		projection.startUserGroup("user-after-tools");
		projection.ingestAssistantMessage(assistant([
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
		], { id: "assistant-tools" }));
		projection.markStarted("read-1", "read", { path: "a.ts" });
		const message = assistant([
			{ type: "text", text: "对照完了。" },
		], { id: "assistant-after-tools", stopReason: "stop" });
		projection.ingestAssistantMessage(message);
		const rendered = createComponent(message, true).render(100);
		assert.notEqual(rendered[0], "");
		assert.match(rendered.join("\n"), /对照完了/);
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

test("expanded timeline keeps a steer between tools and later narration", () => {
	initTheme("dark", false);
	const projection = new AggregateProjection((toolName) =>
		(DEFAULT_AGGREGATE_RENDER_PASSTHROUGH as readonly string[]).includes(toolName));
	const userPrototype = UserMessageComponent.prototype as unknown as PatchableUserMessagePrototype;
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	patchNativeUserMessagePrototype(
		userPrototype,
		() => undefined,
		() => true,
		() => true,
		resolveAggregateSteerUserPresentation,
	);
	try {
		projection.startUserGroup("user-timeline");
		const first = assistant([
			{ type: "text", text: "先读 README" },
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "README.md" } },
		], { id: "assistant-first" });
		projection.ingestAssistantMessage(first);
		projection.markStarted("read-1", "read", { path: "README.md" });
		projection.markComplete("read-1", { content: [{ type: "text", text: "ok" }] }, false);
		projection.ingestUserMessage({
			role: "user",
			content: "先确定方案",
			timestamp: 2,
		});
		const second = assistant([
			{ type: "text", text: "按新约束改" },
			{ type: "toolCall", id: "edit-1", name: "edit", arguments: { path: "README.md" } },
		], { id: "assistant-second" });
		projection.ingestAssistantMessage(second);
		projection.markStarted("edit-1", "edit", { path: "README.md" });

		const tool = (name: string, id: string, args: Record<string, unknown>) =>
			new ToolExecutionComponent(
				name,
				id,
				args,
				{},
				{
					name,
					label: name,
					description: name,
					parameters: { type: "object", properties: {} },
					execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
					renderCall: () => new Text(name, 0, 0),
					renderResult: () => new Text(name, 0, 0),
				} as never,
				{ requestRender() {} } as never,
				process.cwd(),
			);
		const read = tool("read", "read-1", { path: "README.md" });
		const edit = tool("edit", "edit-1", { path: "README.md" });
		const steer = new UserMessageComponent("先确定方案");
		const firstAssistant = createComponent(first, true);
		const secondAssistant = createComponent(second, true);

		assert.deepEqual(steer.render(100), []);
		assert.doesNotMatch(steer.render(100).join("\n"), /▎|↳/);

		for (const component of [firstAssistant, secondAssistant, read, edit, steer] as Array<{ setExpanded(expanded: boolean): void }>) {
			component.setExpanded(true);
		}

		const firstNarration = firstAssistant.render(100).join("\n");
		const readRow = read.render(100).join("\n");
		const steerRow = steer.render(100).join("\n");
		const secondNarration = secondAssistant.render(100).join("\n");
		const editRow = edit.render(100).join("\n");
		assert.match(firstNarration, /│.*›.*先读 README/);
		assert.match(readRow, /│.*Read\(README\.md\)/);
		assert.match(steerRow, /│.*↳.*先确定方案/);
		assert.doesNotMatch(steerRow, /▎/);
		assert.match(secondNarration, /│.*›.*按新约束改/);
		assert.match(editRow, /└.*Edit\(README\.md\)/);
	} finally {
		unregisterUserMessageRenderPrototypePatch(userPrototype);
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("overlapping thinking and final text keep the final text", () => {
	initTheme("dark", false);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		const phrase = "modify the aggregate projection to use WeakMap";
		const message = assistant([
			{ type: "thinking", thinking: `I should ${phrase} and then present this clearly.` },
			{ type: "text", text: phrase },
		], { id: "assistant-overlap", stopReason: "stop" });
		const stripped = omitThinkingContentBlocks(message) as { content: Array<{ type: string }> };
		assert.deepEqual(stripped.content.map((block) => block.type), ["text"]);
		const rendered = createComponent(message, false).render(100).join("\n");
		assert.match(rendered, /modify the aggregate projection to use WeakMap/);
		assert.doesNotMatch(rendered, /present this clearly|Thinking\.\.\./);
	} finally {
		restoreAggregateThinkingPlaceholders();
	}
});
