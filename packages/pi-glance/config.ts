import { randomUUID } from "node:crypto";
import { chmodSync, closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { mkdir, rename, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import {
	COLOR_SOURCE_VALUES,
	CONTEXT_PROGRESS_STYLE_VALUES,
	CONTEXT_PROGRESS_WIDTH_VALUES,
	CONTEXT_TEXT_MODE_VALUES,
	GIT_SHA_MODE_VALUES,
	ICON_MODE_VALUES,
	MODEL_THINKING_MODE_VALUES,
	PROVIDER_DISPLAY_MODE_VALUES,
	TOKENS_CACHE_MODE_VALUES,
	TOKENS_DISPLAY_MODE_VALUES,
	WORKSPACE_LABEL_MODE_VALUES,
	WORKTREE_SUMMARY_MODE_VALUES,
} from "./config-options.js";
import { THROUGHPUT_PRECISION_DESCRIPTOR } from "./config-schema.js";
import { defaultSegmentConfigs, isSegmentId } from "./segment-registry.js";
import { GLANCE_THEME_ID_SET } from "./themes.js";
import type {
	ContextProgressStyle,
	ContextProgressWidth,
	ContextTextMode,
	ColorSource,
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
	WorktreeSummaryMode,
} from "./types.js";

// CONFIG_VERSION is the on-disk config schema version, not the npm package version.
const CONFIG_VERSION = 15 as const;
const emittedMigrationNotices = new Set<string>();
const pendingMigrationNotices: string[] = [];
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

export function getGlanceConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, "extension-data", "pi-glance", "config.json");
}

export function getLegacyGlanceConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, "pi-glance", "config.json");
}

export function consumeGlanceConfigNotices(): string[] {
	return pendingMigrationNotices.splice(0);
}

function queueMigrationNotice(message: string): void {
	if (emittedMigrationNotices.has(message)) return;
	emittedMigrationNotices.add(message);
	pendingMigrationNotices.push(message);
}

const COLOR_SOURCES = new Set<ColorSource>(COLOR_SOURCE_VALUES);
const ICON_MODES = new Set<IconMode>(ICON_MODE_VALUES);
const PROVIDER_MODES = new Set<GlanceConfig["display"]["showProvider"]>(PROVIDER_DISPLAY_MODE_VALUES);
const WORKSPACE_LABEL_MODES = new Set<WorkspaceLabelMode>(WORKSPACE_LABEL_MODE_VALUES);
const GIT_SHA_MODES = new Set<GitShaMode>(GIT_SHA_MODE_VALUES);
const WORKTREE_SUMMARY_MODES = new Set<WorktreeSummaryMode>(WORKTREE_SUMMARY_MODE_VALUES);
const CONTEXT_TEXT_MODES = new Set<ContextTextMode>(CONTEXT_TEXT_MODE_VALUES);
const CONTEXT_PROGRESS_STYLES = new Set<ContextProgressStyle>(CONTEXT_PROGRESS_STYLE_VALUES);
const CONTEXT_PROGRESS_WIDTHS = new Set<ContextProgressWidth>(CONTEXT_PROGRESS_WIDTH_VALUES);
const TOKENS_DISPLAY_MODES = new Set<TokensDisplayMode>(TOKENS_DISPLAY_MODE_VALUES);
const TOKENS_CACHE_MODES = new Set<TokensCacheMode>(TOKENS_CACHE_MODE_VALUES);
const MODEL_THINKING_MODES = new Set<ModelThinkingMode>(MODEL_THINKING_MODE_VALUES);

