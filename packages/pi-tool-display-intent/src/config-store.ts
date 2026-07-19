import { resolvePiAgentDir } from "./agent-dir.js";
import {
	existsSync,
	mkdirSync,
	readFileSync,
	renameSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { isDeepStrictEqual } from "node:util";
import {
	BUILT_IN_TOOL_OVERRIDE_NAMES,
	BASH_OUTPUT_MODES,
	CUSTOM_TOOL_OUTPUT_MODES,
	CUSTOM_TOOL_OVERRIDE_KINDS,
	DEFAULT_TOOL_DISPLAY_CONFIG,
	type ConfigLoadResult,
	type ConfigSaveResult,
	type CustomToolOverrideConfig,
	DIFF_INDICATOR_MODES,
	DIFF_VIEW_MODES,
	MCP_OUTPUT_MODES,
	READ_OUTPUT_MODES,
	SEARCH_OUTPUT_MODES,
	TOOL_CALL_STYLES,
	TOOL_DISPLAY_CONFIG_SCHEMA_URL,
	TOOL_DISPLAY_CONFIG_VERSION,
	TOOL_INTENT_LANGUAGES,
	type ToolDisplayConfig,
	type ToolOverrideOwnership,
} from "./types.js";
import {
	detectToolDisplayPreset,
	getToolOutputPresetConfig,
	normalizeToolDisplayResultProfile,
	TOOL_DISPLAY_PRESETS,
} from "./presets.js";
import { toRecord } from "./tool-metadata.js";

const CONFIG_DIR = join(resolvePiAgentDir(), "extensions", "pi-tool-display-intent");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const LEGACY_BACKUP_FILE_NAME = "config.legacy.json";

interface LegacyToolDisplayConfigSource extends Partial<ToolDisplayConfig> {
	displaySummary?: unknown;
	registerReadToolOverride?: unknown;
}

function clampNumber(value: unknown, min: number, max: number, fallback: number): number {
	if (typeof value !== "number" || Number.isNaN(value)) {
		return fallback;
	}
	const rounded = Math.floor(value);
	if (rounded < min) return min;
	if (rounded > max) return max;
	return rounded;
}

function toBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

function toReadOutputMode(value: unknown, fallback = DEFAULT_TOOL_DISPLAY_CONFIG.readOutputMode): ToolDisplayConfig["readOutputMode"] {
	return READ_OUTPUT_MODES.includes(value as ToolDisplayConfig["readOutputMode"])
		? (value as ToolDisplayConfig["readOutputMode"])
		: fallback;
}

function toSearchOutputMode(value: unknown, fallback = DEFAULT_TOOL_DISPLAY_CONFIG.searchOutputMode): ToolDisplayConfig["searchOutputMode"] {
	return SEARCH_OUTPUT_MODES.includes(value as ToolDisplayConfig["searchOutputMode"])
		? (value as ToolDisplayConfig["searchOutputMode"])
		: fallback;
}

function toMcpOutputMode(value: unknown, fallback = DEFAULT_TOOL_DISPLAY_CONFIG.mcpOutputMode): ToolDisplayConfig["mcpOutputMode"] {
	return MCP_OUTPUT_MODES.includes(value as ToolDisplayConfig["mcpOutputMode"])
		? (value as ToolDisplayConfig["mcpOutputMode"])
		: fallback;
}

function toBashOutputMode(value: unknown, fallback = DEFAULT_TOOL_DISPLAY_CONFIG.bashOutputMode): ToolDisplayConfig["bashOutputMode"] {
	return BASH_OUTPUT_MODES.includes(value as ToolDisplayConfig["bashOutputMode"])
		? (value as ToolDisplayConfig["bashOutputMode"])
		: fallback;
}

function toToolCallStyle(value: unknown): ToolDisplayConfig["toolCallStyle"] {
	return TOOL_CALL_STYLES.includes(value as ToolDisplayConfig["toolCallStyle"])
		? (value as ToolDisplayConfig["toolCallStyle"])
		: DEFAULT_TOOL_DISPLAY_CONFIG.toolCallStyle;
}

function toDiffViewMode(value: unknown): ToolDisplayConfig["diffViewMode"] {
	if (value === "stacked") {
		return "unified";
	}

	return DIFF_VIEW_MODES.includes(value as ToolDisplayConfig["diffViewMode"])
		? (value as ToolDisplayConfig["diffViewMode"])
		: DEFAULT_TOOL_DISPLAY_CONFIG.diffViewMode;
}

function toDiffIndicatorMode(value: unknown): ToolDisplayConfig["diffIndicatorMode"] {
	return DIFF_INDICATOR_MODES.includes(value as ToolDisplayConfig["diffIndicatorMode"])
		? (value as ToolDisplayConfig["diffIndicatorMode"])
		: DEFAULT_TOOL_DISPLAY_CONFIG.diffIndicatorMode;
}

function normalizeToolIntentConfig(rawConfig: unknown): ToolDisplayConfig["toolIntent"] {
	const source = toRecord(rawConfig);
	const defaults = DEFAULT_TOOL_DISPLAY_CONFIG.toolIntent;
	const language = TOOL_INTENT_LANGUAGES.includes(
		source.language as ToolDisplayConfig["toolIntent"]["language"],
	)
		? (source.language as ToolDisplayConfig["toolIntent"]["language"])
		: defaults.language;

	return {
		enabled: toBoolean(source.enabled, defaults.enabled),
		language,
		maxLength: clampNumber(source.maxLength, 16, 256, defaults.maxLength),
	};
}

export function cloneCustomToolOverrides(
	overrides: Record<string, CustomToolOverrideConfig>,
): Record<string, CustomToolOverrideConfig> {
	return Object.fromEntries(
		Object.entries(overrides).map(([toolName, override]) => [
			toolName,
			{ ...override },
		]),
	);
}

function cloneDefaultConfig(): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		registerToolOverrides: { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides },
		customToolOverrides: cloneCustomToolOverrides(DEFAULT_TOOL_DISPLAY_CONFIG.customToolOverrides),
		toolIntent: { ...DEFAULT_TOOL_DISPLAY_CONFIG.toolIntent },
	};
}

