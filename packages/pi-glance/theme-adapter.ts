import { PALETTES, fg } from "./palette.js";
import { selectGlanceTheme, type GlanceAmbientTone } from "./theme-selection.js";
import { themeLabel, type GlanceThemeName } from "./themes.js";
import type { GlanceThemePair, Rgb, SegmentId } from "./types.js";

export type TextStyler = (text: string) => string;

export interface ResolvedGlanceSegmentStyles {
	readonly fg: TextStyler;
}

export interface ResolvedGlanceStyles {
	readonly source: "glance" | "pi";
	readonly themeId: string;
	readonly label: string;
	readonly cacheKey: string;
	readonly text: TextStyler;
	readonly dim: TextStyler;
	readonly success: TextStyler;
	readonly warn: TextStyler;
	readonly error: TextStyler;
	readonly separator: TextStyler;
	readonly border: TextStyler;
	readonly title: TextStyler;
	readonly segments: Record<SegmentId, ResolvedGlanceSegmentStyles>;
}

export interface GlanceRenderStyleContext {
	readonly styles?: ResolvedGlanceStyles;
	readonly ambientTone?: GlanceAmbientTone;
	readonly getAmbientTone?: () => GlanceAmbientTone;
}

export type PiThemeColorToken =
	| "accent"
	| "border"
	| "borderAccent"
	| "borderMuted"
	| "success"
	| "error"
	| "warning"
	| "muted"
	| "dim"
	| "text";

export interface PiThemeLike {
	readonly name?: string;
	readonly sourcePath?: string;
	fg(color: PiThemeColorToken, text: string): string;
	getColorMode?(): string;
}

export interface PiThemeStyleOptions {
	readonly cacheKey?: string;
	readonly label?: string;
}

const STYLE_SEGMENT_IDS = ["git", "model", "context", "tokens", "cost", "throughput"] as const satisfies readonly SegmentId[];

function styleFromRgb(color: Rgb): TextStyler {
	return (text) => fg(color, text);
}

function resolveBuiltInSegmentStyles(theme: GlanceThemeName): Record<SegmentId, ResolvedGlanceSegmentStyles> {
	const palette = PALETTES[theme];
	return Object.fromEntries(
		STYLE_SEGMENT_IDS.map((segment) => [segment, { fg: styleFromRgb(palette.segments[segment].fg) }]),
	) as Record<SegmentId, ResolvedGlanceSegmentStyles>;
}

function styleFromPiTokens(theme: PiThemeLike, tokens: readonly PiThemeColorToken[]): TextStyler {
	return (text) => {
		for (const token of tokens) {
			try {
				const styled = theme.fg(token, text);
				if (typeof styled === "string") return styled;
			} catch {
				// Fake/test theme sources may omit fallback tokens; try the next public semantic token.
			}
		}
		return text;
	};
}

function piThemeCacheKey(theme: PiThemeLike, options: PiThemeStyleOptions): string {
	if (options.cacheKey !== undefined) return `pi:${options.cacheKey}`;
	return `pi:${JSON.stringify([theme.name ?? "", theme.getColorMode?.() ?? "", theme.sourcePath ?? ""])}`;
}

function resolvePiSegmentStyles(theme: PiThemeLike): Record<SegmentId, ResolvedGlanceSegmentStyles> {
	return {
		git: { fg: styleFromPiTokens(theme, ["success", "accent", "text"]) },
		model: { fg: styleFromPiTokens(theme, ["text"]) },
		context: { fg: styleFromPiTokens(theme, ["accent", "text"]) },
		tokens: { fg: styleFromPiTokens(theme, ["muted", "dim", "text"]) },
		cost: { fg: styleFromPiTokens(theme, ["warning", "accent", "text"]) },
		throughput: { fg: styleFromPiTokens(theme, ["muted", "dim", "text"]) },
	};
}

export function resolveBuiltInGlanceStyles(theme: GlanceThemeName): ResolvedGlanceStyles {
	const palette = PALETTES[theme];
	return {
		source: "glance",
		themeId: theme,
		label: themeLabel(theme),
		cacheKey: `glance:${theme}`,
		text: styleFromRgb(palette.text),
		dim: styleFromRgb(palette.dim),
		success: styleFromRgb(palette.segments.git.fg),
		warn: styleFromRgb(palette.warn),
		error: styleFromRgb(palette.error),
		separator: styleFromRgb(palette.separator),
		border: styleFromRgb(palette.border),
		title: styleFromRgb(palette.title),
		segments: resolveBuiltInSegmentStyles(theme),
	};
}

export function resolvePiThemeStyles(theme: PiThemeLike, options: PiThemeStyleOptions = {}): ResolvedGlanceStyles {
	return {
		source: "pi",
		themeId: theme.name ?? "pi-theme",
		label: options.label ?? theme.name ?? "Pi theme",
		cacheKey: piThemeCacheKey(theme, options),
		text: styleFromPiTokens(theme, ["text"]),
		dim: styleFromPiTokens(theme, ["dim", "muted", "text"]),
		success: styleFromPiTokens(theme, ["success", "accent", "text"]),
		warn: styleFromPiTokens(theme, ["warning", "accent", "text"]),
		error: styleFromPiTokens(theme, ["error", "warning", "text"]),
		separator: styleFromPiTokens(theme, ["muted", "dim", "text"]),
		border: styleFromPiTokens(theme, ["border", "borderMuted", "muted", "text"]),
		title: styleFromPiTokens(theme, ["accent", "borderAccent", "text"]),
		segments: resolvePiSegmentStyles(theme),
	};
}

export function resolveGlanceRenderStyles(theme: GlanceThemePair, context: GlanceRenderStyleContext = {}): ResolvedGlanceStyles {
	if (context.styles) return context.styles;
	const ambientTone = context.ambientTone ?? context.getAmbientTone?.() ?? "unknown";
	return resolveBuiltInGlanceStyles(selectGlanceTheme(theme, ambientTone));
}
