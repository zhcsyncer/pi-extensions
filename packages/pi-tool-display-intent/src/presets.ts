import type { ToolDisplayConfig } from "./types.js";

export const TOOL_DISPLAY_PRESETS = ["opencode", "balanced", "verbose"] as const;
export type ToolDisplayPreset = (typeof TOOL_DISPLAY_PRESETS)[number];

export const TOOL_OUTPUT_PRESET_KEYS = [
	"readOutputMode",
	"searchOutputMode",
	"mcpOutputMode",
	"previewLines",
	"bashOutputMode",
	"bashCollapsedLines",
] as const satisfies readonly (keyof ToolDisplayConfig)[];

export type ToolOutputPresetKey = (typeof TOOL_OUTPUT_PRESET_KEYS)[number];
export type ToolOutputPresetConfig = Pick<ToolDisplayConfig, ToolOutputPresetKey>;

const TOOL_OUTPUT_PRESET_CONFIGS: Record<ToolDisplayPreset, ToolOutputPresetConfig> = {
	opencode: {
		readOutputMode: "hidden",
		searchOutputMode: "hidden",
		mcpOutputMode: "hidden",
		previewLines: 8,
		bashOutputMode: "opencode",
		bashCollapsedLines: 10,
	},
	balanced: {
		readOutputMode: "summary",
		searchOutputMode: "count",
		mcpOutputMode: "summary",
		previewLines: 8,
		bashOutputMode: "summary",
		bashCollapsedLines: 10,
	},
	verbose: {
		readOutputMode: "preview",
		searchOutputMode: "preview",
		mcpOutputMode: "preview",
		previewLines: 12,
		bashOutputMode: "preview",
		bashCollapsedLines: 20,
	},
};

export function getToolOutputPresetConfig(preset: ToolDisplayPreset): ToolOutputPresetConfig {
	return { ...TOOL_OUTPUT_PRESET_CONFIGS[preset] };
}

export function applyToolDisplayPreset(
	config: ToolDisplayConfig,
	preset: ToolDisplayPreset,
): ToolDisplayConfig {
	return {
		...config,
		...TOOL_OUTPUT_PRESET_CONFIGS[preset],
	};
}

function configMatchesPreset(config: ToolDisplayConfig, preset: ToolDisplayPreset): boolean {
	const expected = TOOL_OUTPUT_PRESET_CONFIGS[preset];
	return TOOL_OUTPUT_PRESET_KEYS.every((key) => config[key] === expected[key]);
}

export function detectToolDisplayPreset(config: ToolDisplayConfig): ToolDisplayPreset | "custom" {
	return TOOL_DISPLAY_PRESETS.find((preset) => configMatchesPreset(config, preset)) ?? "custom";
}

export function parseToolDisplayPreset(raw: string): ToolDisplayPreset | undefined {
	const normalized = raw.trim().toLowerCase();
	if (!normalized) {
		return undefined;
	}
	return TOOL_DISPLAY_PRESETS.find((preset) => preset === normalized);
}