let cachedConfigFile: string | undefined;
let cachedConfigFingerprint: string | undefined;
let cachedConfigResult: ConfigLoadResult | undefined;

function cloneConfig(config: ToolDisplayConfig): ToolDisplayConfig {
	return normalizeToolDisplayConfig(config);
}

function cloneLoadResult(result: ConfigLoadResult): ConfigLoadResult {
	return {
		...result,
		config: cloneConfig(result.config),
	};
}

function getConfigFingerprint(configFile: string): string {
	try {
		const stats = statSync(configFile);
		return `${stats.mtimeMs}:${stats.size}`;
	} catch {
		return "missing";
	}
}

function normalizeToolOverrideOwnership(
	rawOverrides: unknown,
	legacyRegisterReadToolOverride: unknown,
): ToolOverrideOwnership {
	const source = toRecord(rawOverrides);
	const defaults = DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides;
	const legacyReadDefault = toBoolean(legacyRegisterReadToolOverride, defaults.read);

	const overrides = { ...defaults };
	for (const toolName of BUILT_IN_TOOL_OVERRIDE_NAMES) {
		const fallback = toolName === "read" ? legacyReadDefault : defaults[toolName];
		overrides[toolName] = toBoolean(source[toolName], fallback);
	}

	return overrides;
}

function isBuiltInToolOverrideName(toolName: string): boolean {
	return (BUILT_IN_TOOL_OVERRIDE_NAMES as readonly string[]).includes(toolName);
}

export function toCustomToolOverrideKind(value: unknown): CustomToolOverrideConfig["kind"] {
	return CUSTOM_TOOL_OVERRIDE_KINDS.includes(value as CustomToolOverrideConfig["kind"])
		? (value as CustomToolOverrideConfig["kind"])
		: "generic";
}

export function toCustomToolOutputMode(value: unknown): CustomToolOverrideConfig["outputMode"] {
	return CUSTOM_TOOL_OUTPUT_MODES.includes(value as CustomToolOverrideConfig["outputMode"])
		? (value as CustomToolOverrideConfig["outputMode"])
		: "summary";
}

