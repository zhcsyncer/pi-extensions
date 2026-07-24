import { strict as assert } from "node:assert";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../config.js";
import { createGlanceRuntime, type CreateGitRefresherOptions, type GlancePaneResult, type GlanceRuntimeAdapters, type RuntimeGitRefresher, type RuntimeShowPaneOptions } from "../runtime.js";
import type { StateSessionEntry } from "../runtime-snapshot.js";
import type { GitSnapshot, GlanceConfig, GlanceState } from "../types.js";

export type RuntimeMode = "tui" | "rpc" | "json" | "print";

export interface RuntimeNotification {
	message: string;
	type: "info" | "warning" | "error" | undefined;
}

export type RuntimeCapturedFooterFactory = (tui: { requestRender(): void }, theme: unknown, footerData: unknown) => unknown;
export type RuntimeCapturedEditorFactory = (tui: { terminal: { rows: number }; requestRender(): void }, theme: unknown, keybindings: unknown) => unknown;

export interface RuntimeMutableModelInfo {
	id?: string;
	provider?: string;
	contextWindow?: number;
	reasoning?: boolean;
}

export interface RuntimeMutableContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface RuntimeTestContextOptions {
	cwd?: string;
	mode?: RuntimeMode;
	hasUI?: boolean;
	availableProviders?: string[];
	model?: RuntimeMutableModelInfo;
	contextUsage?: RuntimeMutableContextUsage;
	entries?: StateSessionEntry[];
	branch?: StateSessionEntry[];
	sessionName?: string;
	usingOAuth?: boolean;
	invokeFooterFactory?: boolean;
	uiTheme?: unknown;
}

export interface RuntimeTestContext {
	ctx: ExtensionCommandContext;
	surfaceCalls: string[];
	notifications: RuntimeNotification[];
	footerFactories: RuntimeCapturedFooterFactory[];
	editorFactories: RuntimeCapturedEditorFactory[];
	getRenderRequests(): number;
	getThemeReads(): number;
	getEntryReads(): number;
	getBranchReads(): number;
	setCwd(cwd: string): void;
	setAvailableProviders(providers: string[]): void;
	setModel(model: RuntimeMutableModelInfo | undefined): void;
	setContextUsage(usage: RuntimeMutableContextUsage | undefined): void;
	setSessionEntries(entries: StateSessionEntry[]): void;
	setSessionBranch(branch: StateSessionEntry[]): void;
	setSessionName(name: string | undefined): void;
	setUiTheme(theme: unknown): void;
}

export interface RuntimeGitHarness {
	create: (options: CreateGitRefresherOptions) => RuntimeGitRefresher;
	created: number;
	schedules: Array<boolean | undefined>;
	disposeCount: number;
	options?: CreateGitRefresherOptions;
}

export interface RuntimeHarnessOptions {
	loadConfigSyncConfig?: GlanceConfig;
	loadConfigConfig?: GlanceConfig;
	showPaneResults?: GlancePaneResult[];
	onSaveConfig?: (config: GlanceConfig) => void | Promise<void>;
	saveConfigError?: Error;
	git?: RuntimeGitHarness;
	getThinkingLevel?: () => string;
	getAutoCompactionEnabled?: () => boolean;
}

export interface RuntimeHarness {
	runtime: ReturnType<typeof createGlanceRuntime>;
	showPaneInitials: GlanceConfig[];
	showPaneContexts: ExtensionCommandContext[];
	showPanePreviewStates: Array<GlanceState | undefined>;
	showPaneOptions: Array<RuntimeShowPaneOptions | undefined>;
	savedConfigs: GlanceConfig[];
	getLoadConfigCalls(): number;
}

export function cloneConfig(config: GlanceConfig = defaultConfig()): GlanceConfig {
	return JSON.parse(JSON.stringify(config)) as GlanceConfig;
}

export function disabledConfig(config = defaultConfig()): GlanceConfig {
	const next = cloneConfig(config);
	next.enabled = false;
	return next;
}

export function nextEnabledConfig(config = defaultConfig()): GlanceConfig {
	const next = cloneConfig(config);
	next.enabled = true;
	next.git.pollIntervalMs = config.git.pollIntervalMs + 1234;
	return next;
}

export function runtimeGitSnapshot(branch = "main"): GitSnapshot {
	return {
		repo: true,
		branch,
		detached: false,
		sha: "abcdef1",
		upstream: null,
		ahead: 0,
		behind: 0,
		staged: 0,
		unstaged: 1,
		untracked: 0,
		conflicts: 0,
		dirty: true,
		status: "dirty",
		updatedAt: 1000,
	};
}

