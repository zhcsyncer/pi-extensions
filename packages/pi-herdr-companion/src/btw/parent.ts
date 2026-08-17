import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import type { SplitDirection } from "../config.ts";
import type { RuntimeSnapshot } from "../runtime.ts";
import { hasUsableHerdrRuntime } from "../runtime.ts";
import type { BtwContextStore } from "./context-store.ts";
import { fingerprintActiveToolSchemas, fingerprintSystemPrompt } from "./cache-mode.ts";
import { MergeCoordinator } from "./merge.ts";
import { MERGE_MESSAGE_CUSTOM_TYPE } from "./protocol.ts";
import { BTW_HELP, parseBtwCommand } from "./router.ts";
import { createBtwPayload } from "./types.ts";
import type { BtwLauncher } from "./launch.ts";

const MERGE_POLL_INTERVAL_MS = 2_000;

export interface BtwParentRegistration {
	/** Initialize the current TUI session when registration occurs during session_start. */
	startSession(ctx: ExtensionContext): Promise<void>;
}

export type ParentBtwStore = Pick<
	BtwContextStore,
	| "create"
	| "removeStale"
	| "listLaunchPayloadPaths"
	| "read"
	| "readMergeRequest"
	| "readMergeState"
	| "writeMergeState"
	| "readMergeAck"
	| "writeMergeAck"
	| "withDeliveryLock"
>;

export function registerBtwParent(
	pi: ExtensionAPI,
	options: {
		runtime: RuntimeSnapshot;
		store: ParentBtwStore;
		launcher: BtwLauncher;
		getDirection(): SplitDirection;
	},
): BtwParentRegistration {
	const { runtime, store, launcher, getDirection } = options;
	let activeSessionContext: ExtensionContext | undefined;
	let sessionCtx: Pick<ExtensionContext, "sessionManager" | "isIdle"> | undefined;
	let notify: ((message: string, type: "info" | "warning" | "error") => void) | undefined;
	let pollTimer: ReturnType<typeof setInterval> | undefined;

	const coordinator = new MergeCoordinator(store, {
		getSessionId: () => sessionCtx?.sessionManager.getSessionId() ?? "",
		isIdle: () => sessionCtx?.isIdle() ?? false,
		getEntries: () => sessionCtx?.sessionManager.getEntries() ?? [],
		dispatchMergeMessage: (content, details) => {
			pi.sendMessage(
				{ customType: MERGE_MESSAGE_CUSTOM_TYPE, content, display: true, details },
				{ triggerTurn: true, deliverAs: "followUp" },
			);
		},
		notify: (message, type) => notify?.(message, type),
	});

	function ensurePolling(): void {
		if (pollTimer) return;
		pollTimer = setInterval(() => void coordinator.scan(), MERGE_POLL_INTERVAL_MS);
		pollTimer.unref?.();
	}

	function stopPolling(): void {
		if (pollTimer) clearInterval(pollTimer);
		pollTimer = undefined;
	}

	async function cleanupStale(): Promise<void> {
		if (!hasUsableHerdrRuntime(runtime)) return;
		await store.removeStale({
			isPaneLive: (paneId, agentName) => launcher.isPaneLive(paneId, agentName),
		}).catch(() => undefined);
	}

	async function startSession(ctx: ExtensionContext): Promise<void> {
		if (activeSessionContext === ctx) return;
		activeSessionContext = ctx;
		sessionCtx = ctx;
		notify = (message, type) => ctx.ui.notify(message, type);
		ensurePolling();
		await cleanupStale();
		await coordinator.scan();
	}

	pi.on("session_start", async (_event, ctx) => {
		if (ctx.mode !== "tui") return;
		await startSession(ctx);
	});
	pi.on("agent_start", async () => {
		// A later event may now observe the asynchronously appended custom message.
		await coordinator.scan();
	});
	pi.on("agent_settled", async () => {
		await coordinator.scan();
	});
	pi.on("session_shutdown", () => {
		stopPolling();
		activeSessionContext = undefined;
		sessionCtx = undefined;
		notify = undefined;
	});

	pi.registerCommand("btw", {
		description: "[question] — Open a Herdr Pi side thread; configure, merge, or show help",
		handler: async (args, ctx) => {
			sessionCtx = ctx;
			notify = (message, type) => ctx.ui.notify(message, type);
			const route = parseBtwCommand(args);
			if (route.kind === "help") {
				ctx.ui.notify(BTW_HELP, "info");
				return;
			}
			if (route.kind === "merge") {
				const scan = await coordinator.scan();
				ctx.ui.notify(
					scan.delivered || scan.rejected || scan.deferred
						? `BTW merge scan — delivered ${scan.delivered}, rejected ${scan.rejected}, deferred ${scan.deferred}`
						: "BTW merge scan — no pending merge for this session.",
					"info",
				);
				return;
			}
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/btw launch requires Pi TUI mode.", "error");
				return;
			}
			if (!hasUsableHerdrRuntime(runtime)) {
				ctx.ui.notify("/btw launch is unavailable outside a Herdr-managed pane with caller identity.", "error");
				return;
			}
			if (!ctx.model) {
				ctx.ui.notify("/btw requires an active model.", "error");
				return;
			}
			const context = buildSessionContext(ctx.sessionManager.getEntries(), ctx.sessionManager.getLeafId());
			if (context.messages.length === 0) {
				ctx.ui.notify("There is no parent conversation to snapshot yet.", "warning");
				return;
			}

			try {
				await cleanupStale();
				const createdAt = new Date().toISOString();
				const model = `${ctx.model.provider}/${ctx.model.id}`;
				let systemPrompt: string | null = null;
				try {
					systemPrompt = ctx.getSystemPrompt();
				} catch {
					// Flattened mode remains portable when an exact prompt is unavailable.
				}
				const activeTools = pi.getActiveTools();
				const toolSchemaFingerprint = fingerprintActiveToolSchemas(activeTools, pi.getAllTools());
				const payload = createBtwPayload({
					createdAt,
					parentSessionId: ctx.sessionManager.getSessionId(),
					parentPaneId: runtime.paneId as string,
					metadata: {
						generatedAt: createdAt,
						cwd: ctx.cwd,
						session: ctx.sessionManager.getSessionFile() ?? "ephemeral",
						model,
					},
					parentSystemPrompt: systemPrompt,
					parentSystemPromptFingerprint: systemPrompt === null ? null : fingerprintSystemPrompt(systemPrompt),
					parentActiveTools: activeTools,
					parentToolSchemaFingerprint: toolSchemaFingerprint,
					parentThinkingLevel: pi.getThinkingLevel(),
					messages: context.messages,
					draftQuestion: route.kind === "ask" ? route.question : "",
				});
				const payloadPath = await store.create(payload);
				await launcher.launch({ payload, payloadPath, runtime, direction: getDirection() });
				ensurePolling();
			} catch (error) {
				ctx.ui.notify(`/btw launch failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});

	return { startSession };
}
