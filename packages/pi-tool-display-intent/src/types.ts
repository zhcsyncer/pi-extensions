export const READ_OUTPUT_MODES = ["hidden", "summary", "preview"] as const;
export const SEARCH_OUTPUT_MODES = ["hidden", "count", "preview"] as const;
export const MCP_OUTPUT_MODES = ["hidden", "summary", "preview"] as const;
export const CUSTOM_TOOL_OVERRIDE_KINDS = ["generic", "mcp"] as const;
export const CUSTOM_TOOL_OUTPUT_MODES = ["hidden", "summary", "preview"] as const;
export const BASH_OUTPUT_MODES = ["summary", "preview"] as const;
export const RESULT_DISPLAY_MODES = ["compact", "summary", "preview"] as const;
export const DIFF_VIEW_MODES = ["auto", "split", "unified"] as const;
export const DIFF_INDICATOR_MODES = ["bars", "classic", "none"] as const;
export const TOOL_INTENT_LANGUAGES = ["auto", "zh-CN", "en"] as const;
export const TOOL_CALL_STYLES = ["compact", "claude"] as const;
export const TOOL_DISPLAY_CONFIG_VERSION = 2 as const;
export const TOOL_DISPLAY_CONFIG_SCHEMA_URL =
	"https://raw.githubusercontent.com/zhcsyncer/pi-extensions/main/packages/pi-tool-display-intent/config/config.schema.json";

export type ReadOutputMode = (typeof READ_OUTPUT_MODES)[number];
export type SearchOutputMode = (typeof SEARCH_OUTPUT_MODES)[number];
export type McpOutputMode = (typeof MCP_OUTPUT_MODES)[number];
export type CustomToolOverrideKind = (typeof CUSTOM_TOOL_OVERRIDE_KINDS)[number];
export type CustomToolOutputMode = (typeof CUSTOM_TOOL_OUTPUT_MODES)[number];
export type BashOutputMode = (typeof BASH_OUTPUT_MODES)[number];
export type ResultDisplayMode = (typeof RESULT_DISPLAY_MODES)[number];
export type DiffViewMode = (typeof DIFF_VIEW_MODES)[number];
export type DiffIndicatorMode = (typeof DIFF_INDICATOR_MODES)[number];
export type ToolIntentLanguage = (typeof TOOL_INTENT_LANGUAGES)[number];
export type ToolCallStyle = (typeof TOOL_CALL_STYLES)[number];

export const BUILT_IN_TOOL_OVERRIDE_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
] as const;

export type BuiltInToolOverrideName = (typeof BUILT_IN_TOOL_OVERRIDE_NAMES)[number];

export interface ToolOverrideOwnership {
	read: boolean;
	grep: boolean;
	find: boolean;
	ls: boolean;
	bash: boolean;
	edit: boolean;
	write: boolean;
}

export interface CustomToolOverrideConfig {
	kind: CustomToolOverrideKind;
	outputMode: CustomToolOutputMode;
}

export interface ToolIntentConfig {
	enabled: boolean;
	language: ToolIntentLanguage;
	maxLength: number;
}

/** Effective runtime configuration after public result modes are resolved. */
export interface ToolDisplayConfig {
	debug: boolean;
	registerToolOverrides: ToolOverrideOwnership;
	customToolOverrides: Record<string, CustomToolOverrideConfig>;
	toolIntent: ToolIntentConfig;
	toolCallStyle: ToolCallStyle;
	bashCommandPreviewRows: number;
	resultMode: ResultDisplayMode;
	enableNativeUserMessageBox: boolean;
	enableThinkingLabel: boolean;
	readOutputMode: ReadOutputMode;
	searchOutputMode: SearchOutputMode;
	mcpOutputMode: McpOutputMode;
	previewRows: number;
	expandedPreviewMaxRows: number;
	bashOutputMode: BashOutputMode;
	diffViewMode: DiffViewMode;
	diffIndicatorMode: DiffIndicatorMode;
	diffSplitMinWidth: number;
	diffCollapsedRows: number;
	diffWordWrap: boolean;
	showTruncationHints: boolean;
	showRtkCompactionHints: boolean;
}

export const DEFAULT_TOOL_DISPLAY_CONFIG: ToolDisplayConfig = {
	debug: false,
	registerToolOverrides: {
		read: true,
		grep: true,
		find: true,
		ls: true,
		bash: true,
		edit: true,
		write: true,
	},
	customToolOverrides: {},
	toolIntent: {
		enabled: true,
		language: "auto",
		maxLength: 96,
	},
	toolCallStyle: "compact",
	bashCommandPreviewRows: 1,
	resultMode: "compact",
	enableNativeUserMessageBox: true,
	enableThinkingLabel: true,
	readOutputMode: "hidden",
	searchOutputMode: "hidden",
	mcpOutputMode: "hidden",
	previewRows: 8,
	expandedPreviewMaxRows: 4000,
	bashOutputMode: "preview",
	diffViewMode: "auto",
	diffIndicatorMode: "bars",
	diffSplitMinWidth: 120,
	diffCollapsedRows: 24,
	diffWordWrap: true,
	showTruncationHints: false,
	showRtkCompactionHints: false,
};

export interface ConfigLoadResult {
	config: ToolDisplayConfig;
	error?: string;
	notice?: string;
}

export interface ConfigSaveResult {
	success: boolean;
	error?: string;
}
