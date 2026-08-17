import { randomUUID } from "node:crypto";
import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
	type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import type { HerdrClient } from "../herdr-client.ts";
import type { RuntimeSnapshot } from "../runtime.ts";
import {
	composeNativeSystemPrompt,
	decideCacheMode,
	fingerprintActiveToolSchemas,
	type CacheMode,
} from "./cache-mode.ts";
import {
	SIDE_PANE_INSTRUCTIONS,
	buildContextDocument,
	buildNativeBridgeMessage,
	buildParentContextMessage,
	serializeParentContext,
} from "./context.ts";
import type { BtwContextStore } from "./context-store.ts";
import {
	MAX_MERGE_PROMPT_BYTES,
	MERGE_PROTOCOL_VERSION,
	ackMatchesRequest,
	buildMergeTranscript,
	isMergePromptWithinBounds,
	type LaunchState,
	type MergeRequest,
} from "./protocol.ts";
import { BTW_HELP, parseBtwCommand } from "./router.ts";
import type { BtwPayload } from "./types.ts";

export type ChildStorePort = Pick<
	BtwContextStore,
	| "read"
	| "readLaunchState"
	| "mutateLaunchState"
	| "readMergeRequest"
	| "readMergeAck"
	| "createMergeRequest"
	| "removeIfNoPendingMerge"
>;
export type ChildHerdrClient = Pick<HerdrClient, "getAgent" | "focusAgent" | "closePane">;

export interface ChildSessionBinding {
	bound: boolean;
	reason?: string;
	state?: LaunchState;
}

export interface BtwChildRegistration {
	/** Initialize the current TUI session when registration occurs during session_start. */
	startSession(event: SessionStartEvent, ctx: ExtensionContext): Promise<void>;
}

/** Bind exactly the first Pi session that consumes this private launch. */
export async function bindChildSession(
	store: Pick<BtwContextStore, "mutateLaunchState">,
	payloadPath: string,
	payload: Pick<BtwPayload, "launchId">,
	childSessionId: string,
	now: () => Date = () => new Date(),
): Promise<ChildSessionBinding> {
	let reason: string | undefined;
	let conflicting: LaunchState | undefined;
	let state: LaunchState | undefined;
	try {
		state = await store.mutateLaunchState(payloadPath, (current) => {
			if (!current) {
				reason = "private launch binding state is missing or unreadable";
				return undefined;
			}
			if (current.launchId !== payload.launchId) {
				reason = "private launch binding belongs to another launch";
				return undefined;
			}
			if (current.childSessionId && current.childSessionId !== childSessionId) {
				reason = `this side thread is bound to Pi session ${current.childSessionId}; the current session ${childSessionId} is unrelated`;
				conflicting = current;
				return undefined;
			}
			if (current.childSessionId === childSessionId) return undefined;
			return { ...current, childSessionId, updatedAt: now().toISOString() } satisfies LaunchState;
		});
	} catch {
		return { bound: false, reason: "private launch binding state is missing or unreadable" };
	}
	if (reason) return { bound: false, reason, ...(conflicting ? { state: conflicting } : {}) };
	return state ? { bound: true, state } : { bound: false, reason: "private launch binding state is missing or unreadable" };
}

export type ChildPreCloseStatus = "completed" | "blocked" | "failed";

export interface ChildCloseResult {
	closed: boolean;
	childPaneId?: string;
	preCloseStatus?: ChildPreCloseStatus;
	resolutionError?: string;
	focusError?: string;
	preCloseError?: string;
	closeError?: string;
}

export async function focusParentAndCloseChild(
	client: ChildHerdrClient,
	payload: Pick<BtwPayload, "parentPaneId">,
	launchState: Pick<LaunchState, "agentName">,
	beforeClose: () => Promise<boolean>,
): Promise<ChildCloseResult> {
	if (!launchState.agentName) {
		return { closed: false, resolutionError: "the launch has no durable Herdr agent name" };
	}
	let childPaneId: string;
	try {
		childPaneId = (await client.getAgent(launchState.agentName)).paneId;
	} catch (error) {
		return {
			closed: false,
			resolutionError: error instanceof Error ? error.message : String(error),
		};
	}
	if (!childPaneId || childPaneId === payload.parentPaneId) {
		return { closed: false, childPaneId, resolutionError: "Herdr did not resolve a distinct child pane" };
	}
	try {
		await client.focusAgent(payload.parentPaneId);
	} catch (error) {
		return {
			closed: false,
			childPaneId,
			focusError: error instanceof Error ? error.message : String(error),
		};
	}
	try {
		if (!await beforeClose()) {
			return { closed: false, childPaneId, preCloseStatus: "blocked" };
		}
	} catch (error) {
		return {
			closed: false,
			childPaneId,
			preCloseStatus: "failed",
			preCloseError: error instanceof Error ? error.message : String(error),
		};
	}
	try {
		await client.closePane(childPaneId);
		return { closed: true, childPaneId, preCloseStatus: "completed" };
	} catch (error) {
		return {
			closed: false,
			childPaneId,
			preCloseStatus: "completed",
			closeError: error instanceof Error ? error.message : String(error),
		};
	}
}

