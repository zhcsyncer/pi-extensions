/**
 * recap extension
 *
 * - Generate a recent activity recap. This is NOT compaction.
 * - Optionally apply the generated title to the Pi session name.
 * - Optionally sync Pi session name to the nearest terminal multiplexer.
 *
 * Config:
 *   $PI_CODING_AGENT_DIR/extension-data/pi-recap/config.json
 *   .pi/extension-data/pi-recap/config.json (trusted projects only)
 */

import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
	type Theme,
} from "@earendil-works/pi-coding-agent";
import { CancellableLoader, Container, type SelectItem, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import {
	editorSubmenu,
	filterableSelect,
	presetOrCustomPicker,
} from "./recap-picker.ts";
import {
	recapOutputWarning,
	resolveRecapOutput,
	type RecapTitleSource,
} from "./recap-output.ts";
import {
	migrateMultiplexerConfig,
	MultiplexerManager,
	type MultiplexerConfig,
	type MultiplexerHooks,
	type MultiplexerNameContext,
} from "./multiplexer.ts";

const CUSTOM_TYPE = "recap";
const WIDGET_KEY = "recap";
const LEGACY_STATUS_KEY = "recap";

export type RecapReason = "manual" | "auto";
export type TitleApplyPolicy = "never" | "if-empty" | "if-empty-or-auto" | "always";
type WidgetPlacement = "aboveEditor" | "belowEditor";

export type RecapConfig = {
	recap: {
		enabled: boolean;
		auto: boolean;
		manualCommand: boolean;
		idleAfterTurnMs: number;
		minSessionTurns: number;
		neverTwiceInARow: boolean;
		model: "current" | string;
		fallbackToCurrentModel: boolean;
		maxRecentChars: number;
		maxTokens: number;
		language: string;
	};
	display: {
		widgetPlacement: WidgetPlacement;
	};
	title: {
		generate: boolean;
		applyToSessionName: boolean;
		applyPolicy: TitleApplyPolicy;
		maxLength: number;
	};
	multiplexer: MultiplexerConfig;
};

export type RecapEntryData = {
	recap: string;
	title?: string;
	titleSource?: RecapTitleSource;
	reason: RecapReason;
	model?: string;
	source: {
		fromEntryId?: string;
		toEntryId?: string;
	};
	generatedAt: number;
	appliedSessionName: boolean;
	sessionNamePolicy: TitleApplyPolicy;
};

export const DEFAULT_CONFIG: RecapConfig = {
	recap: {
		enabled: true,
		auto: true,
		manualCommand: true,
		idleAfterTurnMs: 3 * 60_000,
		minSessionTurns: 3,
		neverTwiceInARow: true,
		model: "current",
		fallbackToCurrentModel: true,
		maxRecentChars: 20_000,
		maxTokens: 300,
		language: "auto",
	},
	display: {
		widgetPlacement: "aboveEditor",
	},
	title: {
		generate: true,
		applyToSessionName: false,
		applyPolicy: "if-empty-or-auto",
		maxLength: 50,
	},
	multiplexer: {
		enabled: true,
		template: "π {session} · {project}",
		maxLength: 48,
		restoreOnShutdown: true,
	},
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function deepMerge<T extends Record<string, unknown>>(base: T, override: unknown): T {
	if (!isRecord(override)) return { ...base };

	const result: Record<string, unknown> = { ...base };
	for (const [key, value] of Object.entries(override)) {
		const current = result[key];
		if (isRecord(current) && isRecord(value)) {
			result[key] = deepMerge(current, value);
		} else {
			result[key] = value;
		}
	}
	return result as T;
}

type ConfigMigration = {
	value: unknown;
	changed: boolean;
	dropped: string[];
};

const CONFIG_FIELDS: Record<string, ReadonlySet<string>> = {
	recap: new Set(["enabled", "auto", "manualCommand", "idleAfterTurnMs", "minSessionTurns", "neverTwiceInARow", "model", "fallbackToCurrentModel", "maxRecentChars", "maxTokens", "language"]),
	display: new Set(["widgetPlacement"]),
	title: new Set(["generate", "applyToSessionName", "applyPolicy", "maxLength"]),
	multiplexer: new Set(["enabled", "template", "maxLength", "restoreOnShutdown"]),
};
const emittedMigrationNotices = new Set<string>();

function stripUnknownConfig(value: unknown): { value: unknown; dropped: string[] } {
	if (!isRecord(value)) throw new Error("the root value must be a JSON object");
	const result: Record<string, unknown> = {};
	const dropped: string[] = [];
	for (const [section, sectionValue] of Object.entries(value)) {
		const fields = CONFIG_FIELDS[section];
		if (!fields) {
			dropped.push(section);
			continue;
		}
		if (!isRecord(sectionValue)) {
			dropped.push(section);
			continue;
		}
		const nextSection: Record<string, unknown> = {};
		for (const [key, fieldValue] of Object.entries(sectionValue)) {
			if (fields.has(key)) nextSection[key] = fieldValue;
			else dropped.push(`${section}.${key}`);
		}
		result[section] = nextSection;
	}
	return { value: result, dropped };
}

function migrateLegacyConfig(value: unknown): ConfigMigration {
	const multiplexerMigration = migrateMultiplexerConfig(value);
	const stripped = stripUnknownConfig(multiplexerMigration.value);
	return {
		value: stripped.value,
		changed: multiplexerMigration.changed || stripped.dropped.length > 0,
		dropped: stripped.dropped,
	};
}

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

async function pathExists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

export function getGlobalConfigPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "extension-data", "pi-recap", "config.json");
}

export function getLegacyGlobalConfigPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "recap.json");
}

export function getProjectConfigPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "extension-data", "pi-recap", "config.json");
}

export function getLegacyProjectConfigPath(cwd: string): string {
	return path.join(cwd, CONFIG_DIR_NAME, "recap.json");
}

