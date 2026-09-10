import { strict as assert } from "node:assert";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../config.js";
import { createGlanceRuntime } from "../runtime.js";
import type { GlanceConfig, TurnThroughput, TurnThroughputUsage } from "../types.js";

interface Notification {
	message: string;
	type: "info" | "warning" | "error" | undefined;
}

interface RuntimeRecord {
	events: Record<string, (event: unknown, ctx: ExtensionCommandContext) => unknown>;
	commands: { openPane(args: string, ctx: ExtensionCommandContext): Promise<void> };
}

interface Slots {
	lastTurn: TurnThroughput | null;
	currentRun: TurnThroughput | null;
}

function assistant(output: number, extras: Record<string, unknown> = {}, stopReason = "stop"): unknown {
	return { role: "assistant", stopReason, usage: { output, totalTokens: output, ...extras } };
}

function turnEnd(turnIndex: unknown, message: unknown): unknown {
	return { type: "turn_end", turnIndex, message, toolResults: [] };
}

function measurement(startedAtMs: number, endedAtMs: number, elapsedMs: number, output: number, extras: Partial<TurnThroughputUsage> = {}): TurnThroughput {
	return {
		startedAtMs, endedAtMs, elapsedMs,
		tokensPerSecond: output / (elapsedMs / 1000),
		usage: { input: 0, output, cacheRead: 0, cacheWrite: 0, totalTokens: output, assistantMessages: 1, ...extras },
	};
}

const allNotifications: Notification[][] = [];

function createHarness() {
	const notifications: Notification[] = [];
	allNotifications.push(notifications);
	let renderRequests = 0;
	let now = 0;
	let captured: { throughput: Slots } | undefined;
	const fakeTui = { terminal: { columns: 100 }, requestRender: () => renderRequests++ };
	const ctx = {
		mode: "tui",
		hasUI: true,
		cwd: "/repo",
		model: { id: "test-model", provider: "test-provider", contextWindow: 200_000 },
		modelRegistry: { getAvailable: () => [{ provider: "test-provider", id: "test-model" }] },
		sessionManager: { getCwd: () => "/repo", getEntries: () => [], getBranch: () => [] },
		ui: {
			notify: (message: string, type?: "info" | "warning" | "error") => notifications.push({ message, type }),
			setWorkingMessage: (_message?: string) => {},
			setWorkingIndicator: (_options?: unknown) => {},
			setWidget: (_key: string, factory: unknown) => {
				if (typeof factory === "function") (factory as (tui: unknown, theme: unknown) => unknown)(fakeTui, {});
			},
			setFooter: (factory: unknown) => {
				if (factory) (factory as (tui: unknown, theme: unknown) => unknown)(fakeTui, {});
			},
			setEditorComponent: (_factory: unknown) => {},
		},
		getContextUsage: () => ({ tokens: 42, contextWindow: 200_000, percent: 0.021 }),
	} as unknown as ExtensionCommandContext;
	const config = defaultConfig();
	const cloneConfig = () => JSON.parse(JSON.stringify(config)) as GlanceConfig;
	const runtime = createGlanceRuntime({
		getThinkingLevel: () => "off",
		getAutoCompactionEnabled: () => true,
		loadConfigSync: cloneConfig,
		loadConfig: async () => cloneConfig(),
		saveConfig: async (_config: GlanceConfig) => {},
		showPane: async (_initial, _ctx, previewState) => {
			captured = JSON.parse(JSON.stringify(previewState)) as { throughput: Slots };
			return { action: "cancel" as const };
		},
		createGitRefresher: () => ({ schedule: (_immediate?: boolean) => {}, dispose: () => {} }),
		nowMs: () => now,
		workingIndicator: {
			nowMs: () => now,
			setInterval: () => ({ kind: "throughput-test-working-timer" }),
			clearInterval: () => undefined,
		},
	}) as unknown as RuntimeRecord;

	function event(at: number, name: string, payload: unknown = {}): unknown {
		now = at;
		assert.equal(typeof runtime.events[name], "function", `runtime should expose ${name}`);
		return runtime.events[name](payload, ctx);
	}

	function update(at: number, type: string): void {
		event(at, "messageUpdate", {
			type: "message_update",
			message: assistant(0),
			assistantMessageEvent: { type, contentIndex: 0, delta: "chunk" },
		});
	}

	async function slots(): Promise<Slots> {
		const baseline = notifications.length;
		await runtime.commands.openPane("", ctx);
		// Remove only the notification caused by inspection; lifecycle notifications stay observable.
		assert.deepEqual(notifications.splice(baseline), [{ message: "pi-glance configuration cancelled", type: "info" }]);
		assert.ok(captured);
		return captured.throughput;
	}

	event(0, "sessionStart");
	return { event, update, slots, setTime: (at: number) => { now = at; }, renders: () => renderRequests };
}

