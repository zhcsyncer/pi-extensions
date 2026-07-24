import { readFileSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	CONTEXT_DISPLAY_MODE_VALUES,
	CONTEXT_PROGRESS_STYLE_VALUES,
	CONTEXT_PROGRESS_WIDTH_VALUES,
	CONTEXT_UNKNOWN_MODE_VALUES,
	GIT_SHA_MODE_VALUES,
	ICON_MODE_VALUES,
	MODEL_THINKING_MODE_VALUES,
	PROVIDER_DISPLAY_MODE_VALUES,
	TOKENS_CACHE_MODE_VALUES,
	TOKENS_DISPLAY_MODE_VALUES,
	WORKSPACE_LABEL_MODE_VALUES,
} from "./config-options.js";
import { THROUGHPUT_PRECISION_DESCRIPTOR } from "./config-schema.js";
import { defaultSegmentConfigs, isSegmentId } from "./segment-registry.js";
import { GLANCE_THEME_ID_SET } from "./themes.js";
import type {
	ContextDisplayMode,
	ContextProgressStyle,
	ContextProgressWidth,
	ContextUnknownMode,
	EditorTopMarginRows,
	GitShaMode,
	GlanceConfig,
	GlanceThemePair,
	IconMode,
	ModelThinkingMode,
	SegmentConfig,
	SegmentId,
	TokensCacheMode,
	TokensDisplayMode,
	WorkspaceLabelMode,
} from "./types.js";

const CONFIG_PATH = join(getAgentDir(), "pi-glance", "config.json");
// CONFIG_VERSION is the on-disk config schema version, not the npm package version.
const CONFIG_VERSION = 10 as const;

const ICON_MODES = new Set<IconMode>(ICON_MODE_VALUES);
const PROVIDER_MODES = new Set<GlanceConfig["display"]["showProvider"]>(PROVIDER_DISPLAY_MODE_VALUES);
const WORKSPACE_LABEL_MODES = new Set<WorkspaceLabelMode>(WORKSPACE_LABEL_MODE_VALUES);
const GIT_SHA_MODES = new Set<GitShaMode>(GIT_SHA_MODE_VALUES);
const CONTEXT_DISPLAY_MODES = new Set<ContextDisplayMode>(CONTEXT_DISPLAY_MODE_VALUES);
const CONTEXT_UNKNOWN_MODES = new Set<ContextUnknownMode>(CONTEXT_UNKNOWN_MODE_VALUES);
const CONTEXT_PROGRESS_STYLES = new Set<ContextProgressStyle>(CONTEXT_PROGRESS_STYLE_VALUES);
const CONTEXT_PROGRESS_WIDTHS = new Set<ContextProgressWidth>(CONTEXT_PROGRESS_WIDTH_VALUES);
const TOKENS_DISPLAY_MODES = new Set<TokensDisplayMode>(TOKENS_DISPLAY_MODE_VALUES);
const TOKENS_CACHE_MODES = new Set<TokensCacheMode>(TOKENS_CACHE_MODE_VALUES);
const MODEL_THINKING_MODES = new Set<ModelThinkingMode>(MODEL_THINKING_MODE_VALUES);

export function defaultConfig(): GlanceConfig {
	return {
		version: CONFIG_VERSION,
		enabled: true,
		theme: { light: "light", dark: "dark" },
		icons: "plain",
		editor: {
			minContentRows: 3,
			topMarginRows: 1,
		},
		display: {
			showProvider: "auto",
			workspaceLabel: "name",
		},
		segments: defaultSegmentConfigs(),
		model: {
			customNames: {},
			showThinking: "auto",
		},
		git: {
			showDirty: true,
			showAheadBehind: true,
			shaMode: "off",
			timeoutMs: 1000,
			refreshDebounceMs: 1500,
			pollIntervalMs: 5000,
		},
		context: {
			display: "percent+tokens",
			unknown: "show",
			progressStyle: "border",
			progressWidth: "third",
		},
		cost: {
			hideZero: false,
		},
		tokens: {
			display: "input-output",
			cache: "auto",
		},
		throughput: {
			precision: THROUGHPUT_PRECISION_DESCRIPTOR.defaultValue,
		},
		bottomDetails: {
			showAutoCompact: true,
		},
	};
}

export function cloneConfig(config: GlanceConfig): GlanceConfig {
	return {
		...config,
		theme: { ...config.theme },
		editor: { ...config.editor },
		display: { ...config.display },
		segments: config.segments.map((s) => ({ ...s })),
		model: { customNames: { ...config.model.customNames }, showThinking: config.model.showThinking },
		git: { ...config.git },
		context: { ...config.context },
		cost: { ...config.cost },
		tokens: { ...config.tokens },
		throughput: { ...config.throughput },
		bottomDetails: { ...config.bottomDetails },
	};
}

