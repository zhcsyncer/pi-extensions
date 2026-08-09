import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { CompanionConfig } from "../config.ts";
import { hasUsableHerdrRuntime, type RuntimeSnapshot } from "../runtime.ts";
import {
	ASK_USER_BLOCKED_EVENT,
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
		// Optional integration listeners must never break ask-user-question.
	}
}

export function registerAskUserBlockedAdapter(
	pi: ExtensionAPI,
	runtime: RuntimeSnapshot,
	getConfig: () => CompanionConfig,
): BlockedDepthTracker {
	let enabled = false;
	const tracker = new BlockedDepthTracker("question", (signal) => safeEmit(pi, signal));

	pi.events.on(ASK_USER_BLOCKED_EVENT, (data: unknown) => {
		try {
			if (!enabled || !isRecord(data)) return;
			if (data.active === true) tracker.update(true);
			else if (data.active === false) tracker.update(false);
		} catch {
			// Event-bus callbacks execute inside the producer's emit call.
		}
	});

	pi.on("session_start", (_event, ctx) => {
		tracker.clear();
		enabled = hasUsableHerdrRuntime(runtime) && ctx.mode === "tui" && getConfig().blocked.askUserQuestion;
	});

	pi.on("agent_settled", (_event, ctx) => {
		if (enabled && ctx.isIdle()) tracker.clear();
	});

	pi.on("session_shutdown", () => {
		tracker.clear();
		enabled = false;
	});

	return tracker;
}