async function writeJsonConfig(file: string, value: unknown): Promise<void> {
	const directory = path.dirname(file);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = path.join(directory, `.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, file);
		await chmod(file, 0o600);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function withMigrationLock<T>(directory: string, fn: () => Promise<T>): Promise<T> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const lockPath = path.join(directory, ".config-migration.lock");
	const deadline = Date.now() + 2_000;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	while (!handle) {
		try {
			handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			try {
				if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) {
					await unlink(lockPath);
					continue;
				}
			} catch (statError) {
				if (isRecord(statError) && statError.code === "ENOENT") continue;
				throw statError;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockPath}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		return await fn();
	} finally {
		await handle.close();
		await rm(lockPath, { force: true });
	}
}

function notifyMigration(ctx: ExtensionContext, message: string): void {
	if (emittedMigrationNotices.has(message)) return;
	emittedMigrationNotices.add(message);
	if (ctx.hasUI === false) console.warn(message);
	else ctx.ui.notify(message, "warning");
}

function droppedSummary(dropped: readonly string[]): string {
	return dropped.length > 0 ? ` Dropped unmappable fields: ${dropped.join(", ")}.` : "";
}

async function saveGlobalConfig(config: RecapConfig): Promise<void> {
	await writeJsonConfig(getGlobalConfigPath(), config);
}

async function loadConfigSource(target: string, legacy: string, scope: "global" | "project", ctx: ExtensionContext): Promise<unknown | undefined> {
	let targetValue: unknown | undefined;
	try {
		targetValue = await readJsonIfExists(target);
	} catch (error) {
		notifyMigration(ctx, `Invalid ${scope} Recap config at ${target}: ${error instanceof Error ? error.message : String(error)}. The file was preserved.`);
		return undefined;
	}
	if (targetValue !== undefined) {
		try {
			let migration = migrateLegacyConfig(targetValue);
			if (migration.changed) {
				migration = await withMigrationLock(path.dirname(target), async () => {
					const current = migrateLegacyConfig(await readJsonIfExists(target));
					if (current.changed) await writeJsonConfig(target, current.value);
					return current;
				});
				notifyMigration(ctx, `Upgraded ${scope} Recap config at ${target}.${droppedSummary(migration.dropped)}`);
			}
			try {
				if (await pathExists(legacy)) notifyMigration(ctx, `Ignored conflicting legacy ${scope} Recap config at ${legacy}; canonical config is ${target}.`);
			} catch (error) {
				notifyMigration(ctx, `Could not inspect legacy ${scope} Recap config at ${legacy}: ${error instanceof Error ? error.message : String(error)}.`);
			}
			return migration.value;
		} catch (error) {
			notifyMigration(ctx, `Failed to upgrade ${scope} Recap config at ${target}: ${error instanceof Error ? error.message : String(error)}.`);
			return undefined;
		}
	}
	let legacyValue: unknown | undefined;
	try {
		legacyValue = await readJsonIfExists(legacy);
	} catch (error) {
		notifyMigration(ctx, `Invalid legacy ${scope} Recap config at ${legacy}: ${error instanceof Error ? error.message : String(error)}. The file was preserved.`);
		return undefined;
	}
	if (legacyValue === undefined) return undefined;
	try {
		return await withMigrationLock(path.dirname(target), async () => {
			const racedTarget = await readJsonIfExists(target);
			if (racedTarget !== undefined) return migrateLegacyConfig(racedTarget).value;
			const migration = migrateLegacyConfig(legacyValue);
			await writeJsonConfig(target, migration.value);
			const verified = migrateLegacyConfig(await readJsonIfExists(target)).value;
			await unlink(legacy);
			notifyMigration(ctx, `Migrated ${scope} Recap config from ${legacy} to ${target}.${droppedSummary(migration.dropped)}`);
			return verified;
		});
	} catch (error) {
		notifyMigration(ctx, `Failed to migrate ${scope} Recap config from ${legacy} to ${target}: ${error instanceof Error ? error.message : String(error)}. The legacy file was preserved.`);
		try {
			return migrateLegacyConfig(await readJsonIfExists(legacy)).value;
		} catch {
			return undefined;
		}
	}
}

export async function loadRecapConfig(ctx: ExtensionContext): Promise<RecapConfig> {
	let config = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, {}) as RecapConfig;

	const globalConfig = await loadConfigSource(getGlobalConfigPath(), getLegacyGlobalConfigPath(), "global", ctx);
	config = deepMerge(config as unknown as Record<string, unknown>, globalConfig) as RecapConfig;

	if (ctx.isProjectTrusted()) {
		const projectConfig = await loadConfigSource(getProjectConfigPath(ctx.cwd), getLegacyProjectConfigPath(ctx.cwd), "project", ctx);
		config = deepMerge(config as unknown as Record<string, unknown>, projectConfig) as RecapConfig;
	}

	return normalizeConfig(config);
}

function normalizeConfig(config: RecapConfig): RecapConfig {
	const normalized: RecapConfig = {
		recap: {
			...DEFAULT_CONFIG.recap,
			...config.recap,
			idleAfterTurnMs: positiveNumber(config.recap?.idleAfterTurnMs, DEFAULT_CONFIG.recap.idleAfterTurnMs),
			minSessionTurns: Math.max(0, Math.floor(positiveNumber(config.recap?.minSessionTurns, DEFAULT_CONFIG.recap.minSessionTurns))),
			maxRecentChars: positiveNumber(config.recap?.maxRecentChars, DEFAULT_CONFIG.recap.maxRecentChars),
			maxTokens: positiveNumber(config.recap?.maxTokens, DEFAULT_CONFIG.recap.maxTokens),
		},
		display: {
			...DEFAULT_CONFIG.display,
			...config.display,
			widgetPlacement: config.display?.widgetPlacement === "belowEditor" ? "belowEditor" : "aboveEditor",
		},
		title: {
			...DEFAULT_CONFIG.title,
			...config.title,
			applyPolicy: normalizeTitlePolicy(config.title?.applyPolicy),
			maxLength: positiveNumber(config.title?.maxLength, DEFAULT_CONFIG.title.maxLength),
		},
		multiplexer: {
			...DEFAULT_CONFIG.multiplexer,
			...config.multiplexer,
			maxLength: positiveNumber(config.multiplexer?.maxLength, DEFAULT_CONFIG.multiplexer.maxLength),
		},
	};

	// `interactiveOnly` existed in 0.1.0 but recap is now always TUI-only.
	delete (normalized.recap as Record<string, unknown>).interactiveOnly;
	return normalized;
}

function positiveNumber(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : fallback;
}

function normalizeTitlePolicy(value: unknown): TitleApplyPolicy {
	if (value === "never" || value === "if-empty" || value === "if-empty-or-auto" || value === "always") return value;
	return DEFAULT_CONFIG.title.applyPolicy;
}

function currentSessionName(pi: ExtensionAPI, ctx: ExtensionContext): string | undefined {
	return pi.getSessionName() ?? ctx.sessionManager.getSessionName();
}

function countUserTurns(entries: SessionEntry[]): number {
	return entries.filter((entry) => entry.type === "message" && entry.message.role === "user").length;
}

function isRecapEntry(entry: SessionEntry): entry is Extract<SessionEntry, { type: "custom" }> & { data?: RecapEntryData } {
	return entry.type === "custom" && entry.customType === CUSTOM_TYPE;
}

function getLastRecap(entries: SessionEntry[]): { entry: SessionEntry; data: RecapEntryData } | undefined {
	for (let i = entries.length - 1; i >= 0; i--) {
		const entry = entries[i];
		if (!entry || !isRecapEntry(entry) || !isRecord(entry.data)) continue;
		const data = entry.data as Partial<RecapEntryData>;
		if (typeof data.recap !== "string" || typeof data.generatedAt !== "number") continue;
		return { entry, data: data as RecapEntryData };
	}
	return undefined;
}

function textFromContent(content: unknown): string {
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";

	const parts: string[] = [];
	for (const item of content) {
		if (!isRecord(item)) continue;
		if (item.type === "text" && typeof item.text === "string") {
			parts.push(item.text);
		} else if (item.type === "toolCall" && typeof item.name === "string") {
			parts.push(`[tool:${item.name} ${JSON.stringify(item.arguments ?? {})}]`);
		} else if (item.type === "image") {
			parts.push("[image]");
		}
	}
	return parts.join("\n");
}

function truncateText(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, Math.max(0, maxChars - 32))}\n[truncated ${text.length - maxChars} chars]`;
}

function entryToRecapText(entry: SessionEntry): string | undefined {
	if (entry.type === "custom") return undefined;
	if (entry.type === "session_info") return undefined;
	if (entry.type === "label") return undefined;

	if (entry.type === "compaction") {
		return `Compaction summary:\n${truncateText(entry.summary, 2_000)}`;
	}

	if (entry.type === "branch_summary") {
		return `Branch summary:\n${truncateText(entry.summary, 2_000)}`;
	}

	if (entry.type === "model_change") {
		return `Model changed to ${entry.provider}/${entry.modelId}`;
	}

	if (entry.type === "thinking_level_change") {
		return `Thinking level changed to ${entry.thinkingLevel}`;
	}

	if (entry.type !== "message") return undefined;

	const message = entry.message;
	if (message.role === "user") {
		const text = truncateText(textFromContent(message.content).trim(), 4_000);
		return text ? `User:\n${text}` : undefined;
	}

	if (message.role === "assistant") {
		const text = truncateText(textFromContent(message.content).trim(), 4_000);
		return text ? `Assistant:\n${text}` : undefined;
	}

	if (message.role === "toolResult") {
		const text = truncateText(textFromContent(message.content).trim(), 2_000);
		return `Tool result (${message.toolName}${message.isError ? ", error" : ""}):\n${text || "[no text output]"}`;
	}

	if (message.role === "bashExecution") {
		const output = truncateText(message.output?.trim() ?? "", 2_000);
		return `User bash (${message.exitCode ?? "unknown"}): ${message.command}\n${output}`;
	}

	if (message.role === "custom") {
		const text = truncateText(textFromContent(message.content).trim(), 2_000);
		return text ? `Custom message (${message.customType}):\n${text}` : undefined;
	}

	return undefined;
}

function buildRecentConversation(entries: SessionEntry[], lastRecapSourceToEntryId: string | undefined, maxChars: number) {
	let startIndex = 0;
	if (lastRecapSourceToEntryId) {
		const index = entries.findIndex((entry) => entry.id === lastRecapSourceToEntryId);
		if (index >= 0) startIndex = index + 1;
	}

	const recentEntries = entries.slice(startIndex);
	const summarizable = recentEntries
		.map((entry) => ({ entry, text: entryToRecapText(entry) }))
		.filter((item): item is { entry: SessionEntry; text: string } => Boolean(item.text?.trim()));

	const fromEntryId = summarizable[0]?.entry.id;
	const toEntryId = summarizable.at(-1)?.entry.id;
	let conversation = summarizable.map((item) => item.text).join("\n\n---\n\n");

	if (conversation.length > maxChars) {
		conversation = `[Earlier recent activity omitted]\n\n${conversation.slice(-maxChars)}`;
	}

	return { conversation, fromEntryId, toEntryId, count: summarizable.length };
}

function buildSystemPrompt(config: RecapConfig): string {
	const titleInstruction = config.title.generate
		? `Also generate a short title (max ${config.title.maxLength} characters) that identifies the current task.`
		: "Set title to an empty string.";

	return [
		"You generate a recent-activity recap for a terminal coding-agent session.",
		"This is NOT a compaction summary and must not pretend to replace conversation history.",
		"Summarize only what happened in the provided recent activity.",
		"Be factual. Do not claim files were changed unless the activity shows that.",
		config.recap.language === "auto"
			? "Write the recap in the same primary language as the recent activity."
			: `Write the recap in ${config.recap.language} unless the recent activity clearly uses another language.`,
		"The recap should be one concise line. Use a short sentence; avoid bullet lists.",
		titleInstruction,
		"Return ONLY valid JSON with this shape:",
		'{"recap":"one-line recent activity recap","title":"short title"}',
	].join("\n");
}

export function resolveRecapModel(ctx: ExtensionContext, config: RecapConfig) {
	if (config.recap.model === "current") return ctx.model;

	const separator = config.recap.model.indexOf("/");
	if (separator > 0) {
		const provider = config.recap.model.slice(0, separator);
		const modelId = config.recap.model.slice(separator + 1);
		const model = ctx.modelRegistry.find(provider, modelId);
		if (model) return model;
	}

	if (!config.recap.fallbackToCurrentModel || !ctx.model) return undefined;
	ctx.ui.notify(
		`Recap model ${config.recap.model} is unavailable; falling back to the current model.`,
		"warning",
	);
	return ctx.model;
}

export type TitleApplicationInput = {
	title?: string;
	applyToSessionName: boolean;
	policy: TitleApplyPolicy;
	currentSessionName?: string;
	lastAppliedSessionName: boolean;
	lastAppliedTitle?: string;
};

export function shouldApplyTitleForPolicy(input: TitleApplicationInput): boolean {
	if (!input.applyToSessionName || !input.title) return false;
	if (input.policy === "never") return false;
	if (input.policy === "always") return true;
	if (!input.currentSessionName) return true;
	if (input.policy === "if-empty") return false;
	return Boolean(
		input.lastAppliedSessionName &&
		input.lastAppliedTitle &&
		input.currentSessionName === input.lastAppliedTitle,
	);
}

function shouldApplyTitle(title: string | undefined, pi: ExtensionAPI, ctx: ExtensionContext, config: RecapConfig, state: RecapState): boolean {
	return shouldApplyTitleForPolicy({
		title,
		applyToSessionName: config.title.applyToSessionName,
		policy: config.title.applyPolicy,
		currentSessionName: currentSessionName(pi, ctx),
		lastAppliedSessionName: state.lastAppliedSessionName,
		lastAppliedTitle: state.lastAppliedTitle,
	});
}

function formatModelName(model: NonNullable<ExtensionContext["model"]> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

const OPENCODE_HOST = "opencode.ai";

function matchesOpenCodeHost(baseUrl: string | undefined): boolean {
	if (!baseUrl) return false;
	try {
		return new URL(baseUrl).hostname === OPENCODE_HOST;
	} catch {
		return false;
	}
}

function isOpenCodeModel(model: { provider?: string; baseUrl?: string }): boolean {
	return model.provider === "opencode" || model.provider === "opencode-go" || matchesOpenCodeHost(model.baseUrl);
}

function readSessionId(ctx: ExtensionContext): string | undefined {
	const getSessionId = ctx.sessionManager.getSessionId;
	if (typeof getSessionId !== "function") return undefined;
	try {
		const sessionId = getSessionId.call(ctx.sessionManager);
		return typeof sessionId === "string" && sessionId.length > 0 ? sessionId : undefined;
	} catch {
		return undefined;
	}
}

function getOpenCodeSessionHeaders(
	model: { provider?: string; baseUrl?: string },
	sessionId: string | undefined,
): Record<string, string> | undefined {
	if (!sessionId || !isOpenCodeModel(model)) return undefined;
	return { "x-opencode-session": sessionId, "x-opencode-client": "pi" };
}

function resolveCompleteModel(ctx: ExtensionContext, completeModel: typeof complete | undefined): typeof complete {
	if (completeModel) return completeModel;
	if (typeof ctx.modelRegistry.complete === "function") {
		return (model, context, opts) => ctx.modelRegistry.complete(model, context, opts as never);
	}
	return complete;
}

export type RunRecapOptions = {
	force?: boolean;
	signal?: AbortSignal;
	showProgress?: boolean;
	completeModel?: typeof complete;
};

export async function runRecap(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: RecapConfig,
	state: RecapState,
	reason: RecapReason,
	options: RunRecapOptions = {},
): Promise<RecapEntryData | undefined> {
	const { force = false, signal, showProgress = true } = options;
	const completeModel = resolveCompleteModel(ctx, options.completeModel);
	if (state.running) return undefined;
	if (!config.recap.enabled) {
		if (reason === "manual" && ctx.mode === "tui") displayRecapError(ctx, config, "Recap is disabled by config");
		return undefined;
	}
	if (ctx.mode !== "tui") {
		if (reason === "manual" && ctx.hasUI) ctx.ui.notify("recap requires TUI mode", "warning");
		return undefined;
	}

	const entries = ctx.sessionManager.getBranch();
	if (!force && countUserTurns(entries) < config.recap.minSessionTurns) return undefined;

	const source = buildRecentConversation(entries, state.lastRecapSourceToEntryId, config.recap.maxRecentChars);
	if (!source.conversation.trim()) {
		if (reason === "manual") displayRecapError(ctx, config, "No new activity to recap");
		return undefined;
	}

	if (!force && config.recap.neverTwiceInARow && source.toEntryId && source.toEntryId === state.lastRecapSourceToEntryId) {
		return undefined;
	}

	const model = resolveRecapModel(ctx, config);
	if (!model) {
		displayRecapError(ctx, config, "No model available for recap");
		return undefined;
	}
	if (signal?.aborted) return undefined;

	const controller = reason === "auto" ? new AbortController() : undefined;
	const runSignal = signal ?? controller?.signal ?? ctx.signal;
	const run: ActiveRecapRun = {
		id: ++state.nextRunId,
		reason,
		controller,
		signal: runSignal,
	};
	let displayed = false;

	state.running = true;
	state.activeRun = run;
	if (showProgress) showRecapProgress(ctx, config);

	try {
		const sessionId = readSessionId(ctx);
		const headers = getOpenCodeSessionHeaders(model, sessionId);
		let response;
		try {
			response = await completeModel(
				model,
				{
					systemPrompt: buildSystemPrompt(config),
					messages: [
						{
							role: "user" as const,
							content: [{ type: "text" as const, text: source.conversation }],
							timestamp: Date.now(),
						},
					],
				},
				{
					maxTokens: config.recap.maxTokens,
					signal: runSignal,
					sessionId,
					...(headers ? { headers } : {}),
				},
			);
		} catch (error) {
			if (runSignal?.aborted || state.activeRun !== run) return undefined;
			displayRecapError(ctx, config, error instanceof Error ? error.message : String(error));
			displayed = true;
			return undefined;
		}

		if (!isCurrentRecapRun(state, run) || response.stopReason === "aborted") return undefined;

		const raw = response.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();
		const resolved = resolveRecapOutput(raw, {
			stopReason: response.stopReason,
			errorMessage: response.errorMessage,
			generateTitle: config.title.generate,
			titleMaxLength: config.title.maxLength,
		});
		if (!resolved.ok) {
			displayRecapError(ctx, config, resolved.error);
			displayed = true;
			return undefined;
		}

		const { recap, title, titleSource } = resolved;
		const appliedSessionName = shouldApplyTitle(title, pi, ctx, config, state);

		if (appliedSessionName && title) {
			state.applyingSessionName = true;
			pi.setSessionName(title);
			state.lastAppliedSessionName = true;
			state.lastAppliedTitle = title;
			state.applyingSessionName = false;
		}

		const data: RecapEntryData = {
			recap,
			title,
			titleSource,
			reason,
			model: formatModelName(model),
			source: {
				fromEntryId: source.fromEntryId,
				toEntryId: source.toEntryId,
			},
			generatedAt: Date.now(),
			appliedSessionName,
			sessionNamePolicy: config.title.applyPolicy,
		};

		pi.appendEntry(CUSTOM_TYPE, data);
		state.lastRecap = data;
		state.lastRecapSourceToEntryId = source.toEntryId;
		state.lastRecapAt = data.generatedAt;

		displayRecap(ctx, config, data);
		displayed = true;
		return data;
	} catch (error) {
		if (runSignal?.aborted || state.activeRun !== run) return undefined;
		throw error;
	} finally {
		if (state.activeRun === run) {
			state.activeRun = undefined;
			state.running = false;
			if (!displayed) clearRecapDisplay(ctx);
		}
	}
}

function isCurrentRecapRun(state: RecapState, run: ActiveRecapRun): boolean {
	return state.activeRun === run && !run.signal?.aborted;
}

function clearRecapDisplay(ctx: ExtensionContext) {
	// Clear the legacy footer entry when reloading from a version that supported status mode.
	ctx.ui.setStatus(LEGACY_STATUS_KEY, undefined);
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function showRecapProgress(ctx: ExtensionContext, config: RecapConfig) {
	clearRecapDisplay(ctx);
	ctx.ui.setWidget(WIDGET_KEY, ["RECAP  Generating..."], { placement: config.display.widgetPlacement });
}

function displayRecapError(ctx: ExtensionContext, config: RecapConfig, message: string) {
	if (ctx.mode !== "tui") return;
	clearRecapDisplay(ctx);
	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) =>
			new Text(
				theme.fg("muted", "RECAP  ") + theme.fg("error", theme.bold("Failed")) + "\n" + theme.fg("error", message),
				1,
				0,
			),
		{ placement: config.display.widgetPlacement },
	);
}

function displayRecapWidget(ctx: ExtensionContext, config: RecapConfig, data: RecapEntryData) {
	if (ctx.mode !== "tui") return;

	ctx.ui.setWidget(
		WIDGET_KEY,
		(_tui, theme) => {
			const title = data.title ?? "Recent activity";
			const generatedTime = new Intl.DateTimeFormat(undefined, {
				hour: "2-digit",
				minute: "2-digit",
			}).format(data.generatedAt);
			const warning = recapOutputWarning(data.titleSource);
			const text = [
				theme.fg("muted", "RECAP  ") + theme.fg("accent", theme.bold(title)),
				theme.fg("text", data.recap),
				...(warning ? [theme.fg("warning", `WARNING  ${warning}`)] : []),
				theme.fg("dim", `Generated ${generatedTime}`),
			].join("\n");

			return new Text(text, 1, 0);
		},
		{ placement: config.display.widgetPlacement },
	);
}

function displayRecap(ctx: ExtensionContext, config: RecapConfig, data: RecapEntryData) {
	clearRecapDisplay(ctx);
	displayRecapWidget(ctx, config, data);
}

function boolValue(value: boolean): string {
	return value ? "on" : "off";
}

const IDLE_MS_PRESETS = [60_000, 180_000, 300_000, 600_000];
const MIN_SESSION_TURN_PRESETS = [1, 2, 3, 5, 10];
const MAX_RECENT_CHAR_PRESETS = [10_000, 20_000, 40_000, 80_000];
const MAX_TOKEN_PRESETS = [150, 300, 500, 1000];
const TITLE_MAX_LENGTH_PRESETS = [30, 50, 80];
const MULTIPLEXER_MAX_LENGTH_PRESETS = [32, 48, 60, 80];
const LANGUAGE_PRESETS = ["auto", "en", "zh-CN"];

export function recapModelValues(
	available: ReadonlyArray<{ provider?: string; id?: string }>,
	configured: string,
): string[] {
	const values = ["current"];
	const seen = new Set(values);
	for (const model of available) {
		if (!model.provider || !model.id) continue;
		const key = `${model.provider}/${model.id}`;
		if (seen.has(key)) continue;
		seen.add(key);
		values.push(key);
	}
	if (configured && !seen.has(configured)) values.push(configured);
	return values;
}

export function formatIdleAfterTurnMs(ms: number): string {
	const minutes = ms / 60_000;
	if (Number.isInteger(minutes)) return `${minutes} min`;
	return `${Number(minutes.toFixed(2))} min`;
}

function uniqueSortedNumbers(presets: readonly number[], current: number): number[] {
	return [...new Set([...presets, current])].sort((left, right) => left - right);
}

function numberSelectItems(presets: readonly number[], current: number): SelectItem[] {
	return uniqueSortedNumbers(presets, current).map((value) => ({
		value: String(value),
		label: String(value),
	}));
}

function idleSelectItems(currentMs: number): SelectItem[] {
	return uniqueSortedNumbers(IDLE_MS_PRESETS, currentMs).map((ms) => ({
		value: String(ms),
		label: formatIdleAfterTurnMs(ms),
	}));
}

function languageSelectItems(current: string): SelectItem[] {
	const values = LANGUAGE_PRESETS.includes(current) ? [...LANGUAGE_PRESETS] : [...LANGUAGE_PRESETS, current];
	return values.filter(Boolean).map((value) => ({ value, label: value }));
}

function parsePositiveNumberValue(raw: string): string | undefined {
	const value = Number(raw.trim());
	if (!Number.isFinite(value) || value <= 0) return undefined;
	return String(Math.floor(value));
}

function parseIdleMinutesValue(raw: string): string | undefined {
	const minutes = Number(raw.trim());
	if (!Number.isFinite(minutes) || minutes <= 0) return undefined;
	return String(Math.max(1, Math.round(minutes * 60_000)));
}

function parseLanguageValue(raw: string): string | undefined {
	const value = raw.trim();
	return value.length > 0 ? value : undefined;
}

export type RecapModelOption = { provider: string; id: string; name?: string };

export type RecapSettingsOptions = {
	availableModels?: ReadonlyArray<RecapModelOption>;
	theme: Theme;
	getConfig?: () => RecapConfig;
	editor?: (title: string, prefill?: string) => Promise<string | undefined>;
};

function recapModelSelectItems(
	available: ReadonlyArray<RecapModelOption>,
	configured: string,
): SelectItem[] {
	return recapModelValues(available, configured).map((value) => {
		if (value === "current") return { value, label: "current" };
		const model = available.find((item) => `${item.provider}/${item.id}` === value);
		if (model?.name) return { value, label: `${model.name}  (${value})` };
		return { value, label: value };
	});
}

export function settingItems(config: RecapConfig, options: RecapSettingsOptions): SettingItem[] {
	const getConfig = options.getConfig ?? (() => config);
	const availableModels = options.availableModels ?? [];
	const items: SettingItem[] = [
		{
			id: "recap.enabled",
			label: "Recap enabled",
			description: "Master switch for recap generation.",
			currentValue: boolValue(config.recap.enabled),
			values: ["on", "off"],
		},
		{
			id: "recap.auto",
			label: "Auto recap",
			description: "Generate recap after an idle period following agent completion.",
			currentValue: boolValue(config.recap.auto),
			values: ["on", "off"],
		},
		{
			id: "recap.manualCommand",
			label: "Manual /recap command",
			description: "Allow generating a recap with /recap.",
			currentValue: boolValue(config.recap.manualCommand),
			values: ["on", "off"],
		},
		{
			id: "recap.idleAfterTurnMs",
			label: "Idle before auto recap",
			description: "How long to wait after the agent finishes before auto recap.",
			currentValue: formatIdleAfterTurnMs(config.recap.idleAfterTurnMs),
			submenu: (_current, done) =>
				presetOrCustomPicker(idleSelectItems(getConfig().recap.idleAfterTurnMs), options.theme, done, {
					preferredValue: String(getConfig().recap.idleAfterTurnMs),
					custom: {
						title: "Idle minutes",
						prefill: String(getConfig().recap.idleAfterTurnMs / 60_000),
						parse: parseIdleMinutesValue,
					},
				}),
		},
		{
			id: "recap.minSessionTurns",
			label: "Minimum session turns",
			description: "Skip auto recap until the session has at least this many user turns.",
			currentValue: String(config.recap.minSessionTurns),
			submenu: (_current, done) =>
				presetOrCustomPicker(numberSelectItems(MIN_SESSION_TURN_PRESETS, getConfig().recap.minSessionTurns), options.theme, done, {
					preferredValue: String(getConfig().recap.minSessionTurns),
					custom: {
						title: "Minimum session turns",
						prefill: String(getConfig().recap.minSessionTurns),
						parse: parsePositiveNumberValue,
					},
				}),
		},
		{
			id: "recap.neverTwiceInARow",
			label: "Never twice in a row",
			description: "Skip auto recap when nothing new has happened since the last recap.",
			currentValue: boolValue(config.recap.neverTwiceInARow),
			values: ["on", "off"],
		},
		{
			id: "recap.model",
			label: "Recap model",
			description: "Use the current session model, or pick from currently enabled models. A cheaper model is recommended.",
			currentValue: config.recap.model,
			submenu: (_current, done) =>
				filterableSelect(
					recapModelSelectItems(availableModels, getConfig().recap.model),
					options.theme,
					done,
					{ preferredValue: getConfig().recap.model },
				),
		},
	];

	if (config.recap.model !== "current") {
		items.push({
			id: "recap.fallbackToCurrentModel",
			label: "Fallback to current model",
			description: "If the selected recap model is unavailable, use the current session model.",
			currentValue: boolValue(config.recap.fallbackToCurrentModel),
			values: ["on", "off"],
		});
	}

	items.push(
		{
			id: "recap.maxRecentChars",
			label: "Max recent characters",
			description: "Cap the recent activity sent to the recap model.",
			currentValue: String(config.recap.maxRecentChars),
			submenu: (_current, done) =>
				presetOrCustomPicker(numberSelectItems(MAX_RECENT_CHAR_PRESETS, getConfig().recap.maxRecentChars), options.theme, done, {
					preferredValue: String(getConfig().recap.maxRecentChars),
					custom: {
						title: "Max recent characters",
						prefill: String(getConfig().recap.maxRecentChars),
						parse: parsePositiveNumberValue,
					},
				}),
		},
		{
			id: "recap.maxTokens",
			label: "Max tokens",
			description: "Token cap for the recap model response.",
			currentValue: String(config.recap.maxTokens),
			submenu: (_current, done) =>
				presetOrCustomPicker(numberSelectItems(MAX_TOKEN_PRESETS, getConfig().recap.maxTokens), options.theme, done, {
					preferredValue: String(getConfig().recap.maxTokens),
					custom: {
						title: "Max tokens",
						prefill: String(getConfig().recap.maxTokens),
						parse: parsePositiveNumberValue,
					},
				}),
		},
		{
			id: "recap.language",
			label: "Language",
			description: "auto follows recent activity. Custom values are sent as the recap language.",
			currentValue: config.recap.language,
			submenu: (_current, done) =>
				presetOrCustomPicker(languageSelectItems(getConfig().recap.language), options.theme, done, {
					preferredValue: getConfig().recap.language,
					custom: {
						title: "Recap language",
						prefill: getConfig().recap.language,
						parse: parseLanguageValue,
					},
				}),
		},
		{
			id: "title.generate",
			label: "Generate title",
			description: "Also generate a short title as a recap side effect.",
			currentValue: boolValue(config.title.generate),
			values: ["on", "off"],
		},
	);

	if (config.title.generate) {
		items.push(
			{
				id: "title.applyToSessionName",
				label: "Apply title to session name",
				description: "Use generated title to rename the Pi session according to policy.",
				currentValue: boolValue(config.title.applyToSessionName),
				values: ["on", "off"],
			},
			{
				id: "title.applyPolicy",
				label: "Session name policy",
				description: "Controls when generated titles overwrite session name.",
				currentValue: config.title.applyPolicy,
				values: ["if-empty-or-auto", "if-empty", "always", "never"],
			},
			{
				id: "title.maxLength",
				label: "Title max length",
				description: "Maximum characters for the generated or fallback title.",
				currentValue: String(config.title.maxLength),
				submenu: (_current, done) =>
					presetOrCustomPicker(numberSelectItems(TITLE_MAX_LENGTH_PRESETS, getConfig().title.maxLength), options.theme, done, {
						preferredValue: String(getConfig().title.maxLength),
						custom: {
							title: "Title max length",
							prefill: String(getConfig().title.maxLength),
							parse: parsePositiveNumberValue,
						},
					}),
			},
		);
	}

	items.push(
		{
			id: "display.widgetPlacement",
			label: "Widget placement",
			description: "Where to render the recap widget.",
			currentValue: config.display.widgetPlacement,
			values: ["aboveEditor", "belowEditor"],
		},
		{
			id: "multiplexer.enabled",
			label: "Sync multiplexer name",
			description: "Rename the nearest Herdr pane or tmux window when Pi session name changes.",
			currentValue: boolValue(config.multiplexer.enabled),
			values: ["on", "off"],
		},
		{
			id: "multiplexer.template",
			label: "Multiplexer template",
			description: "Name template. Variables: {session} {project} {cwd} {id}.",
			currentValue: config.multiplexer.template,
			submenu: (_current, done) =>
				editorSubmenu(
					options.editor,
					"Multiplexer name template",
					getConfig().multiplexer.template,
					done,
				),
		},
		{
			id: "multiplexer.maxLength",
			label: "Multiplexer name max length",
			description: "Truncate the generated pane or window name to this length.",
			currentValue: String(config.multiplexer.maxLength),
			submenu: (_current, done) =>
				presetOrCustomPicker(
					numberSelectItems(MULTIPLEXER_MAX_LENGTH_PRESETS, getConfig().multiplexer.maxLength),
					options.theme,
					done,
					{
						preferredValue: String(getConfig().multiplexer.maxLength),
						custom: {
							title: "Multiplexer name max length",
							prefill: String(getConfig().multiplexer.maxLength),
							parse: parsePositiveNumberValue,
						},
					},
				),
		},
		{
			id: "multiplexer.restoreOnShutdown",
			label: "Restore multiplexer on shutdown",
			description: "Restore the previous pane or window name when Pi exits.",
			currentValue: boolValue(config.multiplexer.restoreOnShutdown),
			values: ["on", "off"],
		},
	);

	return items;
}

export function applyConfigSetting(config: RecapConfig, id: string, value: string): RecapConfig {
	const next = normalizeConfig(JSON.parse(JSON.stringify(config)) as RecapConfig);
	const on = value === "on";

	switch (id) {
		case "recap.enabled":
			next.recap.enabled = on;
			break;
		case "recap.auto":
			next.recap.auto = on;
			break;
		case "recap.manualCommand":
			next.recap.manualCommand = on;
			break;
		case "recap.neverTwiceInARow":
			next.recap.neverTwiceInARow = on;
			break;
		case "recap.model":
			next.recap.model = value.trim() || next.recap.model;
			break;
		case "recap.fallbackToCurrentModel":
			next.recap.fallbackToCurrentModel = on;
			break;
		case "recap.idleAfterTurnMs":
			next.recap.idleAfterTurnMs = positiveNumber(Number(value), next.recap.idleAfterTurnMs);
			break;
		case "recap.minSessionTurns":
			next.recap.minSessionTurns = Math.max(0, Math.floor(positiveNumber(Number(value), next.recap.minSessionTurns)));
			break;
		case "recap.maxRecentChars":
			next.recap.maxRecentChars = positiveNumber(Number(value), next.recap.maxRecentChars);
			break;
		case "recap.maxTokens":
			next.recap.maxTokens = positiveNumber(Number(value), next.recap.maxTokens);
			break;
		case "recap.language":
			next.recap.language = value.trim() || next.recap.language;
			break;
		case "title.generate":
			next.title.generate = on;
			break;
		case "title.applyToSessionName":
			next.title.applyToSessionName = on;
			break;
		case "title.applyPolicy":
			next.title.applyPolicy = normalizeTitlePolicy(value);
			break;
		case "title.maxLength":
			next.title.maxLength = positiveNumber(Number(value), next.title.maxLength);
			break;
		case "display.widgetPlacement":
			next.display.widgetPlacement = value === "belowEditor" ? "belowEditor" : "aboveEditor";
			break;
		case "multiplexer.enabled":
			next.multiplexer.enabled = on;
			break;
		case "multiplexer.template":
			next.multiplexer.template = value;
			break;
		case "multiplexer.maxLength":
			next.multiplexer.maxLength = positiveNumber(Number(value), next.multiplexer.maxLength);
			break;
		case "multiplexer.restoreOnShutdown":
			next.multiplexer.restoreOnShutdown = on;
			break;
	}

	return normalizeConfig(next);
}

async function editConfigJson(pi: ExtensionAPI, ctx: ExtensionContext, state: RecapState) {
	if (ctx.mode !== "tui") {
		if (ctx.hasUI) ctx.ui.notify("/recap-config json requires TUI mode", "warning");
		return;
	}

	const edited = await ctx.ui.editor(`Edit ${getGlobalConfigPath()}`, JSON.stringify(state.config, null, 2));
	if (edited === undefined) return;

	try {
		const parsed = migrateLegacyConfig(JSON.parse(edited) as unknown).value;
		const next = normalizeConfig(deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, parsed) as RecapConfig);
		state.config = next;
		if (!next.recap.enabled || !next.recap.auto) stopAutomaticRecap(ctx, state);
		refreshRecapDisplay(ctx, state);
		await saveGlobalConfig(next);
		await syncMultiplexer(pi, ctx, state);
		ctx.ui.notify(`Saved recap config: ${getGlobalConfigPath()}`, "info");
	} catch (error) {
		ctx.ui.notify(`Invalid recap config JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

type SettingsListInternals = {
	items: SettingItem[];
	filteredItems: SettingItem[];
	selectedIndex: number;
	searchInput?: { getValue(): string };
	applyFilter?: (query: string) => void;
};

function replaceSettingsListItems(list: SettingsList, items: SettingItem[]) {
	const mutable = list as unknown as SettingsListInternals;
	const selectedId = mutable.items[mutable.selectedIndex]?.id;
	mutable.items = items;
	const query = mutable.searchInput?.getValue() ?? "";
	if (query && typeof mutable.applyFilter === "function") {
		mutable.applyFilter(query);
	} else {
		mutable.filteredItems = items;
	}
	const pool = query ? mutable.filteredItems : mutable.items;
	const index = pool.findIndex((item) => item.id === selectedId);
	if (index >= 0) mutable.selectedIndex = index;
	else if (mutable.selectedIndex >= pool.length) mutable.selectedIndex = Math.max(0, pool.length - 1);
}

async function openConfigUi(pi: ExtensionAPI, ctx: ExtensionContext, state: RecapState) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/recap-config requires TUI mode. Use /recap-config json to edit raw JSON in UI-capable modes.", "error");
		return;
	}

	const availableModels = typeof ctx.modelRegistry.getAvailable === "function"
		? ctx.modelRegistry.getAvailable()
		: [];

	await ctx.ui.custom((tui, theme, _kb, done) => {
		const settingsOptions = (): RecapSettingsOptions => ({
			availableModels,
			theme,
			getConfig: () => state.config,
			editor: (title, prefill) => ctx.ui.editor(title, prefill),
		});
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Recap Configuration")), 1, 0));
		container.addChild(new Text(theme.fg("dim", `Saving to ${getGlobalConfigPath()}`), 1, 0));
		container.addChild(new Text(theme.fg("dim", "Enter/Space to change · Esc closes · /recap-config json is optional"), 1, 0));

		let settingsList: SettingsList;
		settingsList = new SettingsList(
			settingItems(state.config, settingsOptions()),
			14,
			getSettingsListTheme(),
			(id, newValue) => {
				const next = applyConfigSetting(state.config, id, newValue);
				state.config = next;
				replaceSettingsListItems(settingsList, settingItems(next, settingsOptions()));

				if (!next.recap.enabled || !next.recap.auto) stopAutomaticRecap(ctx, state);
				refreshRecapDisplay(ctx, state);
				void saveGlobalConfig(next)
					.then(async () => {
						await syncMultiplexer(pi, ctx, state);
					})
					.catch((error) => {
						ctx.ui.notify(`Failed to save recap config: ${error instanceof Error ? error.message : String(error)}`, "error");
					});
			},
			() => done(undefined),
			{ enableSearch: true },
		);
		container.addChild(settingsList);

		return {
			render(width: number) {
				return container.render(width);
			},
			invalidate() {
				container.invalidate();
			},
			handleInput(data: string) {
				settingsList.handleInput?.(data);
				tui.requestRender();
			},
		};
	});
}

function multiplexerHooks(ctx: ExtensionContext): MultiplexerHooks {
	return {
		setTitle: (name) => ctx.ui.setTitle(name),
		warn: (message) => ctx.ui.notify(message, "warning"),
	};
}

function multiplexerNameContext(pi: ExtensionAPI, ctx: ExtensionContext): MultiplexerNameContext {
	return {
		sessionName: currentSessionName(pi, ctx),
		cwd: ctx.cwd,
		sessionId: ctx.sessionManager.getSessionId(),
	};
}

async function syncMultiplexer(pi: ExtensionAPI, ctx: ExtensionContext, state: RecapState) {
	const config = ctx.mode === "tui"
		? state.config.multiplexer
		: { ...state.config.multiplexer, enabled: false };
	await state.multiplexer.sync(config, multiplexerNameContext(pi, ctx), multiplexerHooks(ctx));
}

type ActiveRecapRun = {
	id: number;
	reason: RecapReason;
	controller?: AbortController;
	signal?: AbortSignal;
};

export type RecapState = {
	config: RecapConfig;
	running: boolean;
	nextRunId: number;
	activeRun?: ActiveRecapRun;
	applyingSessionName: boolean;
	lastRecap?: RecapEntryData;
	lastRecapAt?: number;
	lastRecapSourceToEntryId?: string;
	lastAppliedSessionName: boolean;
	lastAppliedTitle?: string;
	autoTimer?: ReturnType<typeof setTimeout>;
	multiplexer: MultiplexerManager;
};

function clearAutoTimer(state: RecapState) {
	if (state.autoTimer) clearTimeout(state.autoTimer);
	state.autoTimer = undefined;
}

function cancelActiveAutoRecap(state: RecapState): boolean {
	const run = state.activeRun;
	if (!run || run.reason !== "auto") return false;

	state.activeRun = undefined;
	state.running = false;
	run.controller?.abort();
	return true;
}

function stopAutomaticRecap(ctx: ExtensionContext, state: RecapState) {
	clearAutoTimer(state);
	cancelActiveAutoRecap(state);
	clearRecapDisplay(ctx);
}

function refreshRecapDisplay(ctx: ExtensionContext, state: RecapState) {
	clearRecapDisplay(ctx);
	if (state.config.recap.enabled && state.lastRecap) {
		displayRecapWidget(ctx, state.config, state.lastRecap);
	}
}

function scheduleAutoRecap(pi: ExtensionAPI, ctx: ExtensionContext, state: RecapState) {
	clearAutoTimer(state);

	const config = state.config;
	if (!config.recap.enabled || !config.recap.auto) return;
	if (ctx.mode !== "tui") return;

	state.autoTimer = setTimeout(() => {
		state.autoTimer = undefined;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		void runRecap(pi, ctx, state.config, state, "auto").catch((error) => {
			const message = error instanceof Error ? error.message : String(error);
			displayRecapError(ctx, state.config, message);
		});
	}, config.recap.idleAfterTurnMs);
}

export function restoreRecapState(entries: SessionEntry[], currentSessionName: string | undefined) {
	const last = getLastRecap(entries);
	const lastAppliedSessionName = Boolean(
		last?.data.appliedSessionName && last.data.title && currentSessionName === last.data.title,
	);
	return {
		lastRecap: last?.data,
		lastRecapAt: last?.data.generatedAt,
		lastRecapSourceToEntryId: last?.data.source?.toEntryId,
		lastAppliedSessionName,
		lastAppliedTitle: lastAppliedSessionName ? last?.data.title : undefined,
	};
}

async function refreshStateFromSession(ctx: ExtensionContext, state: RecapState) {
	Object.assign(
		state,
		restoreRecapState(ctx.sessionManager.getBranch(), ctx.sessionManager.getSessionName()),
	);
}

export function createRecapState(config: RecapConfig = DEFAULT_CONFIG): RecapState {
	return {
		config,
		running: false,
		nextRunId: 0,
		applyingSessionName: false,
		lastAppliedSessionName: false,
		multiplexer: new MultiplexerManager(),
	};
}

export default function (pi: ExtensionAPI) {
	const state = createRecapState();

	pi.on("session_start", async (_event, ctx) => {
		try {
			state.config = await loadRecapConfig(ctx);
		} catch (error) {
			ctx.ui.notify(`Failed to load recap config: ${error instanceof Error ? error.message : String(error)}`, "warning");
			state.config = DEFAULT_CONFIG;
		}

		await refreshStateFromSession(ctx, state);
		refreshRecapDisplay(ctx, state);
		await syncMultiplexer(pi, ctx, state);
	});

	pi.on("session_info_changed", async (event, ctx) => {
		if (!state.applyingSessionName && event.name !== state.lastAppliedTitle) {
			state.lastAppliedSessionName = false;
			state.lastAppliedTitle = undefined;
		}
		await syncMultiplexer(pi, ctx, state);
	});

	pi.on("input", async (_event, ctx) => {
		stopAutomaticRecap(ctx, state);
	});

	pi.on("agent_start", async (_event, ctx) => {
		stopAutomaticRecap(ctx, state);
	});

	pi.on("agent_end", async (_event, ctx) => {
		scheduleAutoRecap(pi, ctx, state);
	});

	pi.on("session_shutdown", async (event, ctx) => {
		stopAutomaticRecap(ctx, state);
		await state.multiplexer.shutdown(state.config.multiplexer, event.reason, multiplexerHooks(ctx));
	});

	pi.registerCommand("recap", {
		description: "Generate a recent activity recap",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			stopAutomaticRecap(ctx, state);
			if (!state.config.recap.manualCommand) {
				if (ctx.mode === "tui") displayRecapError(ctx, state.config, "/recap is disabled by config");
				else if (ctx.hasUI) ctx.ui.notify("/recap is disabled by config", "warning");
				return;
			}
			await ctx.waitForIdle();
			if (ctx.mode !== "tui") {
				await runRecap(pi, ctx, state.config, state, "manual", { force: true });
				return;
			}

			await ctx.ui.custom<RecapEntryData | undefined>((tui, theme, _keybindings, done) => {
				const loader = new CancellableLoader(
					tui,
					(text) => theme.fg("accent", text),
					(text) => theme.fg("muted", text),
					"Generating recap... (esc to cancel)",
				);
				let closed = false;
				const finish = (result: RecapEntryData | undefined) => {
					if (closed) return;
					closed = true;
					done(result);
				};

				loader.onAbort = () => finish(undefined);
				void runRecap(pi, ctx, state.config, state, "manual", {
					force: true,
					signal: loader.signal,
					showProgress: false,
				})
					.then(finish)
					.catch((error) => {
						if (!loader.signal.aborted) {
							const message = error instanceof Error ? error.message : String(error);
							displayRecapError(ctx, state.config, message);
						}
						finish(undefined);
					});

				return loader;
			});
		},
	});

	pi.registerCommand("recap-config", {
		description: "Configure recap extension",
		handler: async (args, ctx) => {
			stopAutomaticRecap(ctx, state);
			const mode = args.trim();
			if (mode === "json") {
				await editConfigJson(pi, ctx, state);
				return;
			}
			await openConfigUi(pi, ctx, state);
		},
	});
}
