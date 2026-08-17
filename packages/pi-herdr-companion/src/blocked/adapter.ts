import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { BlockedSourceRule, CompanionConfig } from "../config.ts";
import { hasUsableHerdrRuntime, type RuntimeSnapshot } from "../runtime.ts";
import {
	BlockedDepthTracker,
	HERDR_BLOCKED_EVENT,
	type BlockedSignal,
} from "./tracker.ts";

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function safeEmit(pi: Pick<ExtensionAPI, "events">, signal: BlockedSignal): void {
	try {
		pi.events.emit(HERDR_BLOCKED_EVENT, signal);
	} catch {
		// Optional integration listeners must never break the source event or tool.
	}
}

function trackerFor(pi: Pick<ExtensionAPI, "events">, rule: BlockedSourceRule): BlockedDepthTracker {
	return new BlockedDepthTracker(rule.label, (signal) => safeEmit(pi, signal));
}

interface EventSourceState {
	tracker: BlockedDepthTracker;
	unsubscribe(): void;
}

export interface BlockedAdapterController {
	/** Enable tracking for one session; duplicate initialization of the same context is ignored. */
	startSession(ctx: ExtensionContext): void;
	/** Reconcile configured sources without dropping unchanged in-flight state. */
	sync(): void;
}

/** Adapt configured event and tool lifecycles into Herdr's counted blocked event. */
export function registerBlockedAdapters(
	pi: ExtensionAPI,
	runtime: RuntimeSnapshot,
	getConfig: () => CompanionConfig,
): BlockedAdapterController {
	let enabled = false;
	let activeSessionContext: ExtensionContext | undefined;
	const eventSources = new Map<string, EventSourceState>();
	const toolTrackers = new Map<string, BlockedDepthTracker>();
	const activeToolCalls = new Map<string, BlockedDepthTracker>();

	function clearDepths(): void {
		for (const state of eventSources.values()) state.tracker.clear();
		for (const tracker of toolTrackers.values()) tracker.clear();
		activeToolCalls.clear();
	}

	function removeEventSource(name: string, state: EventSourceState): void {
		state.tracker.clear();
		state.unsubscribe();
		eventSources.delete(name);
	}

	function removeToolSource(name: string, tracker: BlockedDepthTracker): void {
		tracker.clear();
		for (const [toolCallId, activeTracker] of activeToolCalls) {
			if (activeTracker === tracker) activeToolCalls.delete(toolCallId);
		}
		toolTrackers.delete(name);
	}

	function resetSources(): void {
		for (const [name, state] of eventSources) removeEventSource(name, state);
		for (const [name, tracker] of toolTrackers) removeToolSource(name, tracker);
		activeToolCalls.clear();
	}

	function addEventSource(rule: BlockedSourceRule): void {
		const tracker = trackerFor(pi, rule);
		const unsubscribe = pi.events.on(rule.name, (data: unknown) => {
			try {
				if (!enabled || !isRecord(data)) return;
				if (data.active === true) tracker.update(true);
				else if (data.active === false) tracker.update(false);
			} catch {
				// Event bus callbacks execute inside the producer's emit call.
			}
		});
		eventSources.set(rule.name, { tracker, unsubscribe });
	}

	function sync(): void {
		if (!enabled) {
			resetSources();
			return;
		}

		const blocked = getConfig().blocked;
		const nextEvents = new Map(blocked.events.map((rule) => [rule.name, rule]));
		for (const [name, state] of eventSources) {
			const rule = nextEvents.get(name);
			if (!rule) {
				removeEventSource(name, state);
				continue;
			}
			state.tracker.relabel(rule.label);
			nextEvents.delete(name);
		}
		for (const rule of nextEvents.values()) addEventSource(rule);

		const nextTools = new Map(blocked.tools.map((rule) => [rule.name, rule]));
		for (const [name, tracker] of toolTrackers) {
			const rule = nextTools.get(name);
			if (!rule) {
				removeToolSource(name, tracker);
				continue;
			}
			tracker.relabel(rule.label);
			nextTools.delete(name);
		}
		for (const rule of nextTools.values()) toolTrackers.set(rule.name, trackerFor(pi, rule));
	}

	pi.on("tool_execution_start", (event) => {
		if (!enabled || activeToolCalls.has(event.toolCallId)) return;
		const tracker = toolTrackers.get(event.toolName);
		if (!tracker) return;
		activeToolCalls.set(event.toolCallId, tracker);
		tracker.update(true);
	});

	pi.on("tool_execution_end", (event) => {
		const tracker = activeToolCalls.get(event.toolCallId);
		if (!tracker) return;
		activeToolCalls.delete(event.toolCallId);
		tracker.update(false);
	});

	function startSession(ctx: ExtensionContext): void {
		if (activeSessionContext === ctx) return;
		resetSources();
		activeSessionContext = ctx;
		enabled = hasUsableHerdrRuntime(runtime);
		sync();
	}

	pi.on("session_start", (_event, ctx) => {
		startSession(ctx);
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (enabled && ctx.isIdle()) clearDepths();
	});

	pi.on("session_shutdown", () => {
		resetSources();
		enabled = false;
		activeSessionContext = undefined;
	});

	return { startSession, sync };
}
