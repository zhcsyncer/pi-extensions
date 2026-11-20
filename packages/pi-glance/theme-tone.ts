import type { GlanceAmbientTone } from "./theme-selection.js";

export interface PiThemeToneHost {
	readonly theme?: { readonly name?: string; readonly appearance?: "dark" | "light" } | undefined;
}

export function readPiAmbientTone(host: PiThemeToneHost | undefined): GlanceAmbientTone {
	const appearance = host?.theme?.appearance;
	if (appearance === "light" || appearance === "dark") return appearance;
	const name = host?.theme?.name;
	if (name === "light" || name === "dark") return name;
	return "unknown";
}
