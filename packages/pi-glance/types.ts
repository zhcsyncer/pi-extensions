import type { GlanceThemeName } from "./themes.js";

export type { GlanceThemeName } from "./themes.js";

export interface GlanceThemePair {
	light: GlanceThemeName;
	dark: GlanceThemeName;
}

export type SegmentId = "git" | "model" | "context" | "tokens" | "cost" | "throughput";
export type ColorSource = "pi" | "glance";
export type IconMode = "nerd" | "plain";
export type WidthMode = "full" | "compact" | "minimal";
export type GitStatus = "clean" | "dirty" | "conflict" | "unknown";
export type GitShaMode = "off" | "detached" | "always";
export type WorktreeSummaryMode = "above-compact" | "above-detailed" | "border-left" | "border-right";
export type ContextTextMode = "percent+tokens" | "percent" | "tokens";
export type ContextProgressStyle = "track" | "border";
export type ContextProgressWidth = "third" | "remaining";
export type TokensDisplayMode = "input-output" | "total";
export type TokensCacheMode = "auto" | "show" | "hide";
export type ModelThinkingMode = "auto" | "always" | "never";
export type WorkspaceLabelMode = "name" | "smart" | "path";
export type EditorTopMarginRows = 0 | 1 | 2;
export type ThroughputPrecision = "auto" | 0 | 1;

export interface SegmentConfig {
	id: SegmentId;
	enabled: boolean;
}

interface DisplayConfig {
	showProvider: "auto" | "always" | "never";
	workspaceLabel: WorkspaceLabelMode;
}

interface EditorConfig {
	minContentRows: number;
	topMarginRows: EditorTopMarginRows;
}

export interface GitConfig {
	showDirty: boolean;
	showAheadBehind: boolean;
	shaMode: GitShaMode;
	worktreeSummary: WorktreeSummaryMode;
	timeoutMs: number;
	refreshDebounceMs: number;
	pollIntervalMs: number;
}

interface ContextConfig {
	/** Text details. Placement follows progress: top status when off, bottom label when on. */
	text: ContextTextMode;
	/** Bottom-right progress bar. When on, text moves next to the bar and always includes percent. */
	progress: boolean;
	progressStyle: ContextProgressStyle;
	progressWidth: ContextProgressWidth;
}

interface CostConfig {
	hideZero: boolean;
}

interface TokensConfig {
	display: TokensDisplayMode;
	cache: TokensCacheMode;
}

interface ThroughputConfig {
	precision: ThroughputPrecision;
}

interface BottomDetailsConfig {
	showAutoCompact: boolean;
}

export interface GlanceConfig {
	version: 14;
	enabled: boolean;
	workingIndicator: {
		enabled: boolean;
	};
	colorSource: ColorSource;
	theme: GlanceThemePair;
	icons: IconMode;
	editor: EditorConfig;
	display: DisplayConfig;
	segments: SegmentConfig[];
	model: {
		customNames: Record<string, string>;
		showThinking: ModelThinkingMode;
	};
	git: GitConfig;
	context: ContextConfig;
	cost: CostConfig;
	tokens: TokensConfig;
	throughput: ThroughputConfig;
	bottomDetails: BottomDetailsConfig;
}

export interface UsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	cost: number;
}

export interface TurnThroughputUsage {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
	totalTokens: number;
	assistantMessages: number;
}

export interface TurnThroughput {
	startedAtMs: number;
	endedAtMs: number;
	elapsedMs: number;
	tokensPerSecond: number;
	usage: TurnThroughputUsage;
}

export interface GitWorktreeSnapshot {
	/** Current paths with index changes. */
	staged: string[];
	/** Current paths with working-tree changes. */
	unstaged: string[];
	/** Untracked paths. File contents are never read for polling. */
	untracked: string[];
	/** Current paths with unresolved merge conflicts. */
	conflicts: string[];
	/** Unique current paths across all categories. */
	files: number;
	/** Tracked working tree versus HEAD; null when Git cannot calculate it safely. */
	additions: number | null;
	/** Tracked working tree versus HEAD; null when Git cannot calculate it safely. */
	deletions: number | null;
}

export interface GitSnapshot {
	repo: boolean;
	branch: string | null;
	detached: boolean;
	sha: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
	staged: number;
	unstaged: number;
	untracked: number;
	conflicts: number;
	dirty: boolean;
	status: GitStatus;
	worktree: GitWorktreeSnapshot;
	updatedAt: number;
}

export interface GlanceState {
	workspace: {
		name: string;
		path: string;
	};
	git: GitSnapshot;
	providers: {
		availableCount: number;
	};
	model: {
		id?: string;
		provider?: string;
		displayName?: string;
		thinking: string;
		reasoning?: boolean;
	};
	runtime: {
		autoCompactEnabled: boolean;
	};
	context: {
		tokens: number | null;
		window: number;
		percent: number | null;
	};
	usage: UsageTotals;
	throughput: {
		lastTurn: TurnThroughput | null;
		currentRun: TurnThroughput | null;
	};
	version: number;
}

export interface Rgb {
	r: number;
	g: number;
	b: number;
}

interface SegmentPalette {
	fg: Rgb;
}

export interface GlancePalette {
	text: Rgb;
	dim: Rgb;
	warn: Rgb;
	error: Rgb;
	separator: Rgb;
	border: Rgb;
	title: Rgb;
	segments: Record<SegmentId, SegmentPalette>;
}

export interface IconSet extends Record<SegmentId, string> {}

interface SegmentDisplay {
	full?: string;
	compact?: string;
	minimal?: string;
}

export interface SegmentData {
	primary: string;
	secondary?: string;
	display?: SegmentDisplay;
}

export interface SegmentRenderContext {
	state: GlanceState;
	config: GlanceConfig;
	widthMode: WidthMode;
	icons: IconSet;
	showProvider: boolean;
}

export interface SegmentRenderResult {
	id: SegmentId;
	text: string;
}

export interface SegmentDefinition {
	id: SegmentId;
	label: string;
	collect(ctx: SegmentRenderContext): SegmentData | undefined;
}
