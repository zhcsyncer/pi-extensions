import { getAgentDir, SettingsManager, type ExtensionCommandContext, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { GlanceEditor } from "./editor.js";
import { StatusOnlyFooter } from "./footer.js";
import { GitRefresher } from "./git.js";
import { resolveRuntimeRenderStyleContext } from "./render-style-context.js";
import { RuntimeRefreshSession, type RuntimeAgentEndInput, type RuntimeMessageEndInput, type RuntimeTurnEndInput } from "./runtime-refresh-session.js";
import type { GlanceRenderStyleContext } from "./theme-adapter.js";
import { readPiAmbientTone } from "./theme-tone.js";
import type { GitSnapshot, GlanceConfig, GlanceState } from "./types.js";

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
	showPane(initial: GlanceConfig, ctx: ExtensionCommandContext, previewState?: GlanceState, options?: RuntimeShowPaneOptions): Promise<GlancePaneResult>;
	createGitRefresher?: (options: CreateGitRefresherOptions) => RuntimeGitRefresher;
	nowMs?: () => number;
}

interface MessageEndLikeEvent {
	message: RuntimeMessageEndInput;
}

type TurnEndLikeEvent = RuntimeTurnEndInput;
type AgentEndLikeEvent = RuntimeAgentEndInput;

interface RuntimeModeContext {
	mode?: string;
}

export interface GlanceRuntime {
	commands: {
		openPane(args: string, ctx: ExtensionCommandContext): Promise<void>;
	};
	events: {
		sessionStart(event: unknown, ctx: ExtensionContext): void;
		sessionShutdown(event: unknown, ctx: ExtensionContext): Promise<void>;
		sessionInfoChanged(event: unknown, ctx: ExtensionContext): Promise<void>;
		modelSelect(event: unknown, ctx: ExtensionContext): Promise<void>;
		thinkingLevelSelect(event: unknown, ctx: ExtensionContext): Promise<void>;
		turnStart(event: unknown, ctx: ExtensionContext): Promise<void>;
		toolExecutionEnd(event: unknown, ctx: ExtensionContext): Promise<void>;
		sessionTree(event: unknown, ctx: ExtensionContext): Promise<void>;
		sessionCompact(event: unknown, ctx: ExtensionContext): Promise<void>;
		messageEnd(event: MessageEndLikeEvent, ctx: ExtensionContext): Promise<void>;
		turnEnd(event: TurnEndLikeEvent, ctx: ExtensionContext): Promise<void>;
		agentStart(event: unknown, ctx: ExtensionContext): void;
		agentEnd(event: AgentEndLikeEvent, ctx: ExtensionContext): Promise<void>;
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
	let uiGeneration = 0;
	const nowMs = adapters.nowMs ?? Date.now;

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
			},
		});
		return gitRefresher;
	}

	function scheduleGitRefresh(immediate = false): void {
		gitRefresher?.schedule(immediate);
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
		invalidateUiOwnership();
		clearGitRefresher();
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
			getAmbientTone: () => readPiAmbientTone(ctx.ui),
		});
		const generation = invalidateUiOwnership();

		ensureGitRefresher().schedule(true);
		ctx.ui.setFooter((tui, theme, footerData) => {
			const nextFooter = new StatusOnlyFooter({ theme, footerData });
			if (isCurrentUiGeneration(generation)) {
				setUiRequestRender(generation, () => tui.requestRender());
				footer = nextFooter;
			}
			return nextFooter;
		});

		ctx.ui.setEditorComponent((tui, theme, keybindings) => {
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
				renderStyleContext ? { renderStyleContext } : undefined,
			);
		});
	}

	return {
		commands: {
			openPane: async (_args, ctx) => {
				if (!isTuiMode(ctx)) {
					ctx.ui.notify("pi-glance configuration pane requires TUI mode", "error");
					return;
				}
				const current = await ensureConfig();
				refreshSession.ensureState(ctx);
				const renderStyleContext = resolveRuntimeRenderStyleContext(current, {
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
		events: {
			sessionStart: (_event, ctx) => {
				config = adapters.loadConfigSync();
				refreshSession.sessionStart(ctx);
				installInputSurface(ctx);
			},
			sessionShutdown: async (_event, ctx) => {
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
				await refreshSession.execute("thinking_level_select", ctx);
			},
			turnStart: async (_event, ctx) => {
				await refreshSession.execute("turn_start", ctx);
			},
			toolExecutionEnd: async (_event, ctx) => {
				await refreshSession.execute("tool_execution_end", ctx);
			},
			sessionTree: async (_event, ctx) => {
				await refreshSession.execute("session_tree", ctx);
			},
			sessionCompact: async (_event, ctx) => {
				await refreshSession.execute("session_compact", ctx);
			},
			messageEnd: async (event, ctx) => {
				await refreshSession.messageEnd(event.message, ctx);
			},
			turnEnd: async (event, ctx) => {
				await refreshSession.turnEnd(event, ctx);
			},
			agentStart: (_event, _ctx) => {
				refreshSession.agentStart();
			},
			agentEnd: async (event, ctx) => {
				await refreshSession.agentEnd(event, ctx);
			},
		},
	};
}