export function normalizeCustomToolOverrideEntry(rawEntry: unknown): CustomToolOverrideConfig | undefined {
	if (typeof rawEntry === "boolean") {
		return {
			enabled: rawEntry,
			kind: "generic",
			outputMode: "summary",
		};
	}

	if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
		return undefined;
	}

	const source = toRecord(rawEntry);
	return {
		enabled: toBoolean(source.enabled, true),
		kind: toCustomToolOverrideKind(source.kind ?? source.renderer),
		outputMode: toCustomToolOutputMode(source.outputMode ?? source.result),
	};
}

function normalizeCustomToolOverrides(rawOverrides: unknown): Record<string, CustomToolOverrideConfig> {
	const source = toRecord(rawOverrides);
	const overrides: Record<string, CustomToolOverrideConfig> = {};

	for (const [rawToolName, rawEntry] of Object.entries(source)) {
		const toolName = rawToolName.trim();
		if (!toolName || isBuiltInToolOverrideName(toolName)) {
			continue;
		}

		const normalized = normalizeCustomToolOverrideEntry(rawEntry);
		if (!normalized) {
			continue;
		}

		overrides[toolName] = normalized;
	}

	return overrides;
}

function detectLegacyProfile(config: ToolDisplayConfig): ToolDisplayConfig["resultProfile"] {
	const detected = detectToolDisplayPreset(config);
	return detected === "custom" ? DEFAULT_TOOL_DISPLAY_CONFIG.resultProfile : detected;
}

export function normalizeToolDisplayConfig(raw: unknown): ToolDisplayConfig {
	const source =
		typeof raw === "object" && raw !== null
			? (raw as LegacyToolDisplayConfigSource)
			: ({} as LegacyToolDisplayConfigSource);

	const rawToolIntent = Object.prototype.hasOwnProperty.call(source, "toolIntent")
		? source.toolIntent
		: source.displaySummary;
	const hasExplicitProfile = TOOL_DISPLAY_PRESETS.includes(source.resultProfile as never);

	const config: ToolDisplayConfig = {
		enabled: toBoolean(source.enabled, DEFAULT_TOOL_DISPLAY_CONFIG.enabled),
		debug: toBoolean(source.debug, DEFAULT_TOOL_DISPLAY_CONFIG.debug),
		registerToolOverrides: normalizeToolOverrideOwnership(
			source.registerToolOverrides,
			source.registerReadToolOverride,
		),
		customToolOverrides: normalizeCustomToolOverrides(source.customToolOverrides),
		toolIntent: normalizeToolIntentConfig(rawToolIntent),
		toolCallStyle: toToolCallStyle(source.toolCallStyle),
		resultProfile: normalizeToolDisplayResultProfile(source.resultProfile),
		enableNativeUserMessageBox: toBoolean(
			source.enableNativeUserMessageBox,
			DEFAULT_TOOL_DISPLAY_CONFIG.enableNativeUserMessageBox,
		),
		enableThinkingLabel: toBoolean(
			source.enableThinkingLabel,
			DEFAULT_TOOL_DISPLAY_CONFIG.enableThinkingLabel,
		),
		readOutputMode: toReadOutputMode(source.readOutputMode),
		searchOutputMode: toSearchOutputMode(source.searchOutputMode),
		mcpOutputMode: toMcpOutputMode(source.mcpOutputMode),
		previewLines: clampNumber(source.previewLines, 1, 80, DEFAULT_TOOL_DISPLAY_CONFIG.previewLines),
		expandedPreviewMaxLines: clampNumber(
			source.expandedPreviewMaxLines,
			0,
			20_000,
			DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
		),
		bashOutputMode: toBashOutputMode(source.bashOutputMode),
		bashCollapsedLines: clampNumber(
			source.bashCollapsedLines,
			0,
			80,
			DEFAULT_TOOL_DISPLAY_CONFIG.bashCollapsedLines,
		),
		diffViewMode: toDiffViewMode(source.diffViewMode),
		diffIndicatorMode: toDiffIndicatorMode(source.diffIndicatorMode),
		diffSplitMinWidth: clampNumber(
			source.diffSplitMinWidth,
			70,
			240,
			DEFAULT_TOOL_DISPLAY_CONFIG.diffSplitMinWidth,
		),
		diffCollapsedLines: clampNumber(
			source.diffCollapsedLines,
			4,
			240,
			DEFAULT_TOOL_DISPLAY_CONFIG.diffCollapsedLines,
		),
		diffWordWrap: toBoolean(source.diffWordWrap, DEFAULT_TOOL_DISPLAY_CONFIG.diffWordWrap),
		showTruncationHints: toBoolean(
			source.showTruncationHints,
			DEFAULT_TOOL_DISPLAY_CONFIG.showTruncationHints,
		),
		showRtkCompactionHints: toBoolean(
			source.showRtkCompactionHints,
			DEFAULT_TOOL_DISPLAY_CONFIG.showRtkCompactionHints,
		),
	};

	if (!hasExplicitProfile) {
		config.resultProfile = detectLegacyProfile(config);
	}
	return config;
}

