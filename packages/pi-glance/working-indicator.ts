import { estimateTokens, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { AssistantMessageEvent } from "@earendil-works/pi-ai";
import { resolveGlanceRenderStyles, type GlanceRenderStyleContext } from "./theme-adapter.js";
import type { GlanceConfig } from "./types.js";
import { renderWorkingMessage, styledWorkingSpinnerFrames, WORKING_SPINNER_INTERVAL_MS } from "./working-indicator-renderer.js";
import { WorkingIndicatorState, type WorkingAssistantMessage } from "./working-indicator-state.js";

const WORKING_VERBS = ["Brewing", "Composing", "Crafting", "Exploring", "Gathering", "Pondering", "Sketching", "Weaving"] as const;

interface WorkingUi {
	setWorkingMessage(message?: string): void;
	setWorkingIndicator(options?: { frames?: string[]; intervalMs?: number }): void;
}

export interface WorkingMessageUpdateEvent {
	readonly type: "message_update";
	readonly message: Parameters<typeof estimateTokens>[0];
	readonly assistantMessageEvent: AssistantMessageEvent;
}

interface MessageEndLike {
	readonly message: WorkingAssistantMessage;
}

interface ToolExecutionLike {
	readonly toolCallId: string;
	readonly toolName: string;
}

export interface WorkingIndicatorControllerAdapters {
	getConfig(): GlanceConfig;
	getThinkingLevel(): string;
	getTerminalWidth(): number;
	nowMs?: () => number;
	random?: () => number;
	setInterval?: (callback: () => void, milliseconds: number) => unknown;
	clearInterval?: (timer: unknown) => void;
	estimateMessageTokens?: (message: unknown) => number;
}

export interface WorkingIndicatorController {
	apply(ctx: ExtensionContext, renderStyleContext?: GlanceRenderStyleContext): void;
	agentStart(ctx: ExtensionContext): void;
	turnStart(): void;
	thinkingLevelChanged(): void;
	messageUpdate(event: WorkingMessageUpdateEvent): void;
	messageEnd(event: MessageEndLike): void;
	toolExecutionStart(event: ToolExecutionLike): void;
	toolExecutionEnd(event: Pick<ToolExecutionLike, "toolCallId">): void;
	agentSettled(): void;
	shutdown(): void;
}

function isTui(ctx: ExtensionContext): boolean {
	return ctx.mode === "tui";
}

export function createWorkingIndicatorController(adapters: WorkingIndicatorControllerAdapters): WorkingIndicatorController {
	const state = new WorkingIndicatorState();
	const nowMs = adapters.nowMs ?? Date.now;
	const random = adapters.random ?? Math.random;
	const schedule = adapters.setInterval ?? ((callback, milliseconds) => setInterval(callback, milliseconds));
	const unschedule = adapters.clearInterval ?? ((timer) => clearInterval(timer as ReturnType<typeof setInterval>));
	const estimate = adapters.estimateMessageTokens ?? ((message) => estimateTokens(message as Parameters<typeof estimateTokens>[0]));
	let ui: WorkingUi | undefined;
	let styleContext: GlanceRenderStyleContext | undefined;
	let timer: unknown;
	let installedStyleKey: string | undefined;
	let defaultsRestored = false;
	let pendingPartial: unknown;

	function featureEnabled(): boolean {
		const config = adapters.getConfig();
		return config.enabled && config.workingIndicator.enabled;
	}

	function restore(): void {
		if (timer !== undefined) {
			unschedule(timer);
			timer = undefined;
		}
		pendingPartial = undefined;
		if (ui && !defaultsRestored) {
			ui.setWorkingMessage();
			ui.setWorkingIndicator();
			defaultsRestored = true;
		}
		installedStyleKey = undefined;
	}

	function flushPartialEstimate(): void {
		if (pendingPartial === undefined) return;
		const partial = pendingPartial;
		pendingPartial = undefined;
		let estimatedOutput = 0;
		try {
			estimatedOutput = estimate(partial);
		} catch {
			estimatedOutput = 0;
		}
		state.setPartialEstimate(estimatedOutput);
	}

	function render(): void {
		if (!ui || !featureEnabled() || !state.snapshot.active) return;
		flushPartialEstimate();
		const config = adapters.getConfig();
		const styles = resolveGlanceRenderStyles(config, styleContext);
		if (styles.cacheKey !== installedStyleKey) {
			ui.setWorkingIndicator({ frames: styledWorkingSpinnerFrames(styles), intervalMs: WORKING_SPINNER_INTERVAL_MS });
			installedStyleKey = styles.cacheKey;
		}
		const width = Math.max(1, adapters.getTerminalWidth() - 4);
		ui.setWorkingMessage(renderWorkingMessage({ snapshot: state.snapshot, nowMs: nowMs(), width, styles }));
		defaultsRestored = false;
	}

	function startTimer(): void {
		if (timer !== undefined) return;
		timer = schedule(render, WORKING_SPINNER_INTERVAL_MS);
	}

	function finishCycle(): void {
		restore();
		state.settle();
	}

	return {
		apply(ctx, nextStyleContext) {
			if (!isTui(ctx)) return;
			ui = ctx.ui;
			styleContext = nextStyleContext;
			if (!featureEnabled()) {
				finishCycle();
				return;
			}
			if (state.snapshot.active) render();
		},
		agentStart(ctx) {
			if (!isTui(ctx) || !featureEnabled()) return;
			ui = ctx.ui;
			pendingPartial = undefined;
			const verbs = WORKING_VERBS;
			const verb = verbs[Math.min(verbs.length - 1, Math.floor(Math.max(0, random()) * verbs.length))]!;
			state.agentStart(nowMs(), verb, adapters.getThinkingLevel());
			startTimer();
			render();
		},
		turnStart() {
			pendingPartial = undefined;
			state.turnStart(nowMs(), adapters.getThinkingLevel());
			render();
		},
		thinkingLevelChanged() {
			state.setThinkingEffort(adapters.getThinkingLevel());
			render();
		},
		messageUpdate(event) {
			if (!state.snapshot.active || !featureEnabled()) return;
			state.messageUpdate(event.assistantMessageEvent.type, nowMs());
			pendingPartial = event.message;
		},
		messageEnd(event) {
			pendingPartial = undefined;
			state.messageEnd(event.message, nowMs());
			render();
		},
		toolExecutionStart(event) {
			state.toolExecutionStart(event.toolCallId, event.toolName, nowMs());
			render();
		},
		toolExecutionEnd(event) {
			state.toolExecutionEnd(event.toolCallId, nowMs());
			render();
		},
		agentSettled: finishCycle,
		shutdown: finishCycle,
	};
}
