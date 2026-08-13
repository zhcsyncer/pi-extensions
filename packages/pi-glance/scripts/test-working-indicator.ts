import { strict as assert } from "node:assert";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../config.js";
import { stripControls } from "../format.js";
import { resolveBuiltInGlanceStyles, type GlanceRenderStyleContext } from "../theme-adapter.js";
import type { GlanceConfig } from "../types.js";
import { createWorkingIndicatorController, type WorkingMessageUpdateEvent } from "../working-indicator.js";

interface IndicatorCall {
	frames?: string[];
	intervalMs?: number;
}

function cloneConfig(config: GlanceConfig): GlanceConfig {
	return JSON.parse(JSON.stringify(config)) as GlanceConfig;
}

function makeContext(mode: "tui" | "rpc" | "json" | "print" = "tui") {
	const messages: Array<string | undefined> = [];
	const indicators: Array<IndicatorCall | undefined> = [];
	const ctx = {
		mode,
		hasUI: mode === "tui" || mode === "rpc",
		ui: {
			setWorkingMessage: (message?: string) => messages.push(message),
			setWorkingIndicator: (options?: IndicatorCall) => indicators.push(options),
		},
	} as unknown as ExtensionContext;
	return { ctx, messages, indicators };
}

type PartialAssistantMessage = Extract<WorkingMessageUpdateEvent["message"], { role: "assistant" }>;

function partialMessage(text: string): PartialAssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "test-model",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "pending",
		timestamp: 1_000,
	};
}

function messageUpdate(type: "thinking_delta" | "text_start" | "text_delta", message: PartialAssistantMessage): WorkingMessageUpdateEvent {
	if (type === "text_start") {
		return { type: "message_update", message, assistantMessageEvent: { type, contentIndex: 0, partial: message } };
	}
	if (type === "thinking_delta") {
		return { type: "message_update", message, assistantMessageEvent: { type, contentIndex: 0, delta: message.content[0]?.type === "text" ? message.content[0].text : "", partial: message } };
	}
	return { type: "message_update", message, assistantMessageEvent: { type, contentIndex: 0, delta: message.content[0]?.type === "text" ? message.content[0].text : "", partial: message } };
}

function createHarness(
	mode: "tui" | "rpc" | "json" | "print" = "tui",
	estimateMessageTokens: (message: unknown) => number = () => 42,
) {
	let config = defaultConfig();
	let now = 1_000;
	let scheduled = 0;
	let cleared = 0;
	let estimateCalls = 0;
	let callback: (() => void) | undefined;
	const context = makeContext(mode);
	const controller = createWorkingIndicatorController({
		getConfig: () => config,
		getThinkingLevel: () => "high",
		getTerminalWidth: () => 80,
		nowMs: () => now,
		random: () => 0,
		setInterval: (next) => {
			scheduled++;
			callback = next;
			return scheduled;
		},
		clearInterval: () => {
			cleared++;
			callback = undefined;
		},
		estimateMessageTokens: (message) => {
			estimateCalls++;
			return estimateMessageTokens(message);
		},
	});
	return {
		controller,
		context,
		setConfig(next: GlanceConfig) {
			config = next;
		},
		setNow(next: number) {
			now = next;
		},
		tick() {
			callback?.();
		},
		get scheduled() {
			return scheduled;
		},
		get cleared() {
			return cleared;
		},
		get estimateCalls() {
			return estimateCalls;
		},
	};
}

{
	const harness = createHarness();
	harness.controller.apply(harness.context.ctx, { styles: resolveBuiltInGlanceStyles("dark") });
	harness.controller.agentStart(harness.context.ctx);
	assert.equal(harness.scheduled, 1, "enabled agent_start should create one animation timer");
	assert.equal(harness.context.indicators.length, 1, "enabled agent_start should install the themed spinner");
	assert.equal(harness.context.indicators[0]?.intervalMs, 120, "spinner should use the specified interval");
	assert.ok((harness.context.indicators[0]?.frames ?? []).every((frame) => frame.includes("\u001b[")), "built-in Glance styles should color every spinner frame");
	assert.ok(stripControls(harness.context.messages.at(-1) ?? "").includes("Brewing"), "enabled agent_start should take over the working message");

	harness.controller.agentStart(harness.context.ctx);
	assert.equal(harness.scheduled, 1, "retry agent_start should reuse the single timer");
	harness.controller.turnStart();
	const beforeUpdates = harness.context.messages.length;
	harness.controller.messageUpdate(messageUpdate("thinking_delta", partialMessage("thinking")));
	harness.controller.messageUpdate(messageUpdate("text_delta", partialMessage("answer")));
	assert.equal(harness.estimateCalls, 0, "streaming bursts should not synchronously rescan complete partial messages");
	assert.equal(harness.context.messages.length, beforeUpdates, "streaming bursts should wait for the existing ticker instead of rendering per delta");
	harness.tick();
	assert.equal(harness.estimateCalls, 1, "one ticker frame should coalesce a streaming burst into one estimate");
	assert.ok(stripControls(harness.context.messages.at(-1) ?? "").includes("~42 tokens"), "the ticker should estimate the latest real Pi message_update snapshot");
	harness.controller.messageEnd({ message: { role: "assistant", responseId: "one", usage: { output: 40 } } });
	assert.ok(stripControls(harness.context.messages.at(-1) ?? "").includes("40 tokens"), "final provider output should calibrate the working value");
	assert.equal(stripControls(harness.context.messages.at(-1) ?? "").includes("~40"), false, "calibrated final output should drop the tilde");

	harness.controller.toolExecutionStart({ toolCallId: "a", toolName: "bash" });
	harness.controller.toolExecutionStart({ toolCallId: "b", toolName: "read" });
	assert.ok(stripControls(harness.context.messages.at(-1) ?? "").includes("running 2 tools"), "parallel tools should render by toolCallId count");
	harness.controller.toolExecutionEnd({ toolCallId: "a" });
	assert.ok(stripControls(harness.context.messages.at(-1) ?? "").includes("running read"), "ending one parallel tool should preserve the remaining tool name");

	harness.controller.agentSettled();
	assert.equal(harness.cleared, 1, "agent_settled should stop the timer");
	assert.deepEqual(harness.context.messages.slice(-1), [undefined], "agent_settled should restore Pi's default working message with no argument");
	assert.deepEqual(harness.context.indicators.slice(-1), [undefined], "agent_settled should restore Pi's default spinner with no argument");
	harness.controller.agentSettled();
	assert.equal(harness.cleared, 1, "repeated settled cleanup should be idempotent");
	assert.deepEqual(harness.context.messages.slice(-1), [undefined], "repeated cleanup should not write over a later working-row owner");
}

