import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { defaultConfig } from "../config.js";
import type { StateSessionEntry } from "../runtime-snapshot.js";
import type { GitSnapshot, GlanceConfig } from "../types.js";

export interface MutableModelInfo {
	id?: string;
	provider?: string;
	contextWindow?: number;
}

export interface MutableContextUsage {
	tokens: number | null;
	contextWindow: number;
	percent: number | null;
}

export interface RuntimeRefreshContextOptions {
	cwd?: string;
	model?: MutableModelInfo;
	contextUsage?: MutableContextUsage;
	availableProviders?: readonly string[];
	entries?: readonly StateSessionEntry[];
	branch?: readonly StateSessionEntry[];
}

export interface RuntimeRefreshContextHarness {
	ctx: ExtensionContext;
	getEntryReads(): number;
	getBranchReads(): number;
	setCwd(cwd: string): void;
	setEntries(entries: readonly StateSessionEntry[]): void;
	setBranch(branch: readonly StateSessionEntry[]): void;
	setContextUsage(contextUsage: MutableContextUsage | undefined): void;
	setModel(model: MutableModelInfo | undefined): void;
	setAvailableProviders(providers: readonly string[]): void;
}

export function cloneConfig(config: GlanceConfig = defaultConfig()): GlanceConfig {
	return JSON.parse(JSON.stringify(config)) as GlanceConfig;
}

export function message(role: string, options: { usage?: Record<string, unknown>; stopReason?: string; responseId?: string } = {}): StateSessionEntry {
	const entryMessage: StateSessionEntry["message"] & { responseId?: string } = {
		role,
		usage: options.usage,
		stopReason: options.stopReason,
	};
	if (options.responseId !== undefined) entryMessage.responseId = options.responseId;
	return {
		type: "message",
		message: entryMessage,
	};
}

export function compaction(): StateSessionEntry {
	return { type: "compaction" };
}

export function gitSnapshot(branch?: string, updatedAt?: number): GitSnapshot;
export function gitSnapshot(overrides?: Partial<GitSnapshot>): GitSnapshot;
export function gitSnapshot(branchOrOverrides: string | Partial<GitSnapshot> = "main", updatedAt = 1000): GitSnapshot {
	const overrides = typeof branchOrOverrides === "string" ? { branch: branchOrOverrides, updatedAt } : branchOrOverrides;
	const branch = overrides.branch === undefined ? "main" : overrides.branch;
	const repo = overrides.repo ?? branch !== null;
	return {
		repo,
		branch,
		detached: false,
		sha: repo ? "abcdef1" : null,
		upstream: null,
		ahead: 0,
		behind: 0,
		staged: 0,
		unstaged: repo ? 1 : 0,
		untracked: 0,
		conflicts: 0,
		dirty: repo,
		status: repo ? "dirty" : "unknown",
		updatedAt: overrides.updatedAt ?? updatedAt,
		...overrides,
	};
}

export function createRuntimeRefreshContext(options: RuntimeRefreshContextOptions = {}): RuntimeRefreshContextHarness {
	let cwd = options.cwd ?? "/repo";
	let model: MutableModelInfo | undefined = options.model ?? { id: "test-model", provider: "test-provider", contextWindow: 200_000 };
	let contextUsage: MutableContextUsage | undefined = options.contextUsage ?? { tokens: 42_000, contextWindow: model.contextWindow ?? 200_000, percent: 21 };
	let availableProviders = options.availableProviders ?? [model.provider ?? "test-provider"];
	let entries = options.entries ?? [];
	let branch = options.branch ?? [];
	let entryReads = 0;
	let branchReads = 0;

	const ctx = {
		get cwd() {
			return cwd;
		},
		get model() {
			return model;
		},
		modelRegistry: {
			getAvailable: () => availableProviders.map((provider, index) => ({ provider, id: `${provider}-model-${index}` })),
		},
		getContextUsage: () => contextUsage,
		sessionManager: {
			getCwd: () => cwd,
			getEntries: () => {
				entryReads++;
				return entries;
			},
			getBranch: () => {
				branchReads++;
				return branch;
			},
		},
	} as unknown as ExtensionContext;

	return {
		ctx,
		getEntryReads: () => entryReads,
		getBranchReads: () => branchReads,
		setCwd: (nextCwd) => {
			cwd = nextCwd;
		},
		setEntries: (nextEntries) => {
			entries = nextEntries;
		},
		setBranch: (nextBranch) => {
			branch = nextBranch;
		},
		setContextUsage: (nextContextUsage) => {
			contextUsage = nextContextUsage;
		},
		setModel: (nextModel) => {
			model = nextModel;
		},
		setAvailableProviders: (nextProviders) => {
			availableProviders = nextProviders;
		},
	};
}