function toV2SearchOutputMode(value: unknown, fallback: ToolDisplayConfig["searchOutputMode"]): ToolDisplayConfig["searchOutputMode"] {
	return value === "summary" ? "count" : toSearchOutputMode(value, fallback);
}

function toV2BashOutputMode(value: unknown, fallback: ToolDisplayConfig["bashOutputMode"]): ToolDisplayConfig["bashOutputMode"] {
	return value === "inline" ? "opencode" : toBashOutputMode(value, fallback);
}

function normalizeV2ToolOwnership(rawTools: unknown): ToolOverrideOwnership {
	const tools = toRecord(rawTools);
	const disabled = new Set(
		Array.isArray(tools.disabled)
			? tools.disabled.filter((name): name is string => typeof name === "string")
			: [],
	);
	const ownership = { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides };
	for (const toolName of BUILT_IN_TOOL_OVERRIDE_NAMES) {
		ownership[toolName] = !disabled.has(toolName);
	}
	return ownership;
}

function hasOwn(source: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(source, key);
}

function validateKnownKeys(
	source: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
	errors: string[],
): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(source)) {
		if (!allowedKeys.has(key)) {
			errors.push(`${path}${key}: unknown setting`);
		}
	}
}

function validateOptionalEnum(
	source: Record<string, unknown>,
	key: string,
	allowed: readonly string[],
	path: string,
	errors: string[],
): void {
	if (hasOwn(source, key) && !allowed.includes(source[key] as string)) {
		errors.push(`${path}${key}: expected ${allowed.join(" | ")}`);
	}
}

function validateOptionalBoolean(
	source: Record<string, unknown>,
	key: string,
	path: string,
	errors: string[],
): void {
	if (hasOwn(source, key) && typeof source[key] !== "boolean") {
		errors.push(`${path}${key}: expected boolean`);
	}
}

function validateOptionalInteger(
	source: Record<string, unknown>,
	key: string,
	min: number,
	max: number,
	path: string,
	errors: string[],
): void {
	if (!hasOwn(source, key)) return;
	const value = source[key];
	if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
		errors.push(`${path}${key}: expected integer from ${min} to ${max}`);
	}
}

function getV2Section(
	source: Record<string, unknown>,
	key: string,
	errors: string[],
	path = key,
): Record<string, unknown> {
	if (!hasOwn(source, key)) return {};
	const value = source[key];
	if (!value || typeof value !== "object" || Array.isArray(value)) {
		errors.push(`${path}: expected object`);
		return {};
	}
	return value as Record<string, unknown>;
}

