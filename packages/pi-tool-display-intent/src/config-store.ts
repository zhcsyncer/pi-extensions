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
	CUSTOM_TOOL_OUTPUT_MODES,
	CUSTOM_TOOL_OVERRIDE_KINDS,
	DEFAULT_TOOL_DISPLAY_CONFIG,
	type ConfigLoadResult,
	type ConfigSaveResult,
	type CustomToolOverrideConfig,
	DIFF_INDICATOR_MODES,
	DIFF_VIEW_MODES,
	RESULT_DISPLAY_MODES,
	TOOL_CALL_STYLES,
	TOOL_DISPLAY_CONFIG_SCHEMA_URL,
	TOOL_DISPLAY_CONFIG_VERSION,
	TOOL_INTENT_LANGUAGES,
	type ToolDisplayConfig,
	type ToolOverrideOwnership,
} from "./types.js";
import {
	applyToolDisplayMode,
	detectToolDisplayMode,
	getToolResultModeConfig,
	normalizeToolDisplayMode,
} from "./presets.js";
import { toRecord } from "./tool-metadata.js";

const CONFIG_DIR = join(resolvePiAgentDir(), "extensions", "pi-tool-display-intent");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");
const LEGACY_BACKUP_FILE_NAME = "config.legacy.json";

interface LegacyToolDisplayConfigSource extends Record<string, unknown> {
	displaySummary?: unknown;
	registerReadToolOverride?: unknown;
	previewLines?: unknown;
	bashCollapsedLines?: unknown;
	expandedPreviewMaxLines?: unknown;
	diffCollapsedLines?: unknown;
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

function hasOwn(source: Record<string, unknown>, key: string): boolean {
	return Object.prototype.hasOwnProperty.call(source, key);
}

function toReadOutputMode(value: unknown): ToolDisplayConfig["readOutputMode"] {
	return value === "summary" || value === "preview" || value === "hidden"
		? value
		: DEFAULT_TOOL_DISPLAY_CONFIG.readOutputMode;
}

function toSearchOutputMode(value: unknown): ToolDisplayConfig["searchOutputMode"] {
	if (value === "summary") return "count";
	return value === "count" || value === "preview" || value === "hidden"
		? value
		: DEFAULT_TOOL_DISPLAY_CONFIG.searchOutputMode;
}

function toMcpOutputMode(value: unknown): ToolDisplayConfig["mcpOutputMode"] {
	return value === "summary" || value === "preview" || value === "hidden"
		? value
		: DEFAULT_TOOL_DISPLAY_CONFIG.mcpOutputMode;
}

function toBashOutputMode(value: unknown): ToolDisplayConfig["bashOutputMode"] {
	if (value === "opencode" || value === "inline") return "preview";
	return value === "summary" || value === "preview"
		? value
		: DEFAULT_TOOL_DISPLAY_CONFIG.bashOutputMode;
}

function toToolCallStyle(value: unknown): ToolDisplayConfig["toolCallStyle"] {
	return TOOL_CALL_STYLES.includes(value as ToolDisplayConfig["toolCallStyle"])
		? (value as ToolDisplayConfig["toolCallStyle"])
		: DEFAULT_TOOL_DISPLAY_CONFIG.toolCallStyle;
}

function toDiffViewMode(value: unknown): ToolDisplayConfig["diffViewMode"] {
	if (value === "stacked") return "unified";
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
		Object.entries(overrides).map(([toolName, override]) => [toolName, { ...override }]),
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

function cloneConfig(config: ToolDisplayConfig): ToolDisplayConfig {
	return normalizeToolDisplayConfig(config);
}

function cloneLoadResult(result: ConfigLoadResult): ConfigLoadResult {
	return { ...result, config: cloneConfig(result.config) };
}

let cachedConfigFile: string | undefined;
let cachedConfigFingerprint: string | undefined;
let cachedConfigResult: ConfigLoadResult | undefined;

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

function normalizeV2ToolOwnership(rawTools: unknown): ToolOverrideOwnership {
	const tools = toRecord(rawTools);
	const passthrough = new Set(
		Array.isArray(tools.passthrough)
			? tools.passthrough.filter((name): name is string => typeof name === "string")
			: [],
	);
	const ownership = { ...DEFAULT_TOOL_DISPLAY_CONFIG.registerToolOverrides };
	for (const toolName of BUILT_IN_TOOL_OVERRIDE_NAMES) {
		ownership[toolName] = !passthrough.has(toolName);
	}
	return ownership;
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
		return rawEntry ? { kind: "generic", outputMode: "summary" } : undefined;
	}
	if (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry)) {
		return undefined;
	}
	const source = toRecord(rawEntry);
	if (source.enabled === false) {
		return undefined;
	}
	return {
		kind: toCustomToolOverrideKind(source.kind ?? source.renderer),
		outputMode: toCustomToolOutputMode(source.outputMode ?? source.result ?? source.mode),
	};
}

