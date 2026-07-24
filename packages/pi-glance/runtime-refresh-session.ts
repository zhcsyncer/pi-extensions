import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { applyRuntimeRefreshPlan } from "./runtime-plan-executor.js";
import { runtimePlanFor, type RuntimeEventFacts, type RuntimeEventKind } from "./runtime-policy.js";
import { assistantMessageHasKnownContextUsage, stateInputsFromContext, usageTotalsFromSessionMessage, type StateInputs, type StateMessageInputs } from "./runtime-snapshot.js";
import { addUsageTotals, clearCurrentRunThroughput, createInitialState, setCurrentRunThroughput, setGitSnapshot, setLastTurnThroughput } from "./state.js";
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
	private appliedAssistantMessageObjects = new WeakSet<object>();
	private appliedAssistantMessageResponseIds = new Set<string>();
	private readonly throughputTracker = new ThroughputRunTracker();

	constructor(private readonly host: RuntimeRefreshSessionHost) {}

	getState(): GlanceState | undefined {
		return this.state;
	}

	private setUnknownContextAfterLatestCompaction(value: boolean): void {
		this.unknownContextAfterLatestCompaction = value;
	}

	private readStateInputs(ctx: ExtensionContext): StateInputs {
		const inputs = stateInputsFromContext(ctx, this.host.getThinkingLevel(), this.host.getAutoCompactionEnabled(ctx));
		this.setUnknownContextAfterLatestCompaction(inputs.unknownContextAfterLatestCompaction);
		return inputs;
	}

	resetAccumulators(): void {
		this.appliedAssistantMessageObjects = new WeakSet<object>();
		this.appliedAssistantMessageResponseIds = new Set<string>();
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

	private usageTotalsAreZero(delta: ReturnType<typeof usageTotalsFromSessionMessage>): boolean {
		return delta.input === 0 && delta.output === 0 && delta.cacheRead === 0 && delta.cacheWrite === 0 && delta.cost === 0;
	}

	private applyMessageUsageDelta(message: RuntimeMessageEndInput): boolean {
		if (!this.state || (message.role !== "assistant" && message.role !== "toolResult")) return false;
		const delta = usageTotalsFromSessionMessage(message);
		if (this.usageTotalsAreZero(delta)) return false;
		if (typeof message.responseId === "string" && message.responseId) {
			if (this.appliedAssistantMessageResponseIds.has(message.responseId)) return false;
			this.appliedAssistantMessageResponseIds.add(message.responseId);
		} else if (typeof message === "object" && message !== null) {
			if (this.appliedAssistantMessageObjects.has(message)) return false;
			this.appliedAssistantMessageObjects.add(message);
		}
		return addUsageTotals(this.state, delta);
	}

	async execute(kind: RuntimeEventKind, ctx: ExtensionContext, options: RuntimeRefreshExecuteOptions = {}): Promise<void> {
		const plan = runtimePlanFor(kind, options.facts);
		if (plan.ensureConfig) await this.host.ensureConfig();
		if (plan.ensureState) this.ensureState(ctx);
		if (this.state) {
			applyRuntimeRefreshPlan({
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

	async messageEnd(message: RuntimeMessageEndInput, ctx: ExtensionContext): Promise<void> {
		if (message.role === "assistant") this.clearContextUnknownAfterKnownAssistantUsage(message);
		await this.execute("message_end", ctx, {
			facts: { messageRole: message.role },
			beforeRender: () => {
				this.applyMessageUsageDelta(message);
			},
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