export function assistantMessage(options: { responseId?: string; usage?: Record<string, unknown>; stopReason?: string; timestamp?: number } = {}) {
	return {
		role: "assistant",
		responseId: options.responseId,
		usage: options.usage,
		stopReason: options.stopReason ?? "stop",
		timestamp: options.timestamp ?? 1000,
	};
}

export function sessionMessage(role: string, options: { usage?: Record<string, unknown>; stopReason?: string; responseId?: string } = {}): StateSessionEntry {
	return {
		type: "message",
		message: {
			role,
			usage: options.usage,
			stopReason: options.stopReason,
			responseId: options.responseId,
		} as StateSessionEntry["message"] & { responseId?: string },
	};
}

export function fakePiTheme(name = "runtime-current-pi-theme") {
	return {
		name,
		getColorMode: () => "test-mode",
		fg: (_color: string, text: string) => `<<pi-theme:${text}>>`,
	};
}

export function hasNotification(notifications: RuntimeNotification[], message: string, type: RuntimeNotification["type"]): boolean {
	return notifications.some((notification) => notification.message === message && notification.type === type);
}

export function isPromiseLike(value: unknown): value is PromiseLike<unknown> {
	return typeof value === "object" && value !== null && typeof (value as { then?: unknown }).then === "function";
}

export function createGitHarness(): RuntimeGitHarness {
	const harness: RuntimeGitHarness = {
		created: 0,
		schedules: [],
		disposeCount: 0,
		create: (options) => {
			harness.created++;
			harness.options = options;
			return {
				schedule: (immediate?: boolean) => harness.schedules.push(immediate),
				dispose: () => {
					harness.disposeCount++;
				},
			};
		},
	};
	return harness;
}

export function createRuntimeTestContext(options: RuntimeTestContextOptions = {}): RuntimeTestContext {
	const surfaceCalls: string[] = [];
	const notifications: RuntimeNotification[] = [];
	const footerFactories: RuntimeCapturedFooterFactory[] = [];
	const editorFactories: RuntimeCapturedEditorFactory[] = [];
	let renderRequests = 0;
	let themeReads = 0;
	let entryReads = 0;
	let branchReads = 0;
	let cwd = options.cwd ?? "/repo";
	let availableProviders = options.availableProviders ?? ["test-provider"];
	let model: RuntimeMutableModelInfo | undefined = options.model ?? { id: "test-model", provider: "test-provider", contextWindow: 200_000 };
	let contextUsage: RuntimeMutableContextUsage | undefined = options.contextUsage ?? { tokens: 42, contextWindow: 200_000, percent: 0.021 };
	let entries: StateSessionEntry[] = options.entries ?? [];
	let branch: StateSessionEntry[] = options.branch ?? [];
	let sessionName = options.sessionName;
	let uiTheme = options.uiTheme;
	const mode = options.mode ?? "tui";
	const hasUI = options.hasUI ?? (mode === "tui" || mode === "rpc");
	const invokeFooterFactory = options.invokeFooterFactory ?? true;
	const fakeTui = { requestRender: () => renderRequests++ };
	const fakeTheme = {};
	const fakeFooterData = {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => availableProviders.length,
		onBranchChange: () => () => {},
	};

	const ctx = {
		mode,
		hasUI,
		get cwd() {
			return cwd;
		},
		get model() {
			return model;
		},
		modelRegistry: {
			getAvailable: () => availableProviders.map((provider) => ({ provider, id: `${provider}-model` })),
			isUsingOAuth: () => options.usingOAuth ?? false,
		},
		sessionManager: {
			getCwd: () => cwd,
			getSessionName: () => sessionName,
			getEntries: () => {
				entryReads++;
				return entries;
			},
			getBranch: () => {
				branchReads++;
				return branch;
			},
		},
		ui: {
			get theme() {
				themeReads++;
				return uiTheme;
			},
			notify: (message: string, type?: "info" | "warning" | "error") => notifications.push({ message, type }),
			setFooter: (factory: unknown) => {
				surfaceCalls.push(factory ? "setFooter:install" : "setFooter:clear");
				if (factory) {
					footerFactories.push(factory as RuntimeCapturedFooterFactory);
					if (invokeFooterFactory) (factory as RuntimeCapturedFooterFactory)(fakeTui, fakeTheme, fakeFooterData);
				}
			},
			setEditorComponent: (factory: unknown) => {
				surfaceCalls.push(factory ? "setEditorComponent:install" : "setEditorComponent:clear");
				if (factory) editorFactories.push(factory as RuntimeCapturedEditorFactory);
			},
		},
		getContextUsage: () => contextUsage,
	} as unknown as ExtensionCommandContext;

	return {
		ctx,
		surfaceCalls,
		notifications,
		footerFactories,
		editorFactories,
		getRenderRequests: () => renderRequests,
		getThemeReads: () => themeReads,
		getEntryReads: () => entryReads,
		getBranchReads: () => branchReads,
		setCwd: (nextCwd: string) => {
			cwd = nextCwd;
		},
		setAvailableProviders: (providers: string[]) => {
			availableProviders = providers;
		},
		setModel: (nextModel: RuntimeMutableModelInfo | undefined) => {
			model = nextModel;
		},
		setContextUsage: (usage: RuntimeMutableContextUsage | undefined) => {
			contextUsage = usage;
		},
		setSessionEntries: (nextEntries: StateSessionEntry[]) => {
			entries = nextEntries;
		},
		setSessionBranch: (nextBranch: StateSessionEntry[]) => {
			branch = nextBranch;
		},
		setSessionName: (nextName: string | undefined) => {
			sessionName = nextName;
		},
		setUiTheme: (theme: unknown) => {
			uiTheme = theme;
		},
	};
}