function validateToolDisplayConfigV2(raw: unknown): string[] {
	const source = toRecord(raw);
	const errors: string[] = [];
	validateKnownKeys(
		source,
		["$schema", "version", "extension", "intent", "toolCalls", "results", "diff", "transcript", "tools", "advanced"],
		"",
		errors,
	);

	const extension = getV2Section(source, "extension", errors);
	validateKnownKeys(extension, ["enabled"], "extension.", errors);
	validateOptionalBoolean(extension, "enabled", "extension.", errors);

	const intent = getV2Section(source, "intent", errors);
	validateKnownKeys(intent, ["enabled", "language", "maxLength"], "intent.", errors);
	validateOptionalBoolean(intent, "enabled", "intent.", errors);
	validateOptionalEnum(intent, "language", TOOL_INTENT_LANGUAGES, "intent.", errors);
	validateOptionalInteger(intent, "maxLength", 16, 256, "intent.", errors);

	const toolCalls = getV2Section(source, "toolCalls", errors);
	validateKnownKeys(toolCalls, ["frame"], "toolCalls.", errors);
	validateOptionalEnum(toolCalls, "frame", TOOL_CALL_STYLES, "toolCalls.", errors);

	if (!hasOwn(source, "results")) errors.push("results: required section");
	const results = getV2Section(source, "results", errors);
	validateKnownKeys(results, ["profile", "previewLines", "overrides"], "results.", errors);
	if (!hasOwn(results, "profile")) errors.push("results.profile: required setting");
	validateOptionalEnum(results, "profile", TOOL_DISPLAY_PRESETS, "results.", errors);
	validateOptionalInteger(results, "previewLines", 1, 80, "results.", errors);
	const resultOverrides = getV2Section(results, "overrides", errors, "results.overrides");
	validateKnownKeys(resultOverrides, ["read", "search", "mcp", "bash"], "results.overrides.", errors);
	validateOptionalEnum(resultOverrides, "read", READ_OUTPUT_MODES, "results.overrides.", errors);
	validateOptionalEnum(resultOverrides, "search", ["hidden", "summary", "preview"], "results.overrides.", errors);
	validateOptionalEnum(resultOverrides, "mcp", MCP_OUTPUT_MODES, "results.overrides.", errors);
	const bash = getV2Section(resultOverrides, "bash", errors, "results.overrides.bash");
	validateKnownKeys(bash, ["mode", "collapsedLines"], "results.overrides.bash.", errors);
	validateOptionalEnum(bash, "mode", ["inline", "summary", "preview"], "results.overrides.bash.", errors);
	validateOptionalInteger(bash, "collapsedLines", 0, 80, "results.overrides.bash.", errors);

	const diff = getV2Section(source, "diff", errors);
	validateKnownKeys(diff, ["layout", "indicators", "splitMinWidth", "collapsedLines", "wordWrap"], "diff.", errors);
	validateOptionalEnum(diff, "layout", DIFF_VIEW_MODES, "diff.", errors);
	validateOptionalEnum(diff, "indicators", DIFF_INDICATOR_MODES, "diff.", errors);
	validateOptionalInteger(diff, "splitMinWidth", 70, 240, "diff.", errors);
	validateOptionalInteger(diff, "collapsedLines", 4, 240, "diff.", errors);
	validateOptionalBoolean(diff, "wordWrap", "diff.", errors);

	const transcript = getV2Section(source, "transcript", errors);
	validateKnownKeys(transcript, ["userMessage", "thinkingLabel"], "transcript.", errors);
	validateOptionalEnum(transcript, "userMessage", ["boxed", "default"], "transcript.", errors);
	validateOptionalBoolean(transcript, "thinkingLabel", "transcript.", errors);

	const tools = getV2Section(source, "tools", errors);
	validateKnownKeys(tools, ["disabled", "custom"], "tools.", errors);
	if (hasOwn(tools, "disabled")) {
		if (!Array.isArray(tools.disabled)) {
			errors.push("tools.disabled: expected array");
		} else {
			for (const [index, toolName] of tools.disabled.entries()) {
				if (!(BUILT_IN_TOOL_OVERRIDE_NAMES as readonly unknown[]).includes(toolName)) {
					errors.push(`tools.disabled.${index}: unknown built-in tool`);
				}
			}
		}
	}
	const custom = getV2Section(tools, "custom", errors, "tools.custom");
	for (const [toolName, rawEntry] of Object.entries(custom)) {
		const entry = toRecord(rawEntry);
		if (Object.keys(entry).length === 0 && (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry))) {
			errors.push(`tools.custom.${toolName}: expected object`);
			continue;
		}
		validateKnownKeys(entry, ["enabled", "renderer", "result"], `tools.custom.${toolName}.`, errors);
		validateOptionalBoolean(entry, "enabled", `tools.custom.${toolName}.`, errors);
		validateOptionalEnum(entry, "renderer", CUSTOM_TOOL_OVERRIDE_KINDS, `tools.custom.${toolName}.`, errors);
		validateOptionalEnum(entry, "result", CUSTOM_TOOL_OUTPUT_MODES, `tools.custom.${toolName}.`, errors);
	}

	const advanced = getV2Section(source, "advanced", errors);
	validateKnownKeys(advanced, ["expandedLineLimit", "truncationHints", "rtkCompactionHints", "debug"], "advanced.", errors);
	validateOptionalInteger(advanced, "expandedLineLimit", 0, 20_000, "advanced.", errors);
	validateOptionalBoolean(advanced, "truncationHints", "advanced.", errors);
	validateOptionalBoolean(advanced, "rtkCompactionHints", "advanced.", errors);
	validateOptionalBoolean(advanced, "debug", "advanced.", errors);

	return errors;
}

