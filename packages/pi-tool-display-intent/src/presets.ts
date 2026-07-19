import type { ResultDisplayMode, ToolDisplayConfig } from "./types.js";
import { RESULT_DISPLAY_MODES } from "./types.js";

export const TOOL_RESULT_MODE_KEYS = [
	"readOutputMode",
	"searchOutputMode",
	"mcpOutputMode",
	"bashOutputMode",
] as const satisfies readonly (keyof ToolDisplayConfig)[];

export type ToolResultModeKey = (typeof TOOL_RESULT_MODE_KEYS)[number];
export type ToolResultModeConfig = Pick<ToolDisplayConfig, ToolResultModeKey>;

const TOOL_RESULT_MODE_CONFIGS: Record<ResultDisplayMode, ToolResultModeConfig> = {
	compact: {
		readOutputMode: "hidden",
		searchOutputMode: "hidden",
		mcpOutputMode: "hidden",
		bashOutputMode: "preview",
	},
	summary: {
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
		bashOutputMode: "summary",
	},
	preview: {
		readOutputMode: "preview",
		searchOutputMode: "preview",
		mcpOutputMode: "preview",
		bashOutputMode: "preview",
	},
};

const LEGACY_MODE_ALIASES: Record<string, ResultDisplayMode> = {
	minimal: "compact",
	opencode: "compact",
	balanced: "summary",
	detailed: "preview",
	verbose: "preview",
};

export function getToolResultModeConfig(mode: ResultDisplayMode): ToolResultModeConfig {
	return { ...TOOL_RESULT_MODE_CONFIGS[mode] };
}

export function applyToolDisplayMode(
	config: ToolDisplayConfig,
	mode: ResultDisplayMode,
): ToolDisplayConfig {
	return {
		...config,
		resultMode: mode,
		...TOOL_RESULT_MODE_CONFIGS[mode],
	};
}

function configMatchesMode(config: ToolDisplayConfig, mode: ResultDisplayMode): boolean {
	const expected = TOOL_RESULT_MODE_CONFIGS[mode];
	return TOOL_RESULT_MODE_KEYS.every((key) => config[key] === expected[key]);
}

export function detectToolDisplayMode(config: ToolDisplayConfig): ResultDisplayMode | "custom" {
	return RESULT_DISPLAY_MODES.find((mode) => configMatchesMode(config, mode)) ?? "custom";
}

export function parseToolDisplayMode(raw: string): ResultDisplayMode | undefined {
	const normalized = raw.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}
	return (
		RESULT_DISPLAY_MODES.find((mode) => mode === normalized) ??
		LEGACY_MODE_ALIASES[normalized]
	);
}

export function normalizeToolDisplayMode(
	value: unknown,
	fallback: ResultDisplayMode = "compact",
): ResultDisplayMode {
	if (RESULT_DISPLAY_MODES.includes(value as ResultDisplayMode)) {
		return value as ResultDisplayMode;
	}
	if (typeof value === "string") {
		return LEGACY_MODE_ALIASES[value.trim().toLowerCase()] ?? fallback;
	}
	return fallback;
}