export function invokeFooterFactory(test: RuntimeTestContext, index: number, requestRender: () => void): unknown {
	const factory = test.footerFactories[index];
	assert.ok(factory, `expected footer factory ${index}`);
	return factory({ requestRender }, {}, {
		getGitBranch: () => null,
		getExtensionStatuses: () => new Map<string, string>(),
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	});
}

export function invokeEditorFactory(test: RuntimeTestContext, index: number, requestRender: () => void, keybindings: { matches(data: string, action: string): boolean } = { matches: () => false }): unknown {
	const factory = test.editorFactories[index];
	assert.ok(factory, `expected editor factory ${index}`);
	const editorTheme = {
		borderColor: (text: string) => text,
		selectList: {
			selectedPrefix: (text: string) => text,
			selectedText: (text: string) => text,
			description: (text: string) => text,
			scrollInfo: (text: string) => text,
			noMatch: (text: string) => text,
		},
	};
	return factory({ terminal: { rows: 40 }, requestRender }, editorTheme, keybindings);
}

export function createRuntimeHarness(options: RuntimeHarnessOptions = {}): RuntimeHarness {
	const showPaneInitials: GlanceConfig[] = [];
	const showPaneContexts: ExtensionCommandContext[] = [];
	const showPanePreviewStates: Array<GlanceState | undefined> = [];
	const showPaneOptions: Array<RuntimeShowPaneOptions | undefined> = [];
	const savedConfigs: GlanceConfig[] = [];
	let loadConfigCalls = 0;
	const loadConfigSyncConfig = options.loadConfigSyncConfig ?? defaultConfig();
	const loadConfigConfig = options.loadConfigConfig ?? loadConfigSyncConfig;
	const showPaneResults = [...(options.showPaneResults ?? [])];
	const adapters: GlanceRuntimeAdapters = {
		getThinkingLevel: options.getThinkingLevel ?? (() => "off"),
		getAutoCompactionEnabled: options.getAutoCompactionEnabled ?? (() => true),
		loadConfigSync: () => loadConfigSyncConfig,
		loadConfig: async () => {
			loadConfigCalls++;
			return loadConfigConfig;
		},
		saveConfig: async (config) => {
			await options.onSaveConfig?.(config);
			if (options.saveConfigError) throw options.saveConfigError;
			savedConfigs.push(config);
		},
		showPane: async (initial, ctx, previewState, paneOptions) => {
			showPaneInitials.push(cloneConfig(initial));
			showPaneContexts.push(ctx);
			showPanePreviewStates.push(previewState);
			showPaneOptions.push(paneOptions);
			const result = showPaneResults.shift();
			assert.ok(result, "expected queued showPane result");
			return result;
		},
		createGitRefresher: options.git?.create,
	};
	return {
		runtime: createGlanceRuntime(adapters),
		showPaneInitials,
		showPaneContexts,
		showPanePreviewStates,
		showPaneOptions,
		savedConfigs,
		getLoadConfigCalls: () => loadConfigCalls,
	};
}