function normalizeToolDisplayConfigV2(raw: unknown): ToolDisplayConfig {
	const source = toRecord(raw);
	const extension = toRecord(source.extension);
	const results = toRecord(source.results);
	const resultOverrides = toRecord(results.overrides);
	const bashOverride = toRecord(resultOverrides.bash);
	const diff = toRecord(source.diff);
	const transcript = toRecord(source.transcript);
	const tools = toRecord(source.tools);
	const advanced = toRecord(source.advanced);
	const toolCalls = toRecord(source.toolCalls);
	const profile = normalizeToolDisplayResultProfile(results.profile);
	const profileConfig = getToolOutputPresetConfig(profile);

	return normalizeToolDisplayConfig({
		enabled: toBoolean(extension.enabled, DEFAULT_TOOL_DISPLAY_CONFIG.enabled),
		debug: toBoolean(advanced.debug, DEFAULT_TOOL_DISPLAY_CONFIG.debug),
		resultProfile: profile,
		registerToolOverrides: normalizeV2ToolOwnership(tools),
		customToolOverrides: tools.custom,
		toolIntent: source.intent,
		toolCallStyle: toolCalls.frame,
		enableNativeUserMessageBox:
			transcript.userMessage === "default"
				? false
				: transcript.userMessage === "boxed"
					? true
					: DEFAULT_TOOL_DISPLAY_CONFIG.enableNativeUserMessageBox,
		enableThinkingLabel: toBoolean(
			transcript.thinkingLabel,
			DEFAULT_TOOL_DISPLAY_CONFIG.enableThinkingLabel,
		),
		readOutputMode: toReadOutputMode(resultOverrides.read, profileConfig.readOutputMode),
		searchOutputMode: toV2SearchOutputMode(resultOverrides.search, profileConfig.searchOutputMode),
		mcpOutputMode: toMcpOutputMode(resultOverrides.mcp, profileConfig.mcpOutputMode),
		previewLines: clampNumber(results.previewLines, 1, 80, profileConfig.previewLines),
		expandedPreviewMaxLines: clampNumber(
			advanced.expandedLineLimit,
			0,
			20_000,
			DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxLines,
		),
		bashOutputMode: toV2BashOutputMode(bashOverride.mode, profileConfig.bashOutputMode),
		bashCollapsedLines: clampNumber(
			bashOverride.collapsedLines,
			0,
			80,
			profileConfig.bashCollapsedLines,
		),
		diffViewMode: diff.layout,
		diffIndicatorMode: diff.indicators,
		diffSplitMinWidth: diff.splitMinWidth,
		diffCollapsedLines: diff.collapsedLines,
		diffWordWrap: diff.wordWrap,
		showTruncationHints: advanced.truncationHints,
		showRtkCompactionHints: advanced.rtkCompactionHints,
	});
}

function mapSearchOutputModeToV2(value: ToolDisplayConfig["searchOutputMode"]): "hidden" | "summary" | "preview" {
	return value === "count" ? "summary" : value;
}

function mapBashOutputModeToV2(value: ToolDisplayConfig["bashOutputMode"]): "inline" | "summary" | "preview" {
	return value === "opencode" ? "inline" : value;
}

function assignSection(target: Record<string, unknown>, key: string, section: Record<string, unknown>): void {
	if (Object.keys(section).length > 0) {
		target[key] = section;
	}
}

