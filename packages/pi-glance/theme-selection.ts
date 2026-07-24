import type { GlanceThemeName, GlanceThemePair } from "./types.js";

export type GlanceAmbientTone = "light" | "dark" | "unknown";
export type GlanceThemeSlot = "light" | "dark";

export function selectGlanceTheme(pair: GlanceThemePair, tone: GlanceAmbientTone): GlanceThemeName {
	return tone === "dark" ? pair.dark : pair.light;
}
