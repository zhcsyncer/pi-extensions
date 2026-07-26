import { resolvePiThemeStyles, type GlanceRenderStyleContext, type PiThemeLike } from "./theme-adapter.js";
import type { GlanceAmbientTone } from "./theme-selection.js";
import type { GlanceConfig } from "./types.js";

export interface PiThemeHost {
	readonly theme?: PiThemeLike;
}

export interface RuntimeRenderStyleContextOptions {
	readonly piTheme?: PiThemeLike;
	readonly getPiTheme?: () => PiThemeLike | undefined;
	readonly getAmbientTone?: () => GlanceAmbientTone;
}

export function readPiUiTheme(host: PiThemeHost | undefined): PiThemeLike | undefined {
	return host?.theme;
}

export function createPiRenderStyleContext(theme: PiThemeLike | undefined): GlanceRenderStyleContext | undefined {
	if (!theme) return undefined;
	return { styles: resolvePiThemeStyles(theme) };
}

function createLazyPiStyleProvider(options: RuntimeRenderStyleContextOptions): GlanceRenderStyleContext["getPiStyles"] {
	if (options.getPiTheme) {
		return () => {
			const theme = options.getPiTheme?.();
			return theme ? resolvePiThemeStyles(theme) : undefined;
		};
	}
	if (options.piTheme) {
		return () => resolvePiThemeStyles(options.piTheme!);
	}
	return undefined;
}

/**
 * Runtime style providers stay lazy so a config-pane draft can switch color
 * source and Pi theme changes are observed without reinstalling the surface.
 */
export function resolveRuntimeRenderStyleContext(
	_config: GlanceConfig,
	options: RuntimeRenderStyleContextOptions = {},
): GlanceRenderStyleContext | undefined {
	const getPiStyles = createLazyPiStyleProvider(options);
	if (!getPiStyles && !options.getAmbientTone) return undefined;
	return {
		...(getPiStyles ? { getPiStyles } : {}),
		...(options.getAmbientTone ? { getAmbientTone: options.getAmbientTone } : {}),
	};
}