function parseBool(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function parseStringEnum<T extends string>(value: unknown, allowed: ReadonlySet<T>, fallback: T): T {
	return typeof value === "string" && allowed.has(value as T) ? (value as T) : fallback;
}

function parseThemePair(value: unknown, fallback: GlanceThemePair): GlanceThemePair {
	if (typeof value === "string" && GLANCE_THEME_ID_SET.has(value as GlanceThemePair["light"])) {
		const theme = value as GlanceThemePair["light"];
		return { light: theme, dark: theme };
	}
	if (!value || typeof value !== "object" || Array.isArray(value)) return { ...fallback };
	const record = value as Record<string, unknown>;
	return {
		light: parseStringEnum(record.light, GLANCE_THEME_ID_SET, fallback.light),
		dark: parseStringEnum(record.dark, GLANCE_THEME_ID_SET, fallback.dark),
	};
}

function parseIntInRange(value: unknown, fallback: number, min: number, max: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.min(max, Math.floor(value)));
}

function parseIntAtLeast(value: unknown, fallback: number, min: number): number {
	if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
	return Math.max(min, Math.floor(value));
}

// Preserve known segment order/enabled flags for configs that already contain the
// current segment model, and append missing default segments for old configs.
// If a segment list is too old/ambiguous (currently: no git segment), fall back
// to the curated default order rather than guessing.
function sameSegmentOrder(actual: readonly SegmentConfig[], expected: readonly SegmentId[]): boolean {
	return actual.length === expected.length && actual.every((segment, index) => segment.id === expected[index]);
}

function normalizeSegments(value: unknown): SegmentConfig[] {
	const defaults = defaultSegmentConfigs();
	const byId = new Map<SegmentId, SegmentConfig>(defaults.map((s) => [s.id, s]));
	const ordered: SegmentConfig[] = [];

	if (Array.isArray(value)) {
		for (const raw of value) {
			if (!raw || typeof raw !== "object") continue;
			const record = raw as Record<string, unknown>;
			if (!isSegmentId(record.id)) continue;
			const id = record.id;
			const base = byId.get(id)!;
			const segment = {
				id,
				enabled: parseBool(record.enabled, base.enabled),
			};
			byId.set(id, segment);
			if (!ordered.some((s) => s.id === id)) ordered.push(segment);
		}
	}

	if (!ordered.some((s) => s.id === "git")) return defaults;

	if (
		sameSegmentOrder(ordered, ["git", "context", "cost", "tokens", "model"]) ||
		sameSegmentOrder(ordered, ["git", "cost", "context", "tokens", "model", "throughput"])
	) {
		return defaults.map((segment) => byId.get(segment.id)!);
	}

	for (const segment of defaults) {
		if (!ordered.some((s) => s.id === segment.id)) ordered.push(byId.get(segment.id)!);
	}

	return ordered;
}

