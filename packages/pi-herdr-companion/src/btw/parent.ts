import {
	buildSessionContext,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	BTW_TOOL_MODES,
	THINKING_LEVELS,
	isModelName,
	parseCompanionConfig,
	type CompanionConfig,
	type ThinkingLevel,
} from "../config.ts";
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

export interface BtwConfigController {
	path: string;
	get(): CompanionConfig;
	save(config: CompanionConfig): Promise<CompanionConfig>;
	reset(): Promise<CompanionConfig>;
}

export type ParentBtwStore = Pick<
	BtwContextStore,
	| "create"
	| "remove"
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

export function formatBtwConfig(config: CompanionConfig): string {
	return [
		`auto-submit: ${config.btw.autoSubmit ? "on" : "off"}`,
		`model: ${config.btw.model}`,
		`thinking: ${config.btw.thinking}`,
		`tools: ${config.btw.tools}`,
		`split: ${config.btw.split}`,
	].join(" · ");
}

export const BTW_CONFIG_USAGE = "/btw config [auto-submit on|off | model inherit|provider/model | thinking inherit|off|minimal|low|medium|high|xhigh|max | tools inherit|all|read-only|none | split down|right | reset]";

export function applyBtwConfigCommand(current: CompanionConfig, input: string): { action: "show" | "save"; config: CompanionConfig } {
	const trimmed = input.trim();
	if (!trimmed || trimmed === "show") return { action: "show", config: current };
	const [key, value, ...extra] = trimmed.split(/\s+/);
	if (!key || !value || extra.length > 0) throw new Error(BTW_CONFIG_USAGE);
	const next = parseCompanionConfig(JSON.parse(JSON.stringify(current)) as unknown);
	switch (key) {
		case "auto-submit":
			if (value !== "on" && value !== "off") throw new Error(BTW_CONFIG_USAGE);
			next.btw.autoSubmit = value === "on";
			break;
		case "model":
			if (value !== "inherit" && !isModelName(value)) throw new Error(BTW_CONFIG_USAGE);
			next.btw.model = value;
			break;
		case "thinking":
			if (value !== "inherit" && !THINKING_LEVELS.includes(value as ThinkingLevel)) throw new Error(BTW_CONFIG_USAGE);
			next.btw.thinking = value as "inherit" | ThinkingLevel;
			break;
		case "tools":
			if (!BTW_TOOL_MODES.includes(value as CompanionConfig["btw"]["tools"])) throw new Error(BTW_CONFIG_USAGE);
			next.btw.tools = value as CompanionConfig["btw"]["tools"];
			break;
		case "split":
			if (value !== "down" && value !== "right") throw new Error(BTW_CONFIG_USAGE);
			next.btw.split = value;
			break;
		default:
			throw new Error(BTW_CONFIG_USAGE);
	}
	return { action: "save", config: next };
}

export function registerBtwParent(
	pi: ExtensionAPI,
	options: {
		runtime: RuntimeSnapshot;
		store: ParentBtwStore;
		launcher: BtwLauncher;
		config: BtwConfigController;
	},
): void {
	const { runtime, store, launcher, config } = options;
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

	pi.on("session_start", async (_event, ctx) => {
		sessionCtx = ctx;
		notify = (message, type) => ctx.ui.notify(message, type);
		ensurePolling();
		await cleanupStale();
		await coordinator.scan();
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
			if (route.kind === "config") {
				try {
					if (route.args.trim() === "reset") {
						const reset = await config.reset();
						ctx.ui.notify(`BTW config — ${formatBtwConfig(reset)}\n${config.path}`, "info");
						return;
					}
					const result = applyBtwConfigCommand(config.get(), route.args);
					const resolved = result.action === "save" ? await config.save(result.config) : result.config;
					ctx.ui.notify(
						`BTW config — ${formatBtwConfig(resolved)}\n${config.path}${result.action === "show" ? `\n${BTW_CONFIG_USAGE}` : ""}`,
						"info",
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
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

			let payloadPath: string | undefined;
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
					config: { ...config.get().btw },
				});
				payloadPath = await store.create(payload);
				await launcher.launch({ payload, payloadPath, runtime });
				ensurePolling();
			} catch (error) {
				if (payloadPath) await store.remove(payloadPath).catch(() => undefined);
				ctx.ui.notify(`/btw launch failed: ${error instanceof Error ? error.message : String(error)}`, "error");
			}
		},
	});
}