const empty: Slots = { lastTurn: null, currentRun: null };
const trusted = measurement(1_000, 5_000, 2_500, 50);

async function seedFinal(h: ReturnType<typeof createHarness>): Promise<void> {
	h.event(1_000, "agentStart");
	h.update(2_000, "text_delta");
	await h.event(4_500, "messageEnd", { message: assistant(50) });
	await h.event(5_000, "agentEnd", { messages: [assistant(50)] });
	assert.deepEqual(await h.slots(), { lastTurn: trusted, currentRun: null });
}

{
	const h = createHarness();
	const baseline = h.renders();
	h.event(1_000, "agentStart");
	assert.deepEqual(await h.slots(), empty, "starting a run should not publish unmeasured throughput");
	assert.equal(h.renders(), baseline, "start without a provisional result should not request an extra render");
}

// Two one-second responses separated by a 28-second tool, plus waiting before BOTH first deltas.
{
	const h = createHarness();
	const first = assistant(20, { input: 3, cacheRead: 2 }, "toolUse");
	const second = assistant(80, { input: 7, cacheWrite: 5 });
	h.event(0, "agentStart");
	h.update(100, "toolcall_start");
	h.update(1_000, "toolcall_delta");
	await h.event(2_000, "messageEnd", { message: first });
	h.event(2_000, "toolExecutionStart", { toolCallId: "slow", toolName: "bash" });
	await h.event(30_000, "toolExecutionEnd", { toolCallId: "slow", toolName: "bash" });
	await h.event(30_000, "turnEnd", turnEnd(0, first));
	assert.deepEqual(await h.slots(), { lastTurn: null, currentRun: measurement(0, 30_000, 1_000, 20, { input: 3, cacheRead: 2 }) });
	h.update(30_500, "text_start");
	h.update(32_000, "text_delta");
	await h.event(33_000, "messageEnd", { message: second });
	await h.event(34_000, "turnEnd", turnEnd(1, second));
	const usage = { input: 10, cacheRead: 2, cacheWrite: 5, assistantMessages: 2 };
	assert.deepEqual(await h.slots(), { lastTurn: null, currentRun: measurement(0, 34_000, 2_000, 100, usage) }, "checkpoints sum completed assistants over inference time, excluding tools and every first-delta wait");
	await h.event(40_000, "agentEnd", { messages: [first, { role: "toolResult" }, second] });
	assert.deepEqual(await h.slots(), { lastTurn: measurement(0, 40_000, 2_000, 100, usage), currentRun: null });
}

{
	const h = createHarness();
	h.event(0, "agentStart");
	h.update(100, "thinking_start");
	h.update(1_000, "thinking_delta");
	h.update(3_000, "thinking_end");
	h.update(6_000, "text_start");
	h.update(7_000, "text_delta");
	h.update(8_000, "text_end");
	await h.event(9_000, "messageEnd", { message: assistant(80) });
	await h.event(12_000, "agentEnd", { messages: [assistant(80)] });
	assert.deepEqual(await h.slots(), { lastTurn: measurement(0, 12_000, 8_000, 80), currentRun: null }, "thinking and text share a continuous interval across block transitions");
}

