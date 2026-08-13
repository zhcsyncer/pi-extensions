import { strict as assert } from "node:assert";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../config.js";
import { stripControls } from "../format.js";
import { resolveBuiltInGlanceStyles, type GlanceRenderStyleContext } from "../theme-adapter.js";
import type { GlanceConfig } from "../types.js";
import { createWorkingIndicatorController } from "../working-indicator.js";

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

function createHarness(mode: "tui" | "rpc" | "json" | "print" = "tui") {
	let config = defaultConfig();
	let now = 1_000;
	let scheduled = 0;
	let cleared = 0;
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
		estimateMessageTokens: () => 42,
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
	harness.controller.messageUpdate({ assistantMessageEvent: { type: "thinking_delta", partial: { role: "assistant" } } });
	assert.ok(stripControls(harness.context.messages.at(-1) ?? "").includes("thinking with high effort"), "thinking phase should include current effort");
	harness.controller.messageUpdate({ assistantMessageEvent: { type: "text_delta", partial: { role: "assistant" } } });
	assert.ok(stripControls(harness.context.messages.at(-1) ?? "").includes("~42 tokens"), "partial output should use injected Pi estimate with a tilde");
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