export function serializeToolDisplayConfigV2(rawConfig: ToolDisplayConfig): Record<string, unknown> {
	const config = normalizeToolDisplayConfig(rawConfig);
	const defaults = DEFAULT_TOOL_DISPLAY_CONFIG;
	const baseline = getToolOutputPresetConfig(config.resultProfile);
	const output: Record<string, unknown> = {
		$schema: TOOL_DISPLAY_CONFIG_SCHEMA_URL,
		version: TOOL_DISPLAY_CONFIG_VERSION,
	};

	if (config.enabled !== defaults.enabled) {
		output.extension = { enabled: config.enabled };
	}

	const intent: Record<string, unknown> = {};
	if (config.toolIntent.enabled !== defaults.toolIntent.enabled) intent.enabled = config.toolIntent.enabled;
	if (config.toolIntent.language !== defaults.toolIntent.language) intent.language = config.toolIntent.language;
	if (config.toolIntent.maxLength !== defaults.toolIntent.maxLength) intent.maxLength = config.toolIntent.maxLength;
	assignSection(output, "intent", intent);

	if (config.toolCallStyle !== defaults.toolCallStyle) {
		output.toolCalls = { frame: config.toolCallStyle };
	}

	const resultOverrides: Record<string, unknown> = {};
	if (config.readOutputMode !== baseline.readOutputMode) resultOverrides.read = config.readOutputMode;
	if (config.searchOutputMode !== baseline.searchOutputMode) {
		resultOverrides.search = mapSearchOutputModeToV2(config.searchOutputMode);
	}
	if (config.mcpOutputMode !== baseline.mcpOutputMode) resultOverrides.mcp = config.mcpOutputMode;
	const bashOverride: Record<string, unknown> = {};
	if (config.bashOutputMode !== baseline.bashOutputMode) {
		bashOverride.mode = mapBashOutputModeToV2(config.bashOutputMode);
	}
	if (config.bashCollapsedLines !== baseline.bashCollapsedLines) {
		bashOverride.collapsedLines = config.bashCollapsedLines;
	}
	assignSection(resultOverrides, "bash", bashOverride);

	const results: Record<string, unknown> = { profile: config.resultProfile };
	if (config.previewLines !== baseline.previewLines) results.previewLines = config.previewLines;
	assignSection(results, "overrides", resultOverrides);
	output.results = results;

	const diff: Record<string, unknown> = {};
	if (config.diffViewMode !== defaults.diffViewMode) diff.layout = config.diffViewMode;
	if (config.diffIndicatorMode !== defaults.diffIndicatorMode) diff.indicators = config.diffIndicatorMode;
	if (config.diffSplitMinWidth !== defaults.diffSplitMinWidth) diff.splitMinWidth = config.diffSplitMinWidth;
	if (config.diffCollapsedLines !== defaults.diffCollapsedLines) diff.collapsedLines = config.diffCollapsedLines;
	if (config.diffWordWrap !== defaults.diffWordWrap) diff.wordWrap = config.diffWordWrap;
	assignSection(output, "diff", diff);

	const transcript: Record<string, unknown> = {};
	if (config.enableNativeUserMessageBox !== defaults.enableNativeUserMessageBox) {
		transcript.userMessage = config.enableNativeUserMessageBox ? "boxed" : "default";
	}
	if (config.enableThinkingLabel !== defaults.enableThinkingLabel) {
		transcript.thinkingLabel = config.enableThinkingLabel;
	}
	assignSection(output, "transcript", transcript);

	const tools: Record<string, unknown> = {};
	const disabled = BUILT_IN_TOOL_OVERRIDE_NAMES.filter(
		(toolName) => !config.registerToolOverrides[toolName],
	);
	if (disabled.length > 0) tools.disabled = disabled;
	if (Object.keys(config.customToolOverrides).length > 0) {
		tools.custom = Object.fromEntries(
			Object.entries(config.customToolOverrides).map(([toolName, override]) => [
				toolName,
				{
					enabled: override.enabled,
					renderer: override.kind,
					result: override.outputMode,
				},
			]),
		);
	}
	assignSection(output, "tools", tools);

	const advanced: Record<string, unknown> = {};
	if (config.expandedPreviewMaxLines !== defaults.expandedPreviewMaxLines) {
		advanced.expandedLineLimit = config.expandedPreviewMaxLines;
	}
	if (config.showTruncationHints !== defaults.showTruncationHints) {
		advanced.truncationHints = config.showTruncationHints;
	}
	if (config.showRtkCompactionHints !== defaults.showRtkCompactionHints) {
		advanced.rtkCompactionHints = config.showRtkCompactionHints;
	}
	if (config.debug !== defaults.debug) advanced.debug = config.debug;
	assignSection(output, "advanced", advanced);

	return output;
}