{
	const h = createHarness();
	h.event(0, "agentStart");
	h.update(1_000, "toolcall_delta");
	h.event(2_000, "toolExecutionStart", { toolCallId: "a", toolName: "bash" });
	h.event(3_000, "toolExecutionStart", { toolCallId: "a", toolName: "bash" });
	h.event(4_000, "toolExecutionStart", { toolCallId: "b", toolName: "read" });
	await h.event(5_000, "toolExecutionEnd", { toolCallId: "a", toolName: "bash" });
	await h.event(6_000, "toolExecutionEnd", { toolCallId: "a", toolName: "bash" });
	await h.event(6_500, "toolExecutionEnd", { toolCallId: "unknown", toolName: "read" });
	h.update(7_000, "text_delta");
	await h.event(8_000, "toolExecutionEnd", { toolCallId: "b", toolName: "read" });
	h.update(10_000, "text_delta");
	await h.event(11_000, "agentEnd", { messages: [assistant(40)] });
	assert.deepEqual(await h.slots(), { lastTurn: measurement(0, 11_000, 2_000, 40), currentRun: null }, "tool start pauses immediately; duplicate IDs are idempotent, all inflight tools gate deltas, and tool end alone never resumes");
}

{
	const h = createHarness();
	h.event(0, "agentStart");
	h.update(1_000, "text_delta");
	h.event(2_000, "uiPromptStart");
	h.update(5_000, "thinking_delta");
	h.event(10_000, "uiPromptEnd");
	h.update(12_000, "text_delta");
	await h.event(13_000, "agentEnd", { messages: [assistant(40)] });
	assert.deepEqual(await h.slots(), { lastTurn: measurement(0, 13_000, 2_000, 40), currentRun: null }, "UI time and post-prompt wait are excluded, including deltas while prompting");
}

{
	const h = createHarness();
	h.event(0, "agentStart");
	h.update(1_000, "text_delta");
	h.event(2_000, "uiPromptStart");
	h.event(3_000, "toolExecutionStart", { toolCallId: "a", toolName: "bash" });
	h.event(4_000, "uiPromptEnd");
	h.update(5_000, "text_delta");
	h.event(6_000, "uiPromptStart");
	await h.event(7_000, "toolExecutionEnd", { toolCallId: "a", toolName: "bash" });
	h.update(8_000, "thinking_delta");
	h.event(9_000, "uiPromptEnd");
	h.update(10_000, "text_delta");
	await h.event(11_000, "agentEnd", { messages: [assistant(40)] });
	assert.deepEqual(await h.slots(), { lastTurn: measurement(0, 11_000, 2_000, 40), currentRun: null }, "clearing one kind of gate must not clear the other");
}

{
	const h = createHarness();
	h.event(0, "agentStart");
	h.update(1_000, "text_delta");
	const pendingMessageEnd = h.event(2_000, "messageEnd", { message: assistant(20) });
	h.setTime(20_000);
	await pendingMessageEnd;
	await h.event(30_000, "turnEnd", turnEnd(0, assistant(20)));
	assert.deepEqual(await h.slots(), { lastTurn: null, currentRun: measurement(0, 30_000, 1_000, 20) }, "messageEnd closes synchronously, before async refresh and delayed turnEnd");
	await h.event(40_000, "agentEnd", { messages: [assistant(90), { role: "user", usage: { output: 999 } }] });
	assert.deepEqual(await h.slots(), { lastTurn: measurement(0, 40_000, 1_000, 90), currentRun: null }, "agentEnd uses authoritative event.messages, not checkpoints, without counting final waiting");
	h.event(50_000, "agentSettled");
	assert.deepEqual(await h.slots(), { lastTurn: measurement(0, 40_000, 1_000, 90), currentRun: null }, "normal settled cannot overwrite the finalized run");
	await h.event(60_000, "agentEnd", { messages: [assistant(1)] });
	assert.deepEqual(await h.slots(), { lastTurn: measurement(0, 40_000, 1_000, 90), currentRun: null }, "repeated end without a matching start preserves the trusted result");
}