// normalizeConfig() is the migration/validation boundary: preserve valid known
// user values, fill missing/new fields from defaults, clamp numeric bounds, and
// drop invalid/unknown values. Do not bump CONFIG_VERSION for comments/tests or
// product-copy-only releases.
export function normalizeConfig(raw: unknown): GlanceConfig {
	const defaults = defaultConfig();
	if (!raw || typeof raw !== "object") return defaults;
	const record = raw as Record<string, unknown>;
	const editor = record.editor && typeof record.editor === "object" ? (record.editor as Record<string, unknown>) : {};
	const display = record.display && typeof record.display === "object" ? (record.display as Record<string, unknown>) : {};
	const model = record.model && typeof record.model === "object" ? (record.model as Record<string, unknown>) : {};
	const git = record.git && typeof record.git === "object" ? (record.git as Record<string, unknown>) : {};
	const context = record.context && typeof record.context === "object" ? (record.context as Record<string, unknown>) : {};
	const cost = record.cost && typeof record.cost === "object" ? (record.cost as Record<string, unknown>) : {};
	const tokens = record.tokens && typeof record.tokens === "object" ? (record.tokens as Record<string, unknown>) : {};
	const throughput = record.throughput && typeof record.throughput === "object" ? (record.throughput as Record<string, unknown>) : {};
	const bottomDetails = record.bottomDetails && typeof record.bottomDetails === "object" ? (record.bottomDetails as Record<string, unknown>) : {};

	return {
		version: CONFIG_VERSION,
		enabled: parseBool(record.enabled, defaults.enabled),
		theme: parseThemePair(record.theme, defaults.theme),
		icons: parseStringEnum(record.icons, ICON_MODES, defaults.icons),
		editor: {
			minContentRows: parseIntInRange(editor.minContentRows, defaults.editor.minContentRows, 2, 4),
			topMarginRows: parseIntInRange(editor.topMarginRows, defaults.editor.topMarginRows, 0, 2) as EditorTopMarginRows,
		},
		display: {
			showProvider: parseStringEnum(display.showProvider, PROVIDER_MODES, defaults.display.showProvider),
			workspaceLabel: parseStringEnum(display.workspaceLabel, WORKSPACE_LABEL_MODES, defaults.display.workspaceLabel),
		},
		segments: normalizeSegments(record.segments),
		model: {
			customNames:
				model.customNames && typeof model.customNames === "object"
					? (Object.fromEntries(
							Object.entries(model.customNames as Record<string, unknown>).filter(
								(entry): entry is [string, string] => typeof entry[1] === "string",
							),
						) as Record<string, string>)
					: {},
			showThinking: parseStringEnum(model.showThinking, MODEL_THINKING_MODES, defaults.model.showThinking),
		},
		git: {
			showDirty: parseBool(git.showDirty, defaults.git.showDirty),
			showAheadBehind: parseBool(git.showAheadBehind, defaults.git.showAheadBehind),
			shaMode: parseStringEnum(git.shaMode, GIT_SHA_MODES, defaults.git.shaMode),
			timeoutMs: parseIntAtLeast(git.timeoutMs, defaults.git.timeoutMs, 100),
			refreshDebounceMs: parseIntAtLeast(git.refreshDebounceMs, defaults.git.refreshDebounceMs, 0),
			pollIntervalMs: parseIntAtLeast(git.pollIntervalMs, defaults.git.pollIntervalMs, 1000),
		},
		context: {
			display: parseStringEnum(context.display, CONTEXT_DISPLAY_MODES, defaults.context.display),
			unknown: parseStringEnum(context.unknown, CONTEXT_UNKNOWN_MODES, defaults.context.unknown),
			progressStyle: parseStringEnum(context.progressStyle, CONTEXT_PROGRESS_STYLES, defaults.context.progressStyle),
			progressWidth: parseStringEnum(context.progressWidth, CONTEXT_PROGRESS_WIDTHS, defaults.context.progressWidth),
		},
		cost: {
			hideZero: parseBool(cost.hideZero, defaults.cost.hideZero),
		},
		tokens: {
			display: parseStringEnum(tokens.display, TOKENS_DISPLAY_MODES, defaults.tokens.display),
			cache: parseStringEnum(tokens.cache, TOKENS_CACHE_MODES, defaults.tokens.cache),
		},
		throughput: {
			precision: THROUGHPUT_PRECISION_DESCRIPTOR.normalize(throughput.precision),
		},
		bottomDetails: {
			showAutoCompact: parseBool(bottomDetails.showAutoCompact, defaults.bottomDetails.showAutoCompact),
		},
	};
}

export function configFromText(text: string): GlanceConfig {
	return normalizeConfig(JSON.parse(text));
}

export function configToText(config: GlanceConfig): string {
	return `${JSON.stringify(normalizeConfig(config), null, "\t")}\n`;
}

export function loadConfigSync(): GlanceConfig {
	try {
		const text = readFileSync(CONFIG_PATH, "utf8");
		return configFromText(text);
	} catch {
		return defaultConfig();
	}
}

export async function loadConfig(): Promise<GlanceConfig> {
	try {
		const text = await readFile(CONFIG_PATH, "utf8");
		return configFromText(text);
	} catch {
		return defaultConfig();
	}
}

export async function saveConfig(config: GlanceConfig): Promise<void> {
	await mkdir(dirname(CONFIG_PATH), { recursive: true });
	await writeFile(CONFIG_PATH, configToText(config), "utf8");
}

export function moveSegment(config: GlanceConfig, id: SegmentId, direction: -1 | 1): GlanceConfig {
	const next = cloneConfig(config);
	const index = next.segments.findIndex((s) => s.id === id);
	if (index < 0) return next;
	const target = index + direction;
	if (target < 0 || target >= next.segments.length) return next;
	[next.segments[index], next.segments[target]] = [next.segments[target]!, next.segments[index]!];
	return next;
}

export function toggleSegment(config: GlanceConfig, id: SegmentId): GlanceConfig {
	const next = cloneConfig(config);
	const segment = next.segments.find((s) => s.id === id);
	if (segment) segment.enabled = !segment.enabled;
	return next;
}