export function defaultConfig(): GlanceConfig {
	return {
		version: CONFIG_VERSION,
		enabled: true,
		workingIndicator: {
			enabled: true,
		},
		colorSource: "pi",
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
			showBaseBehind: true,
			shaMode: "off",
			worktreeSummary: "status",
			timeoutMs: 1500,
			refreshDebounceMs: 250,
			pollIntervalMs: 15000,
		},
		context: {
			text: "percent+tokens",
			progress: false,
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
		workingIndicator: { ...config.workingIndicator },
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

function parseWorktreeSummary(value: unknown, fallback: WorktreeSummaryMode): WorktreeSummaryMode {
	if (value === "border-right") return "border-right";
	if (value === "status" || value === "above-compact" || value === "above-detailed" || value === "border-left") return "status";
	return fallback;
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

function legacyContextFromDisplay(display: unknown): { text: ContextTextMode; progress: boolean } | undefined {
	if (display === "percent+tokens" || display === "percent" || display === "tokens") {
		return { text: display, progress: false };
	}
	if (display === "progress") {
		// Old progress-only mode rendered percent beside the bar.
		return { text: "percent", progress: true };
	}
	return undefined;
}

function normalizeContextConfig(
	context: Record<string, unknown>,
	defaults: GlanceConfig["context"],
): GlanceConfig["context"] {
	const legacy = legacyContextFromDisplay(context.display);
	return {
		text: parseStringEnum(context.text, CONTEXT_TEXT_MODES, legacy?.text ?? defaults.text),
		progress: parseBool(context.progress, legacy?.progress ?? defaults.progress),
		progressStyle: parseStringEnum(context.progressStyle, CONTEXT_PROGRESS_STYLES, defaults.progressStyle),
		progressWidth: parseStringEnum(context.progressWidth, CONTEXT_PROGRESS_WIDTHS, defaults.progressWidth),
	};
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
	const rawVersion = typeof record.version === "number" && Number.isFinite(record.version) ? Math.floor(record.version) : undefined;
	const usesLegacyGlanceColorDefault = rawVersion !== undefined && rawVersion < CONFIG_VERSION;
	const workingIndicator = record.workingIndicator && typeof record.workingIndicator === "object" ? (record.workingIndicator as Record<string, unknown>) : {};
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
		workingIndicator: {
			enabled: parseBool(workingIndicator.enabled, defaults.workingIndicator.enabled),
		},
		colorSource: parseStringEnum(record.colorSource, COLOR_SOURCES, usesLegacyGlanceColorDefault ? "glance" : defaults.colorSource),
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
			showBaseBehind: parseBool(git.showBaseBehind, defaults.git.showBaseBehind),
			shaMode: parseStringEnum(git.shaMode, GIT_SHA_MODES, defaults.git.shaMode),
			worktreeSummary: parseWorktreeSummary(git.worktreeSummary, defaults.git.worktreeSummary),
			timeoutMs: parseIntAtLeast(git.timeoutMs, defaults.git.timeoutMs, 100),
			refreshDebounceMs: parseIntAtLeast(git.refreshDebounceMs, defaults.git.refreshDebounceMs, 0),
			pollIntervalMs: parseIntAtLeast(git.pollIntervalMs, defaults.git.pollIntervalMs, 1000),
		},
		context: normalizeContextConfig(context, defaults.context),
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

const CONFIG_SHAPE: Record<string, ReadonlySet<string> | undefined> = {
	"": new Set(["version", "enabled", "workingIndicator", "colorSource", "theme", "icons", "editor", "display", "segments", "model", "git", "context", "cost", "tokens", "throughput", "bottomDetails"]),
	workingIndicator: new Set(["enabled"]),
	theme: new Set(["light", "dark"]),
	editor: new Set(["minContentRows", "topMarginRows"]),
	display: new Set(["showProvider", "workspaceLabel"]),
	model: new Set(["customNames", "showThinking"]),
	git: new Set(["showDirty", "showAheadBehind", "showBaseBehind", "shaMode", "worktreeSummary", "timeoutMs", "refreshDebounceMs", "pollIntervalMs"]),
	context: new Set(["text", "progress", "progressStyle", "progressWidth"]),
	cost: new Set(["hideZero"]),
	tokens: new Set(["display", "cache"]),
	throughput: new Set(["precision"]),
	bottomDetails: new Set(["showAutoCompact"]),
};

function isRecordValue(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function collectDroppedConfigFields(value: unknown): string[] {
	if (!isRecordValue(value)) return ["<root>"];
	const dropped: string[] = [];
	for (const [key, child] of Object.entries(value)) {
		if (!CONFIG_SHAPE[""]!.has(key)) {
			dropped.push(key);
			continue;
		}
		const fields = CONFIG_SHAPE[key];
		if (fields && isRecordValue(child)) {
			for (const childKey of Object.keys(child)) if (!fields.has(childKey)) dropped.push(`${key}.${childKey}`);
		}
		if (key === "segments" && Array.isArray(child)) {
			for (const [index, segment] of child.entries()) {
				if (!isRecordValue(segment)) continue;
				for (const segmentKey of Object.keys(segment)) if (segmentKey !== "id" && segmentKey !== "enabled") dropped.push(`segments[${index}].${segmentKey}`);
			}
		}
	}
	return [...new Set(dropped)];
}

function droppedSummary(dropped: readonly string[]): string {
	return dropped.length > 0 ? ` Dropped unmappable fields: ${dropped.join(", ")}.` : "";
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function withConfigLock<T>(directory: string, fn: () => T): T {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const lockPath = join(directory, ".config-migration.lock");
	const deadline = Date.now() + 1_000;
	let descriptor: number | undefined;
	while (descriptor === undefined) {
		try {
			descriptor = openSync(lockPath, "wx", 0o600);
			writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
		} catch (error) {
			if (!isRecordValue(error) || error.code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
					unlinkSync(lockPath);
					continue;
				}
			} catch (statError) {
				if (isRecordValue(statError) && statError.code === "ENOENT") continue;
				throw statError;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockPath}`);
			sleepSync(20);
		}
	}
	try {
		return fn();
	} finally {
		closeSync(descriptor);
		rmSync(lockPath, { force: true });
	}
}

function writeConfigSync(file: string, config: GlanceConfig): void {
	const directory = dirname(file);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, configToText(config), { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temporary, file);
		chmodSync(file, 0o600);
	} finally {
		rmSync(temporary, { force: true });
	}
}

function parseStoredConfig(file: string): { config: GlanceConfig; raw: unknown; dropped: string[] } {
	const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
	if (!isRecordValue(raw)) throw new Error("the root value must be a JSON object");
	return { config: normalizeConfig(raw), raw, dropped: collectDroppedConfigFields(raw) };
}

export function loadConfigSync(): GlanceConfig {
	const target = getGlanceConfigPath();
	const legacy = getLegacyGlanceConfigPath();
	if (existsSync(target)) {
		try {
			let loaded = parseStoredConfig(target);
			const rawVersion = isRecordValue(loaded.raw) ? loaded.raw.version : undefined;
			if (rawVersion !== CONFIG_VERSION || loaded.dropped.length > 0) {
				loaded = withConfigLock(dirname(target), () => {
					const current = parseStoredConfig(target);
					const currentVersion = isRecordValue(current.raw) ? current.raw.version : undefined;
					if (currentVersion !== CONFIG_VERSION || current.dropped.length > 0) writeConfigSync(target, current.config);
					return current;
				});
				queueMigrationNotice(`Upgraded pi-glance config at ${target}.${droppedSummary(loaded.dropped)}`);
			}
			if (existsSync(legacy)) queueMigrationNotice(`Ignored conflicting legacy pi-glance config at ${legacy}; canonical config is ${target}.`);
			return loaded.config;
		} catch (error) {
			queueMigrationNotice(`Failed to read pi-glance config at ${target}: ${error instanceof Error ? error.message : String(error)}. The file was preserved.`);
			return defaultConfig();
		}
	}
	if (!existsSync(legacy)) return defaultConfig();
	try {
		return withConfigLock(dirname(target), () => {
			if (existsSync(target)) return parseStoredConfig(target).config;
			const loaded = parseStoredConfig(legacy);
			writeConfigSync(target, loaded.config);
			const verified = parseStoredConfig(target).config;
			unlinkSync(legacy);
			queueMigrationNotice(`Migrated pi-glance config from ${legacy} to ${target}.${droppedSummary(loaded.dropped)}`);
			return verified;
		});
	} catch (error) {
		queueMigrationNotice(`Failed to migrate pi-glance config from ${legacy} to ${target}: ${error instanceof Error ? error.message : String(error)}. The legacy file was preserved.`);
		return defaultConfig();
	}
}

export async function loadConfig(): Promise<GlanceConfig> {
	return loadConfigSync();
}

export async function saveConfig(config: GlanceConfig): Promise<void> {
	const target = getGlanceConfigPath();
	const directory = dirname(target);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, configToText(config), { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, target);
	} finally {
		await rm(temporary, { force: true });
	}
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