{
	const estimatedTexts: string[] = [];
	const harness = createHarness("tui", (message) => {
		const block = (message as PartialAssistantMessage).content[0];
		const text = block?.type === "text" ? block.text : "";
		estimatedTexts.push(text);
		return text.length;
	});
	harness.controller.apply(harness.context.ctx, { styles: resolveBuiltInGlanceStyles("dark") });
	harness.controller.agentStart(harness.context.ctx);
	harness.controller.messageUpdate(messageUpdate("text_start", partialMessage("")));
	harness.tick();
	assert.equal(stripControls(harness.context.messages.at(-1) ?? "").includes("token"), false, "an empty stream start should not display ~0 tokens");
	harness.controller.messageUpdate(messageUpdate("text_delta", partialMessage("old")));
	harness.controller.messageUpdate(messageUpdate("text_delta", partialMessage("latest")));
	harness.tick();
	assert.deepEqual(estimatedTexts, ["", "latest"], "each ticker frame should estimate only the latest partial snapshot in a burst");
	assert.ok(stripControls(harness.context.messages.at(-1) ?? "").includes("~6 tokens"), "the coalesced estimate should reflect the latest complete partial");
}

{
	const harness = createHarness();
	let style = resolveBuiltInGlanceStyles("dark");
	const dynamicStyles: GlanceRenderStyleContext = { getPiStyles: () => style };
	const config = cloneConfig(defaultConfig());
	config.colorSource = "pi";
	harness.setConfig(config);
	harness.controller.apply(harness.context.ctx, dynamicStyles);
	harness.controller.agentStart(harness.context.ctx);
	assert.equal(harness.context.indicators.length, 1, "first render should install frames");
	harness.tick();
	assert.equal(harness.context.indicators.length, 1, "same style cache key should not reinstall frames");
	style = resolveBuiltInGlanceStyles("light");
	harness.tick();
	assert.equal(harness.context.indicators.length, 2, "runtime style cache-key changes should reinstall colored frames");

	const off = cloneConfig(config);
	off.workingIndicator.enabled = false;
	harness.setConfig(off);
	harness.controller.apply(harness.context.ctx, dynamicStyles);
	assert.equal(harness.cleared, 1, "working on->off config save should stop the timer immediately");
	assert.equal(harness.context.messages.at(-1), undefined, "working on->off should restore Pi's message");

	const on = cloneConfig(off);
	on.workingIndicator.enabled = true;
	harness.setConfig(on);
	harness.controller.apply(harness.context.ctx, dynamicStyles);
	assert.equal(harness.scheduled, 1, "off->on should not reconstruct or restart a discarded active cycle");
	harness.controller.agentStart(harness.context.ctx);
	assert.equal(harness.scheduled, 2, "next agent_start after re-enable should start a fresh timer");
	const disabled = cloneConfig(on);
	disabled.enabled = false;
	harness.setConfig(disabled);
	harness.controller.apply(harness.context.ctx, dynamicStyles);
	assert.equal(harness.cleared, 2, "top-level disable should clean up working UI and timer");
}

{
	const harness = createHarness();
	harness.controller.apply(harness.context.ctx, { styles: resolveBuiltInGlanceStyles("dark") });
	harness.controller.agentStart(harness.context.ctx);
	harness.controller.shutdown();
	assert.equal(harness.cleared, 1, "shutdown/reload cleanup should stop the timer");
	assert.equal(harness.context.messages.at(-1), undefined, "shutdown/reload cleanup should restore Pi defaults");
}

for (const mode of ["rpc", "json", "print"] as const) {
	const harness = createHarness(mode);
	harness.controller.apply(harness.context.ctx, { styles: resolveBuiltInGlanceStyles("dark") });
	harness.controller.agentStart(harness.context.ctx);
	assert.equal(harness.scheduled, 0, `${mode} should never start a working timer`);
	assert.deepEqual(harness.context.messages, [], `${mode} should never call TUI working-message APIs`);
	assert.deepEqual(harness.context.indicators, [], `${mode} should never call TUI indicator APIs`);
}

console.log("✓ working indicator controller checks passed");
