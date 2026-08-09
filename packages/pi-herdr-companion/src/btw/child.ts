import { randomUUID } from "node:crypto";
import { buildSessionContext, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrClient } from "../herdr-client.ts";
import type { RuntimeSnapshot } from "../runtime.ts";
import { decideCacheMode, type CacheMode } from "./cache-mode.ts";
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
	type MergeRequest,
} from "./protocol.ts";
import { BTW_HELP, parseBtwCommand } from "./router.ts";
import { BTW_LAUNCH_DRAFT_ARG, type BtwPayload } from "./types.ts";

export type ChildStorePort = Pick<
	BtwContextStore,
	| "read"
	| "readMergeRequest"
	| "readMergeAck"
	| "createMergeRequest"
	| "removeIfNoPendingMerge"
>;
export type ChildHerdrClient = Pick<HerdrClient, "focusAgent" | "closePane">;

export async function focusParentAndCloseChild(
	client: ChildHerdrClient,
	runtime: RuntimeSnapshot,
	payload: Pick<BtwPayload, "parentPaneId">,
): Promise<{ closed: boolean; closeError?: string }> {
	await client.focusAgent(payload.parentPaneId).catch(() => undefined);
	if (!runtime.paneId || runtime.paneId === payload.parentPaneId) return { closed: false };
	try {
		await client.closePane(runtime.paneId);
		return { closed: true };
	} catch (error) {
		return { closed: false, closeError: error instanceof Error ? error.message : String(error) };
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
	let lastRejectedRequestId: string | undefined;

	function stopAckPolling(): void {
		if (ackTimer) clearInterval(ackTimer);
		ackTimer = undefined;
	}

	async function acceptAndClose(acceptedPayload: BtwPayload): Promise<void> {
		if (closing) return;
		closing = true;
		stopAckPolling();
		sessionUi?.notify("BTW merge accepted; returning focus to the parent.", "info");
		const returned = await focusParentAndCloseChild(client, runtime, acceptedPayload);
		if (returned.closed) return;
		if (returned.closeError) {
			sessionUi?.notify(`Merge succeeded, but the side pane could not close: ${returned.closeError}`, "warning");
		}
		closing = false;
	}

	async function pollAck(): Promise<void> {
		if (!payload || closing) return;
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
		if (ackTimer) return;
		ackTimer = setInterval(() => void pollAck(), ACK_POLL_INTERVAL_MS);
		ackTimer.unref?.();
		void pollAck();
	}

	pi.on("before_agent_start", (event, ctx) => {
		if (!payload) return;
		cacheMode = decideCacheMode(payload, {
			model: ctx.model ? `${ctx.model.provider}/${ctx.model.id}` : undefined,
			activeTools: pi.getActiveTools(),
			thinkingLevel: pi.getThinkingLevel(),
		});
		if (cacheMode.mode === "native") return { systemPrompt: payload.parentSystemPrompt as string };
		return {
			systemPrompt: `${event.systemPrompt}\n\n${SIDE_PANE_INSTRUCTIONS}\n\nPrompt-cache fallback: ${cacheMode.reason}.`,
		};
	});

	pi.on("context", (event) => {
		if (!payload) return;
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
				ctx.ui.notify("BTW merge is pending; this pane will close after the parent durably accepts it.", "info");
				startAckPolling();
			} catch (error) {
				ctx.ui.notify(`/btw merge failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	pi.on("session_start", (event, ctx) => {
		if (ctx.mode !== "tui") return;
		sessionUi = ctx.ui;
		ctx.ui.setTitle("pi /btw — Herdr side thread");
		if (!payload) {
			ctx.ui.setWidget("herdr-companion-btw", [
				ctx.ui.theme.fg("error", "BTW payload unavailable; prompts are blocked."),
				ctx.ui.theme.fg("dim", payloadError ?? "unknown payload error"),
			]);
			return;
		}
		ctx.ui.setWidget("herdr-companion-btw", [
			ctx.ui.theme.fg("accent", `BTW side thread · tools ${payload.config.tools}`),
			ctx.ui.theme.fg("dim", "Shared cwd; explicit /btw merge required"),
		]);
		if (event.reason === "startup" && payload.draftQuestion.trim() && !payload.config.autoSubmit) {
			ctx.ui.setEditorText(payload.draftQuestion);
		}
		startAckPolling();
	});

	pi.on("session_shutdown", async (event) => {
		stopAckPolling();
		sessionUi = undefined;
		if (event.reason === "quit") await store.removeIfNoPendingMerge(payloadPath).catch(() => undefined);
	});
}