function normalizeCustomToolOverrides(rawOverrides: unknown): Record<string, CustomToolOverrideConfig> {
	const source = toRecord(rawOverrides);
	const overrides: Record<string, CustomToolOverrideConfig> = {};
	for (const [rawToolName, rawEntry] of Object.entries(source)) {
		const toolName = rawToolName.trim();
		if (!toolName || isBuiltInToolOverrideName(toolName)) continue;
		const normalized = normalizeCustomToolOverrideEntry(rawEntry);
		if (normalized) overrides[toolName] = normalized;
	}
	return overrides;
}

interface LegacyResultResolution {
	mode: ToolDisplayConfig["resultMode"];
	exact: boolean;
}

function resolveLegacyResultMode(source: Record<string, unknown>): LegacyResultResolution {
	if (hasOwn(source, "resultMode")) {
		return { mode: normalizeToolDisplayMode(source.resultMode), exact: true };
	}
	const hasExplicitToolModes =
		hasOwn(source, "readOutputMode") ||
		hasOwn(source, "searchOutputMode") ||
		hasOwn(source, "mcpOutputMode") ||
		hasOwn(source, "bashOutputMode");
	if (!hasExplicitToolModes && hasOwn(source, "resultProfile")) {
		return {
			mode: normalizeToolDisplayMode(source.resultProfile),
			exact: true,
		};
	}

	const effective = {
		readOutputMode: toReadOutputMode(source.readOutputMode),
		searchOutputMode: toSearchOutputMode(source.searchOutputMode),
		mcpOutputMode: toMcpOutputMode(source.mcpOutputMode),
		bashOutputMode: toBashOutputMode(source.bashOutputMode),
	};
	const candidate = {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		...effective,
	};
	const detected = detectToolDisplayMode(candidate);
	if (detected !== "custom") {
		return { mode: detected, exact: true };
	}

	const values = Object.values(effective);
	if (values.includes("preview")) return { mode: "preview", exact: false };
	if (values.includes("summary") || values.includes("count")) {
		return { mode: "summary", exact: false };
	}
	return { mode: "compact", exact: false };
}

