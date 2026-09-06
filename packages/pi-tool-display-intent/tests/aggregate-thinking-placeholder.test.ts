import assert from "node:assert/strict";
import test from "node:test";
import {
	AssistantMessageComponent,
	ToolExecutionComponent,
	UserMessageComponent,
	initTheme,
} from "@earendil-works/pi-coding-agent";
import { Text, visibleWidth } from "@earendil-works/pi-tui";
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

function passthroughProjection(...names: string[]) {
	const passthrough = new Set(names);
	return new AggregateProjection((toolName) => passthrough.has(toolName));
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

test("passthrough-only turns keep pre-tool narration as ordinary assistant text", () => {
	initTheme("dark", false);
	const projection = passthroughProjection("Agent", "consult");
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		projection.startUserGroup("user-passthrough-narration");
		const message = assistant([
			{ type: "text", text: "Prod has no Metrics on purpose during rollout" },
			{ type: "toolCall", id: "consult-1", name: "consult", arguments: { why: "plan" } },
		], { id: "assistant-consult" });
		projection.ingestAssistantMessage(message);
		const component = createComponent(message, true);
		assert.equal(isInterimAssistantNarration(component), false);
		const rendered = component.render(100);
		assert.equal(rendered[0], "");
		assert.match(rendered.join("\n"), /Prod has no Metrics on purpose/);
		assert.doesNotMatch(rendered.join("\n"), /[›│└]/);

		const expandable = component as AssistantMessageComponent & { setExpanded(expanded: boolean): void };
		expandable.setExpanded(true);
		const expanded = component.render(100);
		assert.equal(expanded[0], "");
		assert.match(expanded.join("\n"), /Prod has no Metrics on purpose/);
		assert.doesNotMatch(expanded.join("\n"), /[›│└]/);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("passthrough-only narration stays visible even after the same user turn already painted a Run ledger", () => {
	initTheme("dark", false);
	const projection = passthroughProjection("Agent", "consult");
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		projection.startUserGroup("user-later-consult-narration");
		projection.ingestAssistantMessage(assistant([
			{ type: "text", text: "Locate both design and implementation entries first" },
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
		], { id: "assistant-read" }));
		const message = assistant([
			{ type: "text", text: "I'll ask the advisor whether session files close the race" },
			{ type: "toolCall", id: "consult-1", name: "consult", arguments: { why: "plan" } },
		], { id: "assistant-consult" });
		projection.ingestAssistantMessage(message);
		const component = createComponent(message, true);
		assert.equal(isInterimAssistantNarration(component), false);
		const rendered = component.render(100);
		assert.match(rendered.join("\n"), /I'll ask the advisor whether session files close the race/);
		assert.doesNotMatch(rendered.join("\n"), /[›│└]/);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("a turn with aggregate tools still folds narration into the Run frame", () => {
	initTheme("dark", false);
	const projection = passthroughProjection("Agent", "consult");
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		projection.startUserGroup("user-mixed-narration");
		const message = assistant([
			{ type: "text", text: "Locate both design and implementation entries first" },
			{ type: "toolCall", id: "consult-1", name: "consult", arguments: { why: "plan" } },
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
		], { id: "assistant-mixed" });
		projection.ingestAssistantMessage(message);
		assert.equal(
			projection.getView("read-1")?.latestNarration,
			"Locate both design and implementation entries first",
		);
		const component = createComponent(message, true);
		assert.equal(isInterimAssistantNarration(component), true);
		assert.deepEqual(component.render(100), []);

		const expandable = component as AssistantMessageComponent & { setExpanded(expanded: boolean): void };
		expandable.setExpanded(true);
		const expanded = component.render(100);
		assert.match(expanded.join("\n"), /│.*›.*Locate both design and implementation entries first/);
		assert.doesNotMatch(expanded.join("\n"), /│.*Run/);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
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
		assert.doesNotMatch(expanded.join("\n"), /│.*Run/);
		assert.doesNotMatch(expanded.join("\n"), /Thinking\.\.\./);

		expandable.setExpanded(false);
		assert.deepEqual(component.render(100), []);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("early unframed narration keeps a blank under the user after later Run appear", () => {
	initTheme("dark", false);
	const projection = passthroughProjection("Agent", "consult");
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		projection.startUserGroup("user-early-narration");
		const early = assistant([
			{ type: "text", text: "Prod has no Metrics on purpose" },
			{ type: "toolCall", id: "consult-1", name: "consult", arguments: { why: "plan" } },
		], { id: "assistant-early" });
		projection.ingestAssistantMessage(early);
		projection.ingestAssistantMessage(assistant([
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
		], { id: "assistant-tools" }));
		const rendered = createComponent(early, true).render(100);
		assert.equal(rendered[0], "");
		assert.match(rendered.join("\n"), /Prod has no Metrics on purpose/);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("expanded narration wraps inside its frame without clipping text or marking padded rows as truncated", () => {
	initTheme("dark", false);
	const projection = passthroughProjection("Agent");
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		projection.startUserGroup("narration-width");
		const text = "先检查账本中的模型回复是否完整显示，然后验证换行不会丢掉末尾文字。\nNext line stays next to the previous line, without an artificial gap.";
		const message = assistant([
			{ type: "text", text },
			{ type: "toolCall", id: "narration-width-tool", name: "read", arguments: { path: "a.ts" } },
		], { id: "narration-width-message" });
		projection.ingestAssistantMessage(message);
		for (const outputPad of [0, 1]) {
			const component = new AssistantMessageComponent(message as never, true, undefined, "Thinking...", outputPad, []);
			(component as AssistantMessageComponent & { setExpanded(value: boolean): void }).setExpanded(true);
			for (const width of [36, 80]) {
				const rows = component.render(width);
				assert.ok(rows.every((row) => visibleWidth(row) <= width));
				const body = rows.map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""))
					.filter((row) => /^  [│└] /.test(row))
					.map((row) => row.replace(/^  [│└] (?:› )?/, "").trim());
				assert.ok(body.length > 1);
				assert.doesNotMatch(body.join("\n"), /…/);
				assert.ok(body.every((row) => row.length > 0), "soft wrapping must not insert blank rows");
				assert.equal(body.join("").replace(/\s/g, ""), text.replace(/\s/g, ""));
			}
		}
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("narration keeps its original first-line inset and aligns adjacent continuation lines without right padding", () => {
	initTheme("dark", false);
	const projection = passthroughProjection("Agent");
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		projection.startUserGroup("narration-inset");
		const message = assistant([
			{ type: "text", text: "First line\nSecond line\nThird line" },
			{ type: "toolCall", id: "narration-inset-tool", name: "read", arguments: { path: "a.ts" } },
		], { id: "narration-inset-message" });
		projection.ingestAssistantMessage(message);
		for (const outputPad of [0, 1, 3]) {
			const component = new AssistantMessageComponent(message as never, true, undefined, "Thinking...", outputPad, []);
			(component as AssistantMessageComponent & { setExpanded(value: boolean): void }).setExpanded(true);
			const rows = component.render(80).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""));
			const first = rows.findIndex((row) => row.includes("First line"));
			const second = rows.findIndex((row) => row.includes("Second line"));
			const third = rows.findIndex((row) => row.includes("Third line"));
			assert.equal(rows[first].indexOf("First"), 6 + outputPad, "keep the established first-line inset");
			assert.equal(second, first + 1);
			assert.equal(third, second + 1);
			assert.equal(rows[second].indexOf("Second"), rows[first].indexOf("First"));
			assert.equal(rows[third].indexOf("Third"), rows[first].indexOf("First"));
			for (const row of rows.slice(first, third + 1)) assert.ok(row.endsWith("line"), "do not fill a short row to the terminal edge");
		}
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("framed narration retains paragraph gaps and intentional blank code lines", () => {
	initTheme("dark", false);
	const projection = passthroughProjection("Agent");
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		projection.startUserGroup("narration-code-spacing");
		const message = assistant([
			{ type: "text", text: "Intro\n\n```text\nfirst\n\n\nlast\n```\n\nOutro" },
			{ type: "toolCall", id: "narration-code-tool", name: "read", arguments: { path: "a.ts" } },
		], { id: "narration-code-message" });
		projection.ingestAssistantMessage(message);
		const component = createComponent(message, true);
		(component as AssistantMessageComponent & { setExpanded(value: boolean): void }).setExpanded(true);
		const body = component.render(80).map((row) => row.replace(/\x1b\[[0-9;]*m/g, ""))
			.filter((row) => /^  [│└] /.test(row))
			.map((row) => row.replace(/^  [│└] (?:› | {2})?/, "").trimEnd()).join("\n");
		assert.match(body, /Intro\n\n```text/);
		assert.match(body, /first\n\n\n  last/);
		assert.match(body, /```\n\nOutro$/);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("expanded narration after a previous tool turn keeps a framed blank", () => {
	initTheme("dark", false);
	const projection = passthroughProjection("Agent", "consult");
	patchAggregateToolExecutions(projection);
	patchAggregateThinkingPlaceholders(() => true);
	try {
		projection.startUserGroup("user-framed-gap");
		projection.ingestAssistantMessage(assistant([
			{ type: "toolCall", id: "read-1", name: "read", arguments: { path: "a.ts" } },
		], { id: "assistant-first" }));
		const later = assistant([
			{ type: "text", text: "接着补文档、changeset，然后跑测试。" },
			{ type: "toolCall", id: "read-2", name: "read", arguments: { path: "b.ts" } },
		], { id: "assistant-later" });
		projection.ingestAssistantMessage(later);
		const component = createComponent(later, true);
		const expandable = component as AssistantMessageComponent & { setExpanded(expanded: boolean): void };
		expandable.setExpanded(true);
		const expanded = component.render(100).join("\n");
		assert.match(expanded, /│[^\n]*\n[^\n]*›[^\n]*接着补文档/);
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
			{ type: "text", text: "就是：换地方画 Run，上面照样空一行。" },
		], { id: "assistant-direct-final", stopReason: "stop" });
		projection.ingestAssistantMessage(message);
		const rendered = createComponent(message, true).render(100);
		assert.equal(rendered[0], "");
		assert.match(rendered.join("\n"), /换地方画 Run/);
	} finally {
		restoreAggregateThinkingPlaceholders();
		restoreAggregateToolExecutions();
	}
});

test("a final answer after Run does not stack a second blank on the ledger", () => {
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

test("a stop message keeps only the final text outside the Run frame", () => {
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
		const steerLines = steer.render(100);
		const steerRow = steerLines.join("\n");
		const secondNarration = secondAssistant.render(100).join("\n");
		const editRow = edit.render(100).join("\n");
		assert.match(firstNarration, /│.*›.*先读 README/);
		assert.match(readRow, /│.*Read\(README\.md\)/);
		assert.equal(steerLines.length, 3);
		assert.match(steerLines[0] ?? "", /│/);
		assert.doesNotMatch(steerLines[0] ?? "", /↳|›|✓/);
		assert.match(steerLines[1] ?? "", /│.*↳.*先确定方案/);
		assert.match(steerLines[2] ?? "", /│/);
		assert.doesNotMatch(steerLines[2] ?? "", /↳|›|✓/);
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
