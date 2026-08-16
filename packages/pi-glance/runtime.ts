import { getAgentDir, SettingsManager, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { handleDiffCommand } from "./diff-review.js";
import { GlanceEditor } from "./editor.js";
import { StatusOnlyFooter } from "./footer.js";
import { GitRefresher, maybeFetchGitBaseRef, type GitBaseRefFetchReason } from "./git.js";
import { INPUT_STASH_PRIMARY_SHORTCUT, INPUT_STASH_SECONDARY_SHORTCUT } from "./input-stash.js";
import { createInputStashStore, type InputStashStore } from "./input-stash-store.js";
import { InputStashController } from "./input-stash-runtime.js";
import { readPiUiTheme, resolveRuntimeRenderStyleContext } from "./render-style-context.js";
import { RuntimeRefreshSession, type RuntimeAgentEndInput, type RuntimeMessageEndInput, type RuntimeTurnEndInput } from "./runtime-refresh-session.js";
import type { GlanceRenderStyleContext } from "./theme-adapter.js";
import { readPiAmbientTone } from "./theme-tone.js";
import type { GitSnapshot, GlanceConfig, GlanceState } from "./types.js";
import { WORKTREE_WIDGET_KEY } from "./worktree-summary.js";
import { createWorkingIndicatorController, type WorkingIndicatorControllerAdapters, type WorkingMessageUpdateEvent } from "./working-indicator.js";

export { INPUT_STASH_PRIMARY_SHORTCUT, INPUT_STASH_SECONDARY_SHORTCUT };

export type GlancePaneResult = { action: "save"; config: GlanceConfig } | { action: "cancel" };

export interface RuntimeGitRefresher {
	schedule(immediate?: boolean): void;
	dispose(): void;
}

export interface CreateGitRefresherOptions {
	getConfig(): GlanceConfig["git"];
	getCwd(): string | undefined;
	onSnapshot(cwd: string, snapshot: GitSnapshot): void;
}

export interface RuntimeShowPaneOptions {
	readonly renderStyleContext?: GlanceRenderStyleContext;
}

export interface GlanceRuntimeAdapters {
	getThinkingLevel(): string;
	getAutoCompactionEnabled?(ctx: ExtensionContext): boolean;
	loadConfigSync(): GlanceConfig;
	loadConfig(): Promise<GlanceConfig>;
	saveConfig(config: GlanceConfig): Promise<void>;
	consumeConfigNotices?(): string[];
	showPane(initial: GlanceConfig, ctx: ExtensionCommandContext, previewState?: GlanceState, options?: RuntimeShowPaneOptions): Promise<GlancePaneResult>;
	createGitRefresher?: (options: CreateGitRefresherOptions) => RuntimeGitRefresher;
	fetchGitBaseRef?(cwd: string, reason: GitBaseRefFetchReason): Promise<boolean>;
	nowMs?: () => number;
	createInputStashStore?: () => InputStashStore;
	workingIndicator?: Partial<Omit<WorkingIndicatorControllerAdapters, "getConfig" | "getThinkingLevel" | "getTerminalWidth">>;
	reviewWorkingTree?: (ctx: ExtensionCommandContext) => Promise<unknown>;
}

interface MessageEndLikeEvent {
	message: RuntimeMessageEndInput;
}

interface ToolExecutionLikeEvent {
	toolCallId?: unknown;
	toolName?: unknown;
}

type TurnEndLikeEvent = RuntimeTurnEndInput;
type AgentEndLikeEvent = RuntimeAgentEndInput;

interface RuntimeModeContext {
	mode?: string;
}

export interface GlanceRuntime {
	commands: {
		openPane(args: string, ctx: ExtensionCommandContext): Promise<void>;
		openDiff(args: string, ctx: ExtensionCommandContext): Promise<void>;
		refreshGit(): void;
	};
	shortcuts: {
		stashOrRestore(ctx: ExtensionContext): void;
		discard(ctx: ExtensionContext): void;
	};
	events: {
		sessionStart(event: unknown, ctx: ExtensionContext): void;
		sessionShutdown(event: unknown, ctx: ExtensionContext): Promise<void>;
		sessionInfoChanged(event: unknown, ctx: ExtensionContext): Promise<void>;
		modelSelect(event: unknown, ctx: ExtensionContext): Promise<void>;
		thinkingLevelSelect(event: unknown, ctx: ExtensionContext): Promise<void>;
		turnStart(event: unknown, ctx: ExtensionContext): Promise<void>;
		messageUpdate(event: WorkingMessageUpdateEvent, ctx: ExtensionContext): void;
		toolExecutionStart(event: ToolExecutionLikeEvent, ctx: ExtensionContext): void;
		toolExecutionEnd(event: ToolExecutionLikeEvent, ctx: ExtensionContext): Promise<void>;
		sessionTree(event: unknown, ctx: ExtensionContext): Promise<void>;
		sessionCompact(event: unknown, ctx: ExtensionContext): Promise<void>;
		messageEnd(event: MessageEndLikeEvent, ctx: ExtensionContext): Promise<void>;
		turnEnd(event: TurnEndLikeEvent, ctx: ExtensionContext): Promise<void>;
		agentStart(event: unknown, ctx: ExtensionContext): void;
		agentEnd(event: AgentEndLikeEvent, ctx: ExtensionContext): Promise<void>;
		agentSettled(event: unknown, ctx: ExtensionContext): void;
	};
}

function createDefaultGitRefresher(options: CreateGitRefresherOptions): RuntimeGitRefresher {
	return new GitRefresher(options.getConfig, options.getCwd, options.onSnapshot);
}

function isTuiMode(ctx: ExtensionContext): boolean {
	return (ctx as ExtensionContext & RuntimeModeContext).mode === "tui";
}

function readAutoCompactionEnabled(ctx: ExtensionContext): boolean {
	try {
		const cwd = ctx.sessionManager.getCwd() || ctx.cwd;
		return SettingsManager.create(cwd, getAgentDir(), { projectTrusted: ctx.isProjectTrusted() }).getCompactionEnabled();
	} catch {
		return true;
	}
}

export function createGlanceRuntime(adapters: GlanceRuntimeAdapters): GlanceRuntime {
	let config: GlanceConfig | undefined;
	let footer: StatusOnlyFooter | undefined;
	let gitRefresher: RuntimeGitRefresher | undefined;
	let requestRender: (() => void) | undefined;
	let readTerminalWidth = () => 80;
	let uiGeneration = 0;
	const nowMs = adapters.nowMs ?? Date.now;
	const inputStash = new InputStashController(adapters.createInputStashStore?.() ?? createInputStashStore(), {
		nowMs: () => nowMs(),
		requestRender: () => renderNow(),
	});
	const workingIndicator = createWorkingIndicatorController({
		getConfig,
		getThinkingLevel: () => adapters.getThinkingLevel(),
		getTerminalWidth: () => readTerminalWidth(),
		...adapters.workingIndicator,
	});

	async function ensureConfig(): Promise<GlanceConfig> {
		config ??= await adapters.loadConfig();
		return config;
	}

	function getConfig(): GlanceConfig {
		if (!config) throw new Error("pi-glance config not loaded");
		return config;
	}

	function renderNow(): void {
		footer?.invalidate();
		requestRender?.();
	}

	function isCurrentUiGeneration(generation: number): boolean {
		return generation === uiGeneration;
	}

	function setUiRequestRender(generation: number, callback: () => void): void {
		if (!isCurrentUiGeneration(generation)) return;
		requestRender = () => {
			if (isCurrentUiGeneration(generation)) callback();
		};
	}

	const refreshSession = new RuntimeRefreshSession({
		getConfig,
		ensureConfig,
		getThinkingLevel: () => adapters.getThinkingLevel(),
		getAutoCompactionEnabled: (ctx) => (adapters.getAutoCompactionEnabled ?? readAutoCompactionEnabled)(ctx),
		nowMs: () => nowMs(),
		requestRender: renderNow,
		scheduleGitRefresh,
	});

	function ensureGitRefresher(): RuntimeGitRefresher {
		gitRefresher ??= (adapters.createGitRefresher ?? createDefaultGitRefresher)({
			getConfig: () => getConfig().git,
			getCwd: () => refreshSession.getState()?.workspace.path,
			onSnapshot: (cwd, snapshot) => {
				refreshSession.applyGitSnapshot(cwd, snapshot);
				if (snapshot.repo) requestBaseRefFetch("stale");
			},
		});
		return gitRefresher;
	}

	function scheduleGitRefresh(immediate = false): void {
		gitRefresher?.schedule(immediate);
	}

	function requestBaseRefFetch(reason: GitBaseRefFetchReason): void {
		if (!getConfig().git.showBaseBehind) return;
		const cwd = refreshSession.getState()?.workspace.path;
		if (!cwd) return;
		const fetchBase = adapters.fetchGitBaseRef ?? maybeFetchGitBaseRef;
		void fetchBase(cwd, reason).then((fetched) => {
			if (fetched) scheduleGitRefresh(true);
		});
	}

	function clearFooter(): void {
		footer?.dispose();
		footer = undefined;
	}

	function invalidateUiOwnership(): number {
		uiGeneration++;
		requestRender = undefined;
		clearFooter();
		return uiGeneration;
	}

	function clearGitRefresher(): void {
		gitRefresher?.dispose();
		gitRefresher = undefined;
	}

	function clearUI(ctx: ExtensionContext): void {
		if (!isTuiMode(ctx)) return;
		workingIndicator.apply(ctx);
		invalidateUiOwnership();
		clearGitRefresher();
		ctx.ui.setWidget(WORKTREE_WIDGET_KEY, undefined);
		ctx.ui.setEditorComponent(undefined);
		ctx.ui.setFooter(undefined);
	}

	function installInputSurface(ctx: ExtensionContext): void {
		if (!isTuiMode(ctx)) return;
		refreshSession.ensureState(ctx);
		const activeConfig = getConfig();
		if (!activeConfig.enabled) {
			clearUI(ctx);
			return;
		}

		const renderStyleContext = resolveRuntimeRenderStyleContext(activeConfig, {
			getPiTheme: () => readPiUiTheme(ctx.ui),
			getAmbientTone: () => readPiAmbientTone(ctx.ui),
		});
		workingIndicator.apply(ctx, renderStyleContext);
		const generation = invalidateUiOwnership();

		ensureGitRefresher().schedule(true);
		requestBaseRefFetch("session");
		// Clear any legacy keyed Working Tree widget from earlier builds so it cannot
		// stack above todo/plan/recap widgets after the summary moved into the editor surface.
		ctx.ui.setWidget(WORKTREE_WIDGET_KEY, undefined);
		ctx.ui.setFooter((tui, theme, footerData) => {
			readTerminalWidth = () => tui.terminal.columns;
			const nextFooter = new StatusOnlyFooter({ theme, footerData });
			if (isCurrentUiGeneration(generation)) {
				setUiRequestRender(generation, () => tui.requestRender());
				footer = nextFooter;
			}
			return nextFooter;
		});

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
			readTerminalWidth = () => tui.terminal.columns;
			setUiRequestRender(generation, () => tui.requestRender());
			return new GlanceEditor(
				tui,
				theme,
				keybindings,
				() => refreshSession.getState() ?? refreshSession.ensureState(ctx),
				() => getConfig(),
				() => {
					void refreshSession.execute("editor_thinking_cycle", ctx);
				},
				{
					onForeground: () => requestBaseRefFetch("focus"),
					getStashOccupied: () => inputStash.occupied(ctx),
					...(renderStyleContext ? { renderStyleContext } : {}),
				},
			);
		});
	}

	return {
		commands: {
			refreshGit: () => scheduleGitRefresh(true),
			openDiff: async (_args, ctx) => {
				try {
					await (adapters.reviewWorkingTree ?? handleDiffCommand)(ctx);
				} finally {
					scheduleGitRefresh(true);
				}
			},
			openPane: async (_args, ctx) => {
				if (!isTuiMode(ctx)) {
					ctx.ui.notify("pi-glance configuration pane requires TUI mode", "error");
					return;
				}
				const current = await ensureConfig();
				refreshSession.ensureState(ctx);
				const renderStyleContext = resolveRuntimeRenderStyleContext(current, {
					getPiTheme: () => readPiUiTheme(ctx.ui),
					getAmbientTone: () => readPiAmbientTone(ctx.ui),
				});
				const result = await adapters.showPane(current, ctx, refreshSession.getState(), renderStyleContext ? { renderStyleContext } : undefined);
				if (result.action === "cancel") {
					ctx.ui.notify("pi-glance configuration cancelled", "info");
					return;
				}

				const nextConfig = result.config;
				try {
					await adapters.saveConfig(nextConfig);
				} catch {
					ctx.ui.notify("pi-glance configuration save failed; keeping previous configuration", "error");
					return;
				}

				config = nextConfig;
				await refreshSession.execute("config_save_success", ctx, { beforeRender: () => installInputSurface(ctx) });
				ctx.ui.notify("pi-glance configuration saved", "info");
			},
		},
		shortcuts: {
			stashOrRestore: (ctx) => {
				if (!isTuiMode(ctx) || config?.enabled !== true) return;
				inputStash.handlePrimary(ctx);
			},
			discard: (ctx) => {
				if (!isTuiMode(ctx) || config?.enabled !== true) return;
				inputStash.handleSecondary(ctx);
			},
		},
		events: {
			sessionStart: (_event, ctx) => {
				config = adapters.loadConfigSync();
				for (const notice of adapters.consumeConfigNotices?.() ?? []) ctx.ui.notify?.(notice, "warning");
				refreshSession.sessionStart(ctx);
				installInputSurface(ctx);
				if (isTuiMode(ctx) && getConfig().enabled) inputStash.restoreOnSessionStart(ctx);
			},
			sessionShutdown: async (_event, ctx) => {
				workingIndicator.shutdown();
				refreshSession.sessionShutdown();
				clearUI(ctx);
			},
			sessionInfoChanged: async (_event, ctx) => {
				await refreshSession.execute("session_info_changed", ctx);
			},
			modelSelect: async (_event, ctx) => {
				await refreshSession.execute("model_select", ctx);
			},
			thinkingLevelSelect: async (_event, ctx) => {
				workingIndicator.thinkingLevelChanged();
				await refreshSession.execute("thinking_level_select", ctx);
			},
			turnStart: async (_event, ctx) => {
				workingIndicator.turnStart();
				await refreshSession.execute("turn_start", ctx);
			},
			messageUpdate: (event, _ctx) => {
				workingIndicator.messageUpdate(event);
			},
			toolExecutionStart: (event, _ctx) => {
				if (typeof event.toolCallId === "string" && typeof event.toolName === "string") {
					workingIndicator.toolExecutionStart({ toolCallId: event.toolCallId, toolName: event.toolName });
				}
			},
			toolExecutionEnd: async (event, ctx) => {
				if (typeof event.toolCallId === "string") workingIndicator.toolExecutionEnd({ toolCallId: event.toolCallId });
				await refreshSession.execute("tool_execution_end", ctx, {
					facts: { toolName: typeof event.toolName === "string" ? event.toolName : undefined },
				});
			},
			sessionTree: async (_event, ctx) => {
				await refreshSession.execute("session_tree", ctx);
			},
			sessionCompact: async (_event, ctx) => {
				await refreshSession.execute("session_compact", ctx);
			},
			messageEnd: async (event, ctx) => {
				workingIndicator.messageEnd(event);
				await refreshSession.messageEnd(event.message, ctx);
			},
			turnEnd: async (event, ctx) => {
				await refreshSession.turnEnd(event, ctx);
			},
			agentStart: (_event, ctx) => {
				workingIndicator.agentStart(ctx);
				refreshSession.agentStart();
			},
			agentEnd: async (event, ctx) => {
				await refreshSession.agentEnd(event, ctx);
			},
			agentSettled: (_event, _ctx) => {
				workingIndicator.agentSettled();
				scheduleGitRefresh(true);
			},
		},
	};
}
