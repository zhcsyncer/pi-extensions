import { randomUUID } from "node:crypto";
import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrClient } from "../herdr-client.ts";
import type { RuntimeSnapshot } from "../runtime.ts";
import { decideCacheMode, fingerprintActiveToolSchemas, type CacheMode } from "./cache-mode.ts";
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
import { BTW_LAUNCH_DRAFT_ARG, type BtwPayload } from "./types.ts";

export type ChildStorePort = Pick<
	BtwContextStore,
	| "read"
	| "readLaunchState"
	| "writeLaunchState"
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

/** Bind exactly the first Pi session that consumes this private launch. */
export async function bindChildSession(
	store: Pick<BtwContextStore, "readLaunchState" | "writeLaunchState">,
	payloadPath: string,
	payload: Pick<BtwPayload, "launchId">,
	childSessionId: string,
	now: () => Date = () => new Date(),
): Promise<ChildSessionBinding> {
	const state = await store.readLaunchState(payloadPath).catch(() => undefined);
	if (!state) return { bound: false, reason: "private launch binding state is missing or unreadable" };
	if (state.launchId !== payload.launchId) return { bound: false, reason: "private launch binding belongs to another launch" };
	if (state.childSessionId && state.childSessionId !== childSessionId) {
		return {
			bound: false,
			reason: `this side thread is bound to Pi session ${state.childSessionId}; the current session ${childSessionId} is unrelated`,
			state,
		};
	}
	if (state.childSessionId === childSessionId) return { bound: true, state };
	const bound = { ...state, childSessionId, updatedAt: now().toISOString() } satisfies LaunchState;
	await store.writeLaunchState(payloadPath, bound);
	return { bound: true, state: bound };
}

export async function focusParentAndCloseChild(
	client: ChildHerdrClient,
	payload: Pick<BtwPayload, "parentPaneId">,
	launchState: Pick<LaunchState, "agentName">,
): Promise<{
	closed: boolean;
	childPaneId?: string;
	resolutionError?: string;
	focusError?: string;
	closeError?: string;
}> {
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
		await client.closePane(childPaneId);
		return { closed: true, childPaneId };
	} catch (error) {
		return {
			closed: false,
			childPaneId,
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
): Promise<void> {
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
	let sessionUi: { notify(message: string, type: "info" | "warning" | "error"): void } | undefined;
	let ackTimer: ReturnType<typeof setInterval> | undefined;
	let closing = false;
	let sideThreadEnabled = false;
	let bindingReason = "the side-thread session binding has not been established";
	let lastRejectedRequestId: string | undefined;

	function stopAckPolling(): void {
		if (ackTimer) clearInterval(ackTimer);
		ackTimer = undefined;
	}

	async function acceptAndClose(acceptedPayload: BtwPayload): Promise<void> {
		if (closing || !sideThreadEnabled) return;
		closing = true;
		stopAckPolling();
		const launchState = await store.readLaunchState(payloadPath).catch(() => undefined);
		if (!launchState) {
			sessionUi?.notify("Merge was accepted, but child pane identity is unavailable; this pane was kept open.", "warning");
			closing = false;
			return;
		}
		const returned = await focusParentAndCloseChild(client, acceptedPayload, launchState);
		if (returned.closed) return;
		if (returned.focusError) {
			sessionUi?.notify(`Merge was accepted, but parent focus failed; this side pane was kept open: ${returned.focusError}`, "warning");
		} else if (returned.resolutionError) {
			sessionUi?.notify(`Merge was accepted, but the current child pane could not be resolved; it was kept open: ${returned.resolutionError}`, "warning");
		} else if (returned.closeError) {
			sessionUi?.notify(`Merge was accepted and parent focus succeeded, but the side pane could not close: ${returned.closeError}`, "warning");
		}
		closing = false;
	}

	async function pollAck(): Promise<void> {
		if (!payload || closing || !sideThreadEnabled) return;
		const request = await store.readMergeRequest(payloadPath).catch(() => undefined);
		if (request === undefined) return;
		const ack = await store.readMergeAck(payloadPath).catch(() => undefined);
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
		if (ackTimer || !sideThreadEnabled) return;
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
		if (cacheMode.mode === "native") return { systemPrompt: payload.parentSystemPrompt as string };
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

	let launchDraftPending = Boolean(payload?.config.autoSubmit && payload.draftQuestion.trim());
	pi.registerCommand("btw", {
		description: "Side thread: merge into the exact parent session, or show help",
		handler: async (args, ctx) => {
			if (!sideThreadEnabled) {
				ctx.ui.notify(`BTW side-thread behavior is disabled: ${bindingReason}. Continue as an independent Pi session.`, "warning");
				return;
			}
			if (args.trim() === BTW_LAUNCH_DRAFT_ARG) {
				if (launchDraftPending && payload) {
					launchDraftPending = false;
					pi.sendUserMessage(payload.draftQuestion);
				}
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

			const existingRequest = await store.readMergeRequest(payloadPath).catch(() => undefined);
			const existingAck = await store.readMergeAck(payloadPath).catch(() => undefined);
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

	pi.on("session_start", async (_event, ctx) => {
		sessionUi = ctx.ui;
		if (ctx.mode === "tui") ctx.ui.setTitle("pi /btw — Herdr side thread");
		if (!payload) {
			if (ctx.mode === "tui") {
				ctx.ui.setWidget("herdr-companion-btw", [
					ctx.ui.theme.fg("error", "BTW payload unavailable; prompts are blocked."),
					ctx.ui.theme.fg("dim", payloadError ?? "unknown payload error"),
				]);
			}
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
			launchDraftPending = false;
			stopAckPolling();
			ctx.ui.notify(`BTW side-thread behavior is disabled: ${bindingReason}. Parent context will not be replayed or merged.`, "warning");
			if (ctx.mode === "tui") {
				ctx.ui.setWidget("herdr-companion-btw", [
					ctx.ui.theme.fg("warning", "BTW disabled for this unrelated Pi session"),
					ctx.ui.theme.fg("dim", bindingReason),
				]);
			}
			return;
		}
		if (ctx.mode === "tui") {
			ctx.ui.setWidget("herdr-companion-btw", [
				ctx.ui.theme.fg("accent", `BTW side thread · tools ${payload.config.tools}`),
				ctx.ui.theme.fg("dim", "Shared cwd; explicit /btw merge required"),
			]);
			if (_event.reason === "startup" && payload.draftQuestion.trim() && !payload.config.autoSubmit) {
				ctx.ui.setEditorText(payload.draftQuestion);
			}
		}
		startAckPolling();
	});

	pi.on("session_shutdown", async (event) => {
		stopAckPolling();
		sessionUi = undefined;
		if (sideThreadEnabled && event.reason === "quit") {
			await store.removeIfNoPendingMerge(payloadPath).catch(() => undefined);
		}
		sideThreadEnabled = false;
	});
}