{
	const h = createHarness();
	h.event(0, "agentStart");
	h.update(1_000, "text_delta");
	await h.event(2_000, "turnEnd", turnEnd(7, assistant(20)));
	await h.event(8_000, "turnEnd", turnEnd(7, assistant(999)));
	assert.deepEqual(await h.slots(), { lastTurn: null, currentRun: measurement(0, 2_000, 1_000, 20) }, "checkpoint falls back to closing an interval, and duplicate finite turnIndex cannot recount usage or change the timestamp");
	h.update(10_000, "text_delta");
	await h.event(11_000, "turnEnd", turnEnd(8, assistant(40)));
	h.event(20_000, "agentSettled");
	assert.deepEqual(await h.slots(), { lastTurn: measurement(0, 20_000, 2_000, 60, { assistantMessages: 2 }), currentRun: null }, "settled without agentEnd finalizes checkpoint messages and excludes waiting after the final checkpoint");
	const finalized = await h.slots();
	h.event(30_000, "agentSettled");
	assert.deepEqual(await h.slots(), finalized, "settled finalization is idempotent");
}

{
	const h = createHarness();
	h.event(0, "agentStart");
	h.update(1_000, "text_delta");
	await h.event(2_000, "turnEnd", turnEnd(undefined, assistant(20)));
	h.update(4_000, "text_delta");
	await h.event(5_000, "turnEnd", turnEnd(undefined, assistant(30)));
	assert.deepEqual(await h.slots(), { lastTurn: null, currentRun: measurement(0, 5_000, 2_000, 50, { assistantMessages: 2 }) }, "missing turnIndex must not suppress distinct completed assistants");
}

{
	const h = createHarness();
	h.update(100, "text_delta");
	await h.event(200, "turnEnd", turnEnd(0, assistant(40)));
	await h.event(300, "agentEnd", { messages: [assistant(40)] });
	h.event(400, "agentSettled");
	assert.deepEqual(await h.slots(), empty, "events without agentStart cannot produce a measurement");
	h.event(1_000, "agentStart");
	h.update(2_000, "text_delta");
	await h.event(3_000, "messageEnd", { message: { role: "toolResult" } });
	await h.event(4_000, "turnEnd", turnEnd(0, { role: "user", usage: { output: 99 } }));
	assert.deepEqual(await h.slots(), empty);
	await h.event(5_000, "turnEnd", turnEnd(0, assistant(30)));
	assert.deepEqual(await h.slots(), { lastTurn: null, currentRun: measurement(1_000, 5_000, 3_000, 30) }, "non-assistant completion neither closes inference nor consumes the checkpoint index");
}

{
	const h = createHarness();
	h.event(0, "agentStart");
	h.update(1_000, "thinking_delta");
	await h.event(2_000, "turnEnd", turnEnd(0, assistant(0)));
	assert.deepEqual(await h.slots(), empty, "inference without output remains unknown");
	h.update(4_000, "text_delta");
	await h.event(5_000, "turnEnd", turnEnd(1, assistant(20)));
	assert.deepEqual(await h.slots(), { lastTurn: null, currentRun: measurement(0, 5_000, 2_000, 20, { assistantMessages: 2 }) }, "a zero-output checkpoint still contributes observed inference and completed-message count");
	await h.event(6_000, "agentEnd", { messages: [assistant(0)] });
	assert.deepEqual(await h.slots(), empty, "zero-output final clears provisional throughput");
}

