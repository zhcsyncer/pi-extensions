import { resolvePiThemeStyles, type GlanceRenderStyleContext, type PiThemeLike } from "./theme-adapter.js";
import type { GlanceAmbientTone } from "./theme-selection.js";
import type { GlanceConfig } from "./types.js";

export interface PiThemeHost {
	readonly theme?: PiThemeLike;
}

export interface RuntimeRenderStyleContextOptions {
	readonly piTheme?: PiThemeLike;
	readonly enablePiThemeStyles?: boolean;
	readonly getAmbientTone?: () => GlanceAmbientTone;
}

export function readPiUiTheme(host: PiThemeHost | undefined): PiThemeLike | undefined {
	return host?.theme;
}

export function createPiRenderStyleContext(theme: PiThemeLike | undefined): GlanceRenderStyleContext | undefined {
	if (!theme) return undefined;
	return { styles: resolvePiThemeStyles(theme) };
}

/**
 * Inactive by default: current pi-glance configs have no Pi-theme opt-in, so runtime
 * callers must pass a future explicit enable flag before Pi UI theme styles are used.
 */
export function resolveRuntimeRenderStyleContext(
	_config: GlanceConfig,
	options: RuntimeRenderStyleContextOptions = {},
): GlanceRenderStyleContext | undefined {
	const piStyleContext = options.enablePiThemeStyles ? createPiRenderStyleContext(options.piTheme) : undefined;
	if (!piStyleContext && !options.getAmbientTone) return undefined;
	return {
		...piStyleContext,
		...(options.getAmbientTone ? { getAmbientTone: options.getAmbientTone } : {}),
	};
}