function writeConfigAtomically(configFile: string, serialized: Record<string, unknown>): void {
	const tmpFile = `${configFile}.tmp`;
	mkdirSync(dirname(configFile), { recursive: true });
	try {
		writeFileSync(tmpFile, `${JSON.stringify(serialized, null, 2)}\n`, "utf-8");
		renameSync(tmpFile, configFile);
	} catch (error) {
		try {
			if (existsSync(tmpFile)) unlinkSync(tmpFile);
		} catch {
			// Preserve the original write error.
		}
		throw error;
	}
}

function migrateLegacyConfigFile(
	configFile: string,
	rawText: string,
	config: ToolDisplayConfig,
): string | undefined {
	try {
		const serialized = serializeToolDisplayConfigV2(config);
		const roundTripped = normalizeToolDisplayConfigV2(serialized);
		if (!isDeepStrictEqual(normalizeToolDisplayConfig(config), roundTripped)) {
			throw new Error("v2 migration changed the effective configuration");
		}

		const backupFile = join(dirname(configFile), LEGACY_BACKUP_FILE_NAME);
		if (!existsSync(backupFile)) {
			writeFileSync(backupFile, rawText, { encoding: "utf-8", flag: "wx" });
		}
		writeConfigAtomically(configFile, serialized);
		return undefined;
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return `Loaded legacy tool display config but failed to migrate ${configFile}: ${message}`;
	}
}

export function loadToolDisplayConfig(configFile = CONFIG_FILE): ConfigLoadResult {
	const fingerprint = getConfigFingerprint(configFile);
	if (cachedConfigResult && cachedConfigFile === configFile && cachedConfigFingerprint === fingerprint) {
		return cloneLoadResult(cachedConfigResult);
	}

	let result: ConfigLoadResult;
	if (!existsSync(configFile)) {
		result = { config: cloneDefaultConfig() };
	} else {
		try {
			const rawText = readFileSync(configFile, "utf-8");
			const rawConfig = JSON.parse(rawText) as unknown;
			const source = toRecord(rawConfig);

			if (Object.prototype.hasOwnProperty.call(source, "version")) {
				if (source.version !== TOOL_DISPLAY_CONFIG_VERSION) {
					result = {
						config: cloneDefaultConfig(),
						error: `Unsupported tool display config version in ${configFile}: ${String(source.version)}`,
					};
				} else {
					const validationErrors = validateToolDisplayConfigV2(source);
					result = {
						config: normalizeToolDisplayConfigV2(source),
						...(validationErrors.length > 0
							? {
								error: `Invalid tool display v2 config in ${configFile}: ${validationErrors.join("; ")}`,
							}
							: {}),
					};
				}
			} else {
				const config = normalizeToolDisplayConfig(source);
				const migrationError = migrateLegacyConfigFile(configFile, rawText, config);
				result = { config, ...(migrationError ? { error: migrationError } : {}) };
			}
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			result = {
				config: cloneDefaultConfig(),
				error: `Failed to parse ${configFile}: ${message}`,
			};
		}
	}

	cachedConfigFile = configFile;
	cachedConfigFingerprint = getConfigFingerprint(configFile);
	cachedConfigResult = cloneLoadResult(result);
	return result;
}

export function saveToolDisplayConfig(config: ToolDisplayConfig, configFile = CONFIG_FILE): ConfigSaveResult {
	const normalized = normalizeToolDisplayConfig(config);

	try {
		writeConfigAtomically(configFile, serializeToolDisplayConfigV2(normalized));
		cachedConfigFile = undefined;
		cachedConfigFingerprint = undefined;
		cachedConfigResult = undefined;
		return { success: true };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			success: false,
			error: `Failed to save ${configFile}: ${message}`,
		};
	}
}

export function getToolDisplayConfigPath(): string {
	return CONFIG_FILE;
}