const ACK_POLL_INTERVAL_MS = 1_000;

export async function registerBtwChild(
	pi: ExtensionAPI,
	options: {
		store: ChildStorePort;
		client: ChildHerdrClient;
		payloadPath: string;
		runtime: RuntimeSnapshot;
	},
): Promise<BtwChildRegistration> {
	const { store, client, payloadPath, runtime } = options;
	let payload: BtwPayload | undefined;
	let payloadError: string | undefined;
	try {
		payload = await store.read(payloadPath);
	} catch (error) {
		payloadError = error instanceof Error ? error.message : String(error);
	}

	const document = payload
		? buildContextDocument(payload.metadata, serializeParentContext(payload.messages))
		: "";
	let cacheMode: CacheMode = { mode: "flattened", reason: "not negotiated" };
	let activeSessionContext: ExtensionContext | undefined;
	let sessionUi: { notify(message: string, type: "info" | "warning" | "error"): void } | undefined;
	let ackTimer: ReturnType<typeof setInterval> | undefined;
	let closing = false;
	let acceptedMailboxCleaned = false;
	let sideThreadEnabled = false;
	let bindingReason = "the side-thread session binding has not been established";
	let lastAcceptedWarning: string | undefined;
	let lastPollingWarning: string | undefined;
	let lastRejectedRequestId: string | undefined;

	function stopAckPolling(): void {
		if (ackTimer) clearInterval(ackTimer);
		ackTimer = undefined;
	}

	function warnAcceptedOnce(message: string): void {
		if (lastAcceptedWarning === message) return;
		lastAcceptedWarning = message;
		sessionUi?.notify(message, "warning");
	}

	function warnPollingOnce(message: string): void {
		if (lastPollingWarning === message) return;
		lastPollingWarning = message;
		sessionUi?.notify(message, "warning");
	}

	async function acceptAndClose(acceptedPayload: BtwPayload): Promise<void> {
		if (closing || acceptedMailboxCleaned || !sideThreadEnabled) return;
		closing = true;
		let launchState: LaunchState | undefined;
		try {
			launchState = await store.readLaunchState(payloadPath);
		} catch (error) {
			warnAcceptedOnce(`Merge was accepted, but child pane identity could not be read; this pane was kept open and recovery will retry: ${error instanceof Error ? error.message : String(error)}`);
			closing = false;
			return;
		}
		if (!launchState) {
			warnAcceptedOnce("Merge was accepted, but child pane identity is unavailable; this pane was kept open and recovery will retry.");
			closing = false;
			return;
		}
		const returned = await focusParentAndCloseChild(client, acceptedPayload, launchState, async () => {
			const removed = await store.removeIfNoPendingMerge(payloadPath);
			if (removed) {
				// Herdr may terminate this Pi before closePane resolves, so stop all
				// mailbox work after confirmed cleanup and before invoking pane close.
				acceptedMailboxCleaned = true;
				stopAckPolling();
			}
			return removed;
		});
		if (returned.closed) return;
		if (returned.focusError !== undefined) {
			warnAcceptedOnce(`Merge was accepted, but parent focus failed; this side pane was kept open and recovery will retry: ${returned.focusError}`);
		} else if (returned.resolutionError !== undefined) {
			warnAcceptedOnce(`Merge was accepted, but the current child pane could not be resolved; it was kept open and recovery will retry: ${returned.resolutionError}`);
		} else if (returned.preCloseStatus === "blocked") {
			warnAcceptedOnce("Merge was accepted and parent focus succeeded, but private mailbox cleanup could not confirm a matching acknowledgement; this side pane was kept open and launch evidence was preserved. Recovery will retry.");
		} else if (returned.preCloseStatus === "failed") {
			warnAcceptedOnce(`Merge was accepted and parent focus succeeded, but private mailbox cleanup failed; this side pane was kept open and launch evidence was preserved. Recovery will retry: ${returned.preCloseError ?? "unknown cleanup error"}`);
		} else if (returned.closeError !== undefined) {
			warnAcceptedOnce(`Merge was accepted, parent focus succeeded, and private mailbox state was cleared, but side pane ${returned.childPaneId ?? "(unknown)"} could not close. Close it manually; automatic retry is unavailable: ${returned.closeError}`);
		}
		closing = false;
	}

	async function pollAck(): Promise<void> {
		if (!payload || closing || acceptedMailboxCleaned || !sideThreadEnabled) return;
		let request: unknown;
		try {
			request = await store.readMergeRequest(payloadPath);
		} catch (error) {
			warnPollingOnce(`BTW merge recovery could not read its private request; polling remains active: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		if (request === undefined) return;
		let ack;
		try {
			ack = await store.readMergeAck(payloadPath);
		} catch (error) {
			warnPollingOnce(`BTW merge recovery could not read the parent acknowledgement; polling remains active: ${error instanceof Error ? error.message : String(error)}`);
			return;
		}
		lastPollingWarning = undefined;
		if (!ackMatchesRequest(ack, request)) return;
		if (ack?.status === "accepted") {
			await acceptAndClose(payload);
			return;
		}
		stopAckPolling();
		if (ack && lastRejectedRequestId !== ack.requestId) {
			lastRejectedRequestId = ack.requestId;
			sessionUi?.notify(`BTW merge rejected by the parent: ${ack.reason ?? "unknown reason"}`, "error");
		}
	}

	function startAckPolling(): void {
		if (ackTimer || acceptedMailboxCleaned || !sideThreadEnabled) return;
		ackTimer = setInterval(() => void pollAck(), ACK_POLL_INTERVAL_MS);
		ackTimer.unref?.();
		void pollAck();
	}

	pi.on("before_agent_start", (event, ctx) => {
		if (!payload || !sideThreadEnabled) return;
		const activeTools = pi.getActiveTools();
		cacheMode = decideCacheMode(payload, {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			activeTools,
			toolSchemaFingerprint: fingerprintActiveToolSchemas(activeTools, pi.getAllTools()),
			thinkingLevel: pi.getThinkingLevel(),
		});
		if (cacheMode.mode === "native") {
			return {
				systemPrompt: composeNativeSystemPrompt(payload.parentSystemPrompt as string, event.systemPrompt),
			};
		}
		return {
			systemPrompt: `${event.systemPrompt}\n\n${SIDE_PANE_INSTRUCTIONS}\n\nPrompt-cache fallback: ${cacheMode.reason}.`,
		};
	});

	pi.on("context", (event) => {
		if (!payload || !sideThreadEnabled) return;
		return cacheMode.mode === "native"
			? { messages: [...payload.messages, buildNativeBridgeMessage(runtime), ...event.messages] }
			: { messages: [buildParentContextMessage(document), ...event.messages] };
	});

	if (payloadError) {
		pi.on("input", (_event, ctx) => {
			ctx.ui.notify(`/btw is blocked because its private launch payload could not be loaded: ${payloadError}`, "error");
			return { action: "handled" };
		});
	}

	pi.registerCommand("btw", {
		description: "Side thread: merge into the exact parent session, or show help",
		handler: async (args, ctx) => {
			if (!sideThreadEnabled) {
				ctx.ui.notify(`BTW side-thread behavior is disabled: ${bindingReason}. Continue as an independent Pi session.`, "warning");
				return;
			}
			const route = parseBtwCommand(args);
			if (route.kind === "help") {
				ctx.ui.notify(BTW_HELP, "info");
				return;
			}
			if (route.kind !== "merge") {
				ctx.ui.notify("This is a /btw side pane. Use /btw merge <parent follow-up> or /btw help.", "warning");
				return;
			}
			if (!payload) {
				ctx.ui.notify(`/btw merge is unavailable: ${payloadError ?? "missing payload"}`, "error");
				return;
			}

			if (acceptedMailboxCleaned) {
				ctx.ui.notify("This merge was already accepted and its private mailbox was cleared. Close this side pane manually; automatic retry is unavailable.", "warning");
				return;
			}
			let existingRequest: unknown;
			try {
				existingRequest = await store.readMergeRequest(payloadPath);
			} catch (error) {
				ctx.ui.notify(`/btw merge recovery could not read its private request; no new request was created: ${error instanceof Error ? error.message : String(error)}`, "warning");
				startAckPolling();
				return;
			}
			let existingAck;
			try {
				existingAck = await store.readMergeAck(payloadPath);
			} catch (error) {
				ctx.ui.notify(`/btw merge recovery could not read the parent acknowledgement; no new request was created: ${error instanceof Error ? error.message : String(error)}`, "warning");
				startAckPolling();
				return;
			}
			if (existingRequest !== undefined && ackMatchesRequest(existingAck, existingRequest) && existingAck?.status === "accepted") {
				ctx.ui.notify("The parent already accepted this merge; retrying safe mailbox cleanup and pane close.", "info");
				await acceptAndClose(payload);
				return;
			}
			if (existingRequest !== undefined && !ackMatchesRequest(existingAck, existingRequest)) {
				ctx.ui.notify("A merge is already pending for this side thread.", "warning");
				startAckPolling();
				return;
			}

			let prompt = route.prompt.trim();
			if (!prompt) prompt = (await ctx.ui.editor("Follow-up prompt for the parent after merging", ""))?.trim() ?? "";
			if (!prompt) {
				ctx.ui.notify("Merge cancelled; no parent follow-up was provided.", "info");
				return;
			}
			if (!isMergePromptWithinBounds(prompt)) {
				ctx.ui.notify(`Parent follow-up must be 1..${MAX_MERGE_PROMPT_BYTES / 1024} KiB.`, "error");
				return;
			}
			const transcript = buildMergeTranscript(
				buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId()).messages,
			);
			if (!transcript) {
				ctx.ui.notify("Nothing to merge: the side thread has no user/assistant text.", "warning");
				return;
			}

			const request: MergeRequest = {
				protocolVersion: MERGE_PROTOCOL_VERSION,
				requestId: randomUUID(),
				launchId: payload.launchId,
				parentSessionId: payload.parentSessionId,
				capability: payload.capability,
				createdAt: new Date().toISOString(),
				summary: transcript,
				prompt,
			};
			try {
				await store.createMergeRequest(payloadPath, request);
				ctx.ui.notify("BTW merge is pending; this pane will close only after parent session evidence and accepted ack.", "info");
				startAckPolling();
			} catch (error) {
				ctx.ui.notify(`/btw merge failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	async function startSession(event: SessionStartEvent, ctx: ExtensionContext): Promise<void> {
		if (ctx.mode !== "tui" || activeSessionContext === ctx) return;
		activeSessionContext = ctx;
		sessionUi = ctx.ui;
		ctx.ui.setTitle("pi /btw — Herdr side thread");
		if (!payload) {
			ctx.ui.setWidget("herdr-companion-btw", [
				ctx.ui.theme.fg("error", "BTW payload unavailable; prompts are blocked."),
				ctx.ui.theme.fg("dim", payloadError ?? "unknown payload error"),
			]);
			return;
		}
		const binding = await bindChildSession(
			store,
			payloadPath,
			payload,
			ctx.sessionManager.getSessionId(),
		);
		sideThreadEnabled = binding.bound;
		bindingReason = binding.reason ?? "bound";
		if (!binding.bound) {
			stopAckPolling();
			ctx.ui.notify(`BTW side-thread behavior is disabled: ${bindingReason}. Parent context will not be replayed or merged.`, "warning");
			ctx.ui.setWidget("herdr-companion-btw", [
				ctx.ui.theme.fg("warning", "BTW disabled for this unrelated Pi session"),
				ctx.ui.theme.fg("dim", bindingReason),
			]);
			return;
		}
		ctx.ui.setWidget("herdr-companion-btw", [
			ctx.ui.theme.fg("accent", "BTW side thread · Pi default tools"),
			ctx.ui.theme.fg("dim", "Shared cwd; explicit /btw merge required"),
		]);
		startAckPolling();
	}

	pi.on("session_start", startSession);

	pi.on("session_shutdown", async (event) => {
		stopAckPolling();
		activeSessionContext = undefined;
		sessionUi = undefined;
		if (sideThreadEnabled && event.reason === "quit") {
			await store.removeIfNoPendingMerge(payloadPath).catch(() => undefined);
		}
		sideThreadEnabled = false;
	});

	return { startSession };
}
