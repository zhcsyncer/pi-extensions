import { GLANCE_THEME_CATALOG } from "./theme-catalog.js";
import type { GlancePalette, GlanceThemeName, IconMode, IconSet, Rgb } from "./types.js";

export const PALETTES: Record<GlanceThemeName, GlancePalette> = Object.fromEntries(
	GLANCE_THEME_CATALOG.map((theme) => [theme.id, theme.palette]),
) as Record<GlanceThemeName, GlancePalette>;

export const BOTTOM_DETAIL_ICONS: Record<IconMode, { autoCompact: string }> = {
	nerd: { autoCompact: "󰁄 auto" },
	plain: { autoCompact: "auto" },
};

export const ICONS: Record<IconMode, IconSet> = {
	nerd: {
		git: "",
		model: "󰚩",
		context: "󰍛",
		tokens: "󰄨",
		cost: "󰈸",
		throughput: "",
	},
	plain: {
		git: "git",
		model: "ai",
		context: "ctx",
		tokens: "tok",
		cost: "$",
		throughput: "spd",
	},
};

function rgbToFg(color: Rgb): string {
	return `\x1b[38;2;${color.r};${color.g};${color.b}m`;
}

export function fg(color: Rgb, text: string): string {
	return `${rgbToFg(color)}${text}\x1b[39m`;
}
