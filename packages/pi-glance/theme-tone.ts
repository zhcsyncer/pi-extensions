import type { GlanceAmbientTone } from "./theme-selection.js";

export interface PiThemeToneHost {
	readonly theme?: { readonly name?: string } | undefined;
}

export function readPiAmbientTone(host: PiThemeToneHost | undefined): GlanceAmbientTone {
	const name = host?.theme?.name;
	if (name === "light" || name === "dark") return name;
	return "unknown";
}
