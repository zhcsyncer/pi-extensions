import type { GuidanceFields } from "@juicesharp/rpiv-config";
import { configPath, loadJsonConfig, validateGuidanceFields } from "@juicesharp/rpiv-config";

const CONFIG_PATH = configPath("rpiv-todo");

export type StatusIconPreset = "ascii" | "unicode" | "nerd-font";

export interface StatusIcons {
	heading: string;
	pending: string;
	inProgressFrames: readonly string[];
	completed: string;
	deleted: string;
}

export const DEFAULT_STATUS_ICON_PRESET: StatusIconPreset = "ascii";

export const STATUS_ICON_PRESETS: Readonly<Record<StatusIconPreset, StatusIcons>> = {
	ascii: {
		heading: "[T]",
		pending: "[ ]",
		inProgressFrames: ["[>]"],
		completed: "[x]",
		deleted: "[!]",
	},
	unicode: {
		heading: "≡",
		pending: "○",
		inProgressFrames: ["◉"],
		completed: "✓",
		deleted: "✗",
	},
	"nerd-font": {
		heading: "󰝖",
		pending: "󰄰",
		inProgressFrames: ["󰪞", "󰪟", "󰪠", "󰪡", "󰪢", "󰪣", "󰪤", "󰪥"],
		completed: "󰗠",
		deleted: "󰅖",
	},
};

export interface TodoConfig {
	guidance?: GuidanceFields;
	statusIcons?: StatusIconPreset;
}

export function loadConfig(): TodoConfig {
	return loadJsonConfig<TodoConfig>(CONFIG_PATH);
}

export function resolveStatusIconPreset(value: unknown): StatusIconPreset {
	return value === "unicode" || value === "nerd-font" || value === "ascii" ? value : DEFAULT_STATUS_ICON_PRESET;
}

export function resolveStatusIcons(value: unknown): StatusIcons {
	return STATUS_ICON_PRESETS[resolveStatusIconPreset(value)];
}

export { validateGuidanceFields };