export function normalizeToolDisplayConfig(raw: unknown): ToolDisplayConfig {
	const source = toRecord(raw) as LegacyToolDisplayConfigSource;
	const rawToolIntent = hasOwn(source, "toolIntent") ? source.toolIntent : source.displaySummary;
	const resultResolution = resolveLegacyResultMode(source);
	const resultConfig = getToolResultModeConfig(resultResolution.mode);

	return {
		debug: toBoolean(source.debug, DEFAULT_TOOL_DISPLAY_CONFIG.debug),
		registerToolOverrides: normalizeToolOverrideOwnership(
			source.registerToolOverrides,
			source.registerReadToolOverride,
		),
		customToolOverrides: normalizeCustomToolOverrides(source.customToolOverrides),
		toolIntent: normalizeToolIntentConfig(rawToolIntent),
		toolCallStyle: toToolCallStyle(source.toolCallStyle),
		bashCommandPreviewRows: clampNumber(
			source.bashCommandPreviewRows,
			1,
			8,
			DEFAULT_TOOL_DISPLAY_CONFIG.bashCommandPreviewRows,
		),
		resultMode: resultResolution.mode,
		...resultConfig,
		enableNativeUserMessageBox: toBoolean(
			source.enableNativeUserMessageBox,
			DEFAULT_TOOL_DISPLAY_CONFIG.enableNativeUserMessageBox,
		),
		enableThinkingLabel: toBoolean(
			source.enableThinkingLabel,
			DEFAULT_TOOL_DISPLAY_CONFIG.enableThinkingLabel,
		),
		previewRows: clampNumber(
			source.previewRows ?? source.previewLines,
			1,
			80,
			DEFAULT_TOOL_DISPLAY_CONFIG.previewRows,
		),
		expandedPreviewMaxRows: clampNumber(
			source.expandedPreviewMaxRows ?? source.expandedPreviewMaxLines,
			0,
			20_000,
			DEFAULT_TOOL_DISPLAY_CONFIG.expandedPreviewMaxRows,
		),
		diffViewMode: toDiffViewMode(source.diffViewMode),
		diffIndicatorMode: toDiffIndicatorMode(source.diffIndicatorMode),
		diffSplitMinWidth: clampNumber(
			source.diffSplitMinWidth,
			70,
			240,
			DEFAULT_TOOL_DISPLAY_CONFIG.diffSplitMinWidth,
		),
		diffCollapsedRows: clampNumber(
			source.diffCollapsedRows ?? source.diffCollapsedLines,
			4,
			240,
			DEFAULT_TOOL_DISPLAY_CONFIG.diffCollapsedRows,
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
}

function validateKnownKeys(
	source: Record<string, unknown>,
	allowed: readonly string[],
	path: string,
	errors: string[],
): void {
	const allowedKeys = new Set(allowed);
	for (const key of Object.keys(source)) {
		if (!allowedKeys.has(key)) errors.push(`${path}${key}: unknown setting`);
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
	validateKnownKeys(source, ["$schema", "version", "intent", "toolCalls", "results", "diff", "transcript", "tools", "advanced"], "", errors);
	if (hasOwn(source, "$schema") && typeof source.$schema !== "string") {
		errors.push("$schema: expected string");
	}

	const intent = getV2Section(source, "intent", errors);
	validateKnownKeys(intent, ["enabled", "language", "maxLength"], "intent.", errors);
	validateOptionalBoolean(intent, "enabled", "intent.", errors);
	validateOptionalEnum(intent, "language", TOOL_INTENT_LANGUAGES, "intent.", errors);
	validateOptionalInteger(intent, "maxLength", 16, 256, "intent.", errors);

	const toolCalls = getV2Section(source, "toolCalls", errors);
	validateKnownKeys(toolCalls, ["style", "bashCommandPreviewRows"], "toolCalls.", errors);
	validateOptionalEnum(toolCalls, "style", TOOL_CALL_STYLES, "toolCalls.", errors);
	validateOptionalInteger(toolCalls, "bashCommandPreviewRows", 1, 8, "toolCalls.", errors);

	if (!hasOwn(source, "results")) errors.push("results: required section");
	const results = getV2Section(source, "results", errors);
	validateKnownKeys(results, ["mode", "previewRows"], "results.", errors);
	if (!hasOwn(results, "mode")) errors.push("results.mode: required setting");
	validateOptionalEnum(results, "mode", RESULT_DISPLAY_MODES, "results.", errors);
	validateOptionalInteger(results, "previewRows", 1, 80, "results.", errors);

	const diff = getV2Section(source, "diff", errors);
	validateKnownKeys(diff, ["layout", "indicators", "splitMinWidth", "collapsedRows", "wordWrap"], "diff.", errors);
	validateOptionalEnum(diff, "layout", DIFF_VIEW_MODES, "diff.", errors);
	validateOptionalEnum(diff, "indicators", DIFF_INDICATOR_MODES, "diff.", errors);
	validateOptionalInteger(diff, "splitMinWidth", 70, 240, "diff.", errors);
	validateOptionalInteger(diff, "collapsedRows", 4, 240, "diff.", errors);
	validateOptionalBoolean(diff, "wordWrap", "diff.", errors);

	const transcript = getV2Section(source, "transcript", errors);
	validateKnownKeys(transcript, ["userMessageStyle", "thinkingLabel"], "transcript.", errors);
	validateOptionalEnum(transcript, "userMessageStyle", ["boxed", "default"], "transcript.", errors);
	validateOptionalBoolean(transcript, "thinkingLabel", "transcript.", errors);

	const tools = getV2Section(source, "tools", errors);
	validateKnownKeys(tools, ["passthrough", "custom"], "tools.", errors);
	if (hasOwn(tools, "passthrough")) {
		if (!Array.isArray(tools.passthrough)) {
			errors.push("tools.passthrough: expected array");
		} else {
			const seen = new Set<unknown>();
			for (const [index, toolName] of tools.passthrough.entries()) {
				if (!(BUILT_IN_TOOL_OVERRIDE_NAMES as readonly unknown[]).includes(toolName)) {
					errors.push(`tools.passthrough.${index}: unknown built-in tool`);
				} else if (seen.has(toolName)) {
					errors.push(`tools.passthrough.${index}: duplicate built-in tool`);
				}
				seen.add(toolName);
			}
		}
	}
	const custom = getV2Section(tools, "custom", errors, "tools.custom");
	for (const [toolName, rawEntry] of Object.entries(custom)) {
		if (!toolName.trim() || toolName.trim() !== toolName || isBuiltInToolOverrideName(toolName)) {
			errors.push(`tools.custom.${toolName}: expected a non-empty trimmed non-built-in tool name`);
		}
		const entry = toRecord(rawEntry);
		if (Object.keys(entry).length === 0 && (!rawEntry || typeof rawEntry !== "object" || Array.isArray(rawEntry))) {
			errors.push(`tools.custom.${toolName}: expected object`);
			continue;
		}
		validateKnownKeys(entry, ["renderer", "mode"], `tools.custom.${toolName}.`, errors);
		validateOptionalEnum(entry, "renderer", CUSTOM_TOOL_OVERRIDE_KINDS, `tools.custom.${toolName}.`, errors);
		validateOptionalEnum(entry, "mode", CUSTOM_TOOL_OUTPUT_MODES, `tools.custom.${toolName}.`, errors);
	}

	const advanced = getV2Section(source, "advanced", errors);
	validateKnownKeys(advanced, ["expandedRows", "truncationHints", "rtkCompactionHints", "debug"], "advanced.", errors);
	validateOptionalInteger(advanced, "expandedRows", 0, 20_000, "advanced.", errors);
	validateOptionalBoolean(advanced, "truncationHints", "advanced.", errors);
	validateOptionalBoolean(advanced, "rtkCompactionHints", "advanced.", errors);
	validateOptionalBoolean(advanced, "debug", "advanced.", errors);
	return errors;
}

function normalizeToolDisplayConfigV2(raw: unknown): ToolDisplayConfig {
	const source = toRecord(raw);
	const results = toRecord(source.results);
	const diff = toRecord(source.diff);
	const transcript = toRecord(source.transcript);
	const tools = toRecord(source.tools);
	const advanced = toRecord(source.advanced);
	const toolCalls = toRecord(source.toolCalls);
	const mode = normalizeToolDisplayMode(results.mode);

	return normalizeToolDisplayConfig({
		debug: advanced.debug,
		resultMode: mode,
		registerToolOverrides: normalizeV2ToolOwnership(tools),
		customToolOverrides: tools.custom,
		toolIntent: source.intent,
		toolCallStyle: toolCalls.style,
		bashCommandPreviewRows: toolCalls.bashCommandPreviewRows,
		enableNativeUserMessageBox:
			transcript.userMessageStyle === "default"
				? false
				: transcript.userMessageStyle === "boxed"
					? true
					: DEFAULT_TOOL_DISPLAY_CONFIG.enableNativeUserMessageBox,
		enableThinkingLabel: transcript.thinkingLabel,
		previewRows: results.previewRows,
		expandedPreviewMaxRows: advanced.expandedRows,
		diffViewMode: diff.layout,
		diffIndicatorMode: diff.indicators,
		diffSplitMinWidth: diff.splitMinWidth,
		diffCollapsedRows: diff.collapsedRows,
		diffWordWrap: diff.wordWrap,
		showTruncationHints: advanced.truncationHints,
		showRtkCompactionHints: advanced.rtkCompactionHints,
	});
}

function assignSection(target: Record<string, unknown>, key: string, section: Record<string, unknown>): void {
	if (Object.keys(section).length > 0) target[key] = section;
}

export function serializeToolDisplayConfigV2(rawConfig: ToolDisplayConfig): Record<string, unknown> {
	const config = normalizeToolDisplayConfig(rawConfig);
	const defaults = DEFAULT_TOOL_DISPLAY_CONFIG;
	const output: Record<string, unknown> = {
		$schema: TOOL_DISPLAY_CONFIG_SCHEMA_URL,
		version: TOOL_DISPLAY_CONFIG_VERSION,
	};

	const intent: Record<string, unknown> = {};
	if (config.toolIntent.enabled !== defaults.toolIntent.enabled) intent.enabled = config.toolIntent.enabled;
	if (config.toolIntent.language !== defaults.toolIntent.language) intent.language = config.toolIntent.language;
	if (config.toolIntent.maxLength !== defaults.toolIntent.maxLength) intent.maxLength = config.toolIntent.maxLength;
	assignSection(output, "intent", intent);

	const toolCalls: Record<string, unknown> = {};
	if (config.toolCallStyle !== defaults.toolCallStyle) toolCalls.style = config.toolCallStyle;
	if (config.bashCommandPreviewRows !== defaults.bashCommandPreviewRows) {
		toolCalls.bashCommandPreviewRows = config.bashCommandPreviewRows;
	}
	assignSection(output, "toolCalls", toolCalls);

	const results: Record<string, unknown> = { mode: config.resultMode };
	if (config.previewRows !== defaults.previewRows) results.previewRows = config.previewRows;
	output.results = results;

	const diff: Record<string, unknown> = {};
	if (config.diffViewMode !== defaults.diffViewMode) diff.layout = config.diffViewMode;
	if (config.diffIndicatorMode !== defaults.diffIndicatorMode) diff.indicators = config.diffIndicatorMode;
	if (config.diffSplitMinWidth !== defaults.diffSplitMinWidth) diff.splitMinWidth = config.diffSplitMinWidth;
	if (config.diffCollapsedRows !== defaults.diffCollapsedRows) diff.collapsedRows = config.diffCollapsedRows;
	if (config.diffWordWrap !== defaults.diffWordWrap) diff.wordWrap = config.diffWordWrap;
	assignSection(output, "diff", diff);

	const transcript: Record<string, unknown> = {};
	if (config.enableNativeUserMessageBox !== defaults.enableNativeUserMessageBox) {
		transcript.userMessageStyle = config.enableNativeUserMessageBox ? "boxed" : "default";
	}
	if (config.enableThinkingLabel !== defaults.enableThinkingLabel) {
		transcript.thinkingLabel = config.enableThinkingLabel;
	}
	assignSection(output, "transcript", transcript);

	const tools: Record<string, unknown> = {};
	const passthrough = BUILT_IN_TOOL_OVERRIDE_NAMES.filter(
		(toolName) => !config.registerToolOverrides[toolName],
	);
	if (passthrough.length > 0) tools.passthrough = passthrough;
	if (Object.keys(config.customToolOverrides).length > 0) {
		tools.custom = Object.fromEntries(
			Object.entries(config.customToolOverrides).map(([toolName, override]) => [
				toolName,
				{ renderer: override.kind, mode: override.outputMode },
			]),
		);
	}
	assignSection(output, "tools", tools);

	const advanced: Record<string, unknown> = {};
	if (config.expandedPreviewMaxRows !== defaults.expandedPreviewMaxRows) {
		advanced.expandedRows = config.expandedPreviewMaxRows;
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

function buildLegacyMigrationNotice(
	source: Record<string, unknown>,
	config: ToolDisplayConfig,
): string | undefined {
	const messages: string[] = [];
	if (hasOwn(source, "bashCollapsedLines") || hasOwn(source, "bashCollapsedRows")) {
		messages.push(
			`bashCollapsedLines was removed; adjust results.previewRows (currently ${config.previewRows}) if needed`,
		);
	}
	if (source.enabled === false) {
		messages.push("extension.enabled was removed; disable the package through Pi settings if needed");
	}
	if (!resolveLegacyResultMode(source).exact) {
		messages.push(`per-tool result settings were consolidated to results.mode=${config.resultMode}`);
	}
	return messages.length > 0
		? `tool-display-intent migrated its config: ${messages.join("; ")}`
		: undefined;
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
			throw new Error("v2 migration changed the normalized configuration");
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
			const parsed = JSON.parse(rawText) as unknown;
			if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
				throw new Error("root: expected object");
			}
			const source = parsed as Record<string, unknown>;
			if (hasOwn(source, "version")) {
				if (source.version !== TOOL_DISPLAY_CONFIG_VERSION) {
					result = {
						config: cloneDefaultConfig(),
						error: `Unsupported tool display config version in ${configFile}: ${String(source.version)}`,
					};
				} else {
					const validationErrors = validateToolDisplayConfigV2(source);
					result = validationErrors.length > 0
						? {
							config: cloneDefaultConfig(),
							error: `Invalid tool display v2 config in ${configFile}: ${validationErrors.join("; ")}`,
						}
						: { config: normalizeToolDisplayConfigV2(source) };
				}
			} else {
				const config = normalizeToolDisplayConfig(source);
				const notice = buildLegacyMigrationNotice(source, config);
				const migrationError = migrateLegacyConfigFile(configFile, rawText, config);
				result = {
					config,
					...(migrationError ? { error: migrationError } : {}),
					...(!migrationError && notice ? { notice } : {}),
				};
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
	if (cachedConfigResult.notice) {
		cachedConfigResult.notice = undefined;
	}
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
		return { success: false, error: `Failed to save ${configFile}: ${message}` };
	}
}

export function getToolDisplayConfigPath(): string {
	return CONFIG_FILE;
}