for (const [name, payload] of [
	["zero output", { messages: [assistant(0)] }],
	["error", { messages: [assistant(20, {}, "error")] }],
	["aborted", { messages: [assistant(20, {}, "aborted")] }],
	["non-array messages", { messages: assistant(20) }],
	["no assistants", { messages: [{ role: "user" }] }],
] as const) {
	const h = createHarness();
	await seedFinal(h);
	h.event(10_000, "agentStart");
	h.update(11_000, "text_delta");
	await h.event(12_000, "turnEnd", turnEnd(0, assistant(25)));
	assert.deepEqual(await h.slots(), { lastTurn: trusted, currentRun: measurement(10_000, 12_000, 1_000, 25) });
	await h.event(15_000, "agentEnd", payload);
	h.event(20_000, "agentSettled");
	assert.deepEqual(await h.slots(), { lastTurn: trusted, currentRun: null }, `${name}: invalid final preserves the trusted result and cannot be resurrected by settled`);
}

{
	const h = createHarness();
	await seedFinal(h);
	h.event(10_000, "agentStart");
	for (const [index, type] of ["start", "thinking_start", "thinking_end", "text_start", "text_end", "toolcall_start", "toolcall_end", "done"].entries()) {
		h.update(11_000 + index * 100, type);
	}
	await h.event(20_000, "messageEnd", { message: assistant(50) });
	await h.event(30_000, "turnEnd", turnEnd(0, assistant(50)));
	assert.deepEqual(await h.slots(), { lastTurn: trusted, currentRun: null }, "block notifications without a delta never start inference");
	await h.event(40_000, "agentEnd", { messages: [assistant(50)] });
	assert.deepEqual(await h.slots(), { lastTurn: trusted, currentRun: null }, "usage without an observed stream must not fabricate a wall-time speed");
}

{
	const h = createHarness();
	await seedFinal(h);
	const renders = h.renders();
	h.event(10_000, "agentStart");
	assert.deepEqual(await h.slots(), { lastTurn: trusted, currentRun: null });
	assert.equal(h.renders(), renders, "starting the next run preserves lastTurn without redundant rendering");
	h.update(11_000, "text_delta");
	await h.event(12_000, "turnEnd", turnEnd(0, assistant(25)));
	h.event(13_000, "toolExecutionStart", { toolCallId: "stale", toolName: "bash" });
	h.event(14_000, "uiPromptStart");
	const beforeReset = h.renders();
	h.event(20_000, "agentStart");
	assert.deepEqual(await h.slots(), { lastTurn: trusted, currentRun: null }, "new start clears stale provisional throughput but preserves lastTurn");
	assert.equal(h.renders(), beforeReset + 1, "clearing visible provisional throughput requests a render");
	h.update(21_000, "text_delta");
	await h.event(22_000, "turnEnd", turnEnd(0, assistant(30)));
	assert.deepEqual(await h.slots(), { lastTurn: trusted, currentRun: measurement(20_000, 22_000, 1_000, 30) }, "new start resets accumulated inference, usage, duplicate indices, and both gates");
}

{
	const h = createHarness();
	h.event(0, "agentStart");
	h.update(1_000, "text_delta");
	await h.event(2_000, "turnEnd", turnEnd(0, assistant(20)));
	h.event(3_000, "sessionStart");
	h.update(4_000, "text_delta");
	await h.event(5_000, "turnEnd", turnEnd(1, assistant(20)));
	await h.event(6_000, "agentEnd", { messages: [assistant(20)] });
	assert.deepEqual(await h.slots(), empty, "sessionStart clears visible throughput and cancels stale tracking");
}

{
	const h = createHarness();
	h.event(0, "agentStart");
	h.update(1_000, "text_delta");
	await h.event(2_000, "turnEnd", turnEnd(0, assistant(20)));
	const before = await h.slots();
	await h.event(3_000, "sessionShutdown");
	h.update(4_000, "text_delta");
	await h.event(5_000, "turnEnd", turnEnd(1, assistant(20)));
	h.event(6_000, "agentSettled");
	assert.deepEqual(await h.slots(), before, "shutdown cancels stale tracking without changing existing visible-state teardown semantics");
}

assert.deepEqual(allNotifications.flat(), [], "throughput lifecycle paths must never notify the user");
console.log("✓ throughput runtime checks passed");
