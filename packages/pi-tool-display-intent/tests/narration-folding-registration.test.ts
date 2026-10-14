import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { getActiveAggregateProjection } from "../src/aggregate-activity.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { disposeAll, resetDisposed } from "../src/disposable.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";

test("narration visibility uses registered config until reload, then rebuilds history", async () => {
	const message = {
		role: "assistant", id: "answer", stopReason: "toolUse",
		content: [
			{ type: "text", text: "The answer is 42." },
			{ type: "toolCall", id: "answer-tool", name: "bash", arguments: { command: "true" } },
		],
	};
	const branch = [{ type: "message", id: "entry-answer", message }];
	const ctx = {
		hasUI: true, mode: "tui", ui: { theme: { fg: (_color: string, text: string) => text } },
		sessionManager: { getBranch: () => branch, buildSessionContext: () => ({ messages: [message] }) },
	};
	let config = { ...DEFAULT_TOOL_DISPLAY_CONFIG, toolCallLayout: "aggregate" as const };
	const register = () => {
		const handlers = new Map<string, Array<(event: object, context: typeof ctx) => unknown>>();
		const api = {
			registerTool() {},
			getAllTools: () => [],
			on(event: string, handler: (event: object, context: typeof ctx) => unknown) {
				handlers.set(event, [...(handlers.get(event) ?? []), handler]);
			},
			// SAFETY: registration only consumes these three API methods in this fixture.
		} as unknown as ExtensionAPI;
		registerToolDisplayOverrides(api, () => config);
		return async (event: string) => {
			for (const handler of handlers.get(event) ?? []) await handler({}, ctx);
		};
	};
	resetDisposed();
	try {
		const emit = register();
		await emit("session_start");
		const folded = getActiveAggregateProjection();
		assert.ok(folded);
		assert.equal(folded.shouldFrameAssistantNarration(message), true);
		config = { ...config, foldAssistantNarration: false };
		await emit("before_agent_start");
		assert.equal(folded.shouldFrameAssistantNarration(message), true, "no partial live toggle");
		await emit("session_shutdown");
		disposeAll();
		resetDisposed();

		const reloaded = register();
		await reloaded("session_start");
		const visible = getActiveAggregateProjection();
		assert.ok(visible);
		assert.notEqual(visible, folded);
		assert.equal(visible.shouldFrameAssistantNarration(message), false);
		assert.equal(visible.getGroups()[0]?.members.length, 1);
		assert.equal(visible.getView("answer-tool")?.latestNarration, undefined);
		await reloaded("session_shutdown");
	} finally {
		disposeAll();
	}
});
