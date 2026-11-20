import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyRuntimeRefreshPlan } from "./runtime-plan-executor.js";
import { runtimePlanFor, type RuntimeEventFacts, type RuntimeEventKind } from "./runtime-policy.js";
import { assistantMessageHasKnownContextUsage, stateInputsFromContext, usageTotalsFromEntries, type StateInputs, type StateMessageInputs } from "./runtime-snapshot.js";
import { addUsageTotals, clearCurrentRunThroughput, createInitialState, setCurrentRunThroughput, setGitSnapshot, setLastTurnThroughput, setUsageTotals } from "./state.js";
import { ThroughputRunTracker, type ThroughputRunStateIntent } from "./throughput-run-tracker.js";
import type { GitSnapshot, GlanceConfig, GlanceState } from "./types.js";

export type RuntimeMessageEndInput = StateMessageInputs & { responseId?: unknown };

export interface RuntimeTurnEndInput {
	turnIndex?: unknown;
	message?: unknown;
}

export interface RuntimeAgentEndInput {
	messages?: unknown;
}

export interface RuntimeRefreshSessionHost {
	getConfig(): GlanceConfig;
	ensureConfig(): Promise<GlanceConfig>;
	getThinkingLevel(): string;
	getAutoCompactionEnabled(ctx: ExtensionContext): boolean;
	nowMs(): number;
	requestRender(): void;
	scheduleGitRefresh(immediate?: boolean): void;
}

export interface RuntimeRefreshExecuteOptions {
	facts?: RuntimeEventFacts;
	beforeRender?: () => void;
}

function applyThroughputIntent(state: GlanceState, intent: ThroughputRunStateIntent): boolean {
	switch (intent.kind) {
		case "none":
			return false;
		case "set-current-run":
			return setCurrentRunThroughput(state, intent.currentRun);
		case "clear-current-run":
			return clearCurrentRunThroughput(state);
		case "set-last-turn-and-clear-current-run": {
			const lastTurnChanged = setLastTurnThroughput(state, intent.lastTurn);
			const currentRunChanged = clearCurrentRunThroughput(state);
			return lastTurnChanged || currentRunChanged;
		}
	}
}

export class RuntimeRefreshSession {
	private state?: GlanceState;
	private unknownContextAfterLatestCompaction = false;
	private entryCount = 0;
	private appliedEntryIds = new Set<string>();
	private readonly throughputTracker = new ThroughputRunTracker();

	constructor(private readonly host: RuntimeRefreshSessionHost) {}

	getState(): GlanceState | undefined {
		return this.state;
	}

	private setUnknownContextAfterLatestCompaction(value: boolean): void {
		this.unknownContextAfterLatestCompaction = value;
	}

	private readStateInputs(ctx: ExtensionContext): StateInputs {
		const entries = ctx.sessionManager.getEntries();
		this.entryCount = entries.length;
		this.appliedEntryIds = new Set(entries.map((entry) => entry.id));
		const inputs = stateInputsFromContext(ctx, this.host.getThinkingLevel(), this.host.getAutoCompactionEnabled(ctx), usageTotalsFromEntries(entries));
		this.setUnknownContextAfterLatestCompaction(inputs.unknownContextAfterLatestCompaction);
		return inputs;
	}

	resetAccumulators(): void {
		this.entryCount = 0;
		this.appliedEntryIds.clear();
		this.throughputTracker.reset();
	}

	resetState(ctx: ExtensionContext): GlanceState {
		this.state = createInitialState(this.readStateInputs(ctx), this.host.getConfig());
		return this.state;
	}

	sessionStart(ctx: ExtensionContext): GlanceState {
		this.resetAccumulators();
		return this.resetState(ctx);
	}

	sessionShutdown(): void {
		this.resetAccumulators();
	}

	ensureState(ctx: ExtensionContext): GlanceState {
		this.state ??= createInitialState(this.readStateInputs(ctx), this.host.getConfig());
		return this.state;
	}

	clearContextUnknownAfterKnownAssistantUsage(message: StateMessageInputs): void {
		if (this.unknownContextAfterLatestCompaction && assistantMessageHasKnownContextUsage(message)) {
			this.unknownContextAfterLatestCompaction = false;
		}
	}

	private syncRecordedUsage(ctx: ExtensionContext, rebuild = false): void {
		if (!this.state) return;
		// The readonly SDK exposes a copy, not an indexed entries API. Only visit
		// the new suffix at durable boundaries, never from the render path.
		const entries = ctx.sessionManager.getEntries();
		if (rebuild || this.entryCount === 0 || entries.length < this.entryCount) {
			this.appliedEntryIds = new Set(entries.map((entry) => entry.id));
			setUsageTotals(this.state, usageTotalsFromEntries(entries));
		} else {
			const added = entries.slice(this.entryCount).filter((entry) => {
				if (this.appliedEntryIds.has(entry.id)) return false;
				this.appliedEntryIds.add(entry.id);
				return true;
			});
			addUsageTotals(this.state, usageTotalsFromEntries(added));
		}
		this.entryCount = entries.length;
	}

	async execute(kind: RuntimeEventKind, ctx: ExtensionContext, options: RuntimeRefreshExecuteOptions = {}): Promise<void> {
		const plan = runtimePlanFor(kind, options.facts);
		if (plan.ensureConfig) await this.host.ensureConfig();
		if (plan.ensureState) this.ensureState(ctx);
		if (this.state) {
			if (kind !== "message_end" && kind !== "tool_execution_end" && kind !== "editor_thinking_cycle" && kind !== "thinking_level_select") {
				this.syncRecordedUsage(ctx, kind === "session_tree" || kind === "session_compact");
			}
			applyRuntimeRefreshPlan({
				usage: this.state.usage,
				state: this.state,
				config: this.host.getConfig(),
				ctx,
				plan,
				getThinkingLevel: () => this.host.getThinkingLevel(),
				getAutoCompactionEnabled: (runtimeCtx) => this.host.getAutoCompactionEnabled(runtimeCtx),
				unknownContextAfterLatestCompaction: this.unknownContextAfterLatestCompaction,
				setUnknownContextAfterLatestCompaction: (value) => this.setUnknownContextAfterLatestCompaction(value),
				scheduleGitRefresh: (immediate) => this.host.scheduleGitRefresh(immediate),
			});
		}
		options.beforeRender?.();
		if (plan.render) this.host.requestRender();
	}

	messageUpdate(eventType: string): void {
		this.throughputTracker.messageUpdate(eventType, () => this.host.nowMs());
	}

	toolExecutionStart(toolCallId: string): void {
		this.throughputTracker.toolExecutionStart(toolCallId, () => this.host.nowMs());
	}

	toolExecutionEnd(toolCallId: string): void {
		this.throughputTracker.toolExecutionEnd(toolCallId);
	}

	uiPromptStart(): void {
		this.throughputTracker.uiPromptStart(() => this.host.nowMs());
	}

	uiPromptEnd(): void {
		this.throughputTracker.uiPromptEnd();
	}

	agentSettled(ctx: ExtensionContext): void {
		const version = this.state?.version;
		this.syncRecordedUsage(ctx);
		const intent = this.throughputTracker.settle(() => this.host.nowMs());
		if (this.state) {
			applyThroughputIntent(this.state, intent);
			if (this.state.version !== version) this.host.requestRender();
		}
	}

	async messageEnd(message: RuntimeMessageEndInput, ctx: ExtensionContext): Promise<void> {
		if (message.role === "assistant") {
			this.throughputTracker.messageEnd(() => this.host.nowMs());
			this.clearContextUnknownAfterKnownAssistantUsage(message);
		}
		await this.execute("message_end", ctx, {
			facts: { messageRole: message.role },
		});
	}

	async turnEnd(event: RuntimeTurnEndInput, ctx: ExtensionContext): Promise<void> {
		await this.execute("turn_end", ctx, {
			beforeRender: () => {
				if (!this.state) return;
				applyThroughputIntent(this.state, this.throughputTracker.checkpoint(event.turnIndex, event.message, () => this.host.nowMs()));
			},
		});
	}

	agentStart(): void {
		const intent = this.throughputTracker.start(this.host.nowMs());
		if (this.state && applyThroughputIntent(this.state, intent)) this.host.requestRender();
	}

	async agentEnd(event: RuntimeAgentEndInput, ctx: ExtensionContext): Promise<void> {
		const intent = this.throughputTracker.finish(event.messages, () => this.host.nowMs());
		await this.execute("agent_end", ctx, {
			beforeRender: () => {
				if (!this.state) return;
				applyThroughputIntent(this.state, intent);
			},
		});
	}

	applyGitSnapshot(cwd: string, snapshot: GitSnapshot): boolean {
		if (!this.state || !setGitSnapshot(this.state, cwd, snapshot)) return false;
		this.host.requestRender();
		return true;
	}
}
