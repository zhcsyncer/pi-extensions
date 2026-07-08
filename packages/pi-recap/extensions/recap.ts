/**
 * recap extension
 *
 * - Generate a recent activity recap. This is NOT compaction.
 * - Optionally apply the generated title to the Pi session name.
 * - Optionally sync Pi session name to the current tmux window name.
 *
 * Config:
 *   ~/.pi/agent/recap.json
 *   .pi/recap.json          (only read when the project is trusted)
 */

import { execFile } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { complete } from "@earendil-works/pi-ai/compat";
import {
	CONFIG_DIR_NAME,
	getAgentDir,
	getSettingsListTheme,
	type ExtensionAPI,
	type ExtensionCommandContext,
	type ExtensionContext,
	type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";

const execFileAsync = promisify(execFile);
const CUSTOM_TYPE = "recap";
const WIDGET_KEY = "recap";
const STATUS_KEY = "recap";

type RecapReason = "manual" | "auto";
type TitleApplyPolicy = "never" | "if-empty" | "if-empty-or-auto" | "always";
type WidgetPlacement = "aboveEditor" | "belowEditor";

type RecapConfig = {
	recap: {
		enabled: boolean;
		auto: boolean;
		manualCommand: boolean;
		idleAfterTurnMs: number;
		minSessionTurns: number;
		neverTwiceInARow: boolean;
		interactiveOnly: boolean;
		model: "current" | string;
		fallbackToCurrentModel: boolean;
		maxRecentChars: number;
		maxTokens: number;
		language: string;
	};
	display: {
		notify: boolean;
		widget: boolean;
		widgetPlacement: WidgetPlacement;
		clearWidgetOnNextAgentStart: boolean;
	};
	title: {
		generate: boolean;
		applyToSessionName: boolean;
		applyPolicy: TitleApplyPolicy;
		maxLength: number;
	};
	tmux: {
		enabled: boolean;
		template: string;
		maxLength: number;
		restoreOnShutdown: boolean;
	};
};

type RecapEntryData = {
	recap: string;
	title?: string;
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

type TmuxSnapshot = {
	windowId: string;
	originalName?: string;
	originalAutomaticRename?: string;
};

const DEFAULT_CONFIG: RecapConfig = {
	recap: {
		enabled: true,
		auto: true,
		manualCommand: true,
		idleAfterTurnMs: 3 * 60_000,
		minSessionTurns: 3,
		neverTwiceInARow: true,
		interactiveOnly: true,
		model: "current",
		fallbackToCurrentModel: true,
		maxRecentChars: 20_000,
		maxTokens: 300,
		language: "auto",
	},
	display: {
		notify: true,
		widget: false,
		widgetPlacement: "aboveEditor",
		clearWidgetOnNextAgentStart: true,
	},
	title: {
		generate: true,
		applyToSessionName: false,
		applyPolicy: "if-empty-or-auto",
		maxLength: 50,
	},
	tmux: {
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

async function readJsonIfExists(file: string): Promise<unknown | undefined> {
	try {
		return JSON.parse(await readFile(file, "utf8"));
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return undefined;
		throw error;
	}
}

function getGlobalConfigPath(): string {
	return path.join(getAgentDir(), "recap.json");
}

async function saveGlobalConfig(config: RecapConfig): Promise<void> {
	const file = getGlobalConfigPath();
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function loadConfig(ctx: ExtensionContext): Promise<RecapConfig> {
	let config = deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, {}) as RecapConfig;

	const globalConfig = await readJsonIfExists(path.join(getAgentDir(), "recap.json"));
	config = deepMerge(config as unknown as Record<string, unknown>, globalConfig) as RecapConfig;

	if (ctx.isProjectTrusted()) {
		const projectConfig = await readJsonIfExists(path.join(ctx.cwd, CONFIG_DIR_NAME, "recap.json"));
		config = deepMerge(config as unknown as Record<string, unknown>, projectConfig) as RecapConfig;
	}

	return normalizeConfig(config);
}

function normalizeConfig(config: RecapConfig): RecapConfig {
	return {
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
		tmux: {
			...DEFAULT_CONFIG.tmux,
			...config.tmux,
			maxLength: positiveNumber(config.tmux?.maxLength, DEFAULT_CONFIG.tmux.maxLength),
		},
	};
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

function parseModelJson(raw: string): { recap: string; title?: string } {
	const trimmed = raw.trim();
	const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)```/i)?.[1]?.trim();
	const object = (fenced ?? trimmed.match(/\{[\s\S]*\}/)?.[0] ?? trimmed).trim();

	try {
		const parsed = JSON.parse(object) as unknown;
		if (isRecord(parsed)) {
			return {
				recap: typeof parsed.recap === "string" ? parsed.recap : trimmed,
				title: typeof parsed.title === "string" ? parsed.title : undefined,
			};
		}
	} catch {
		// fall through
	}

	return { recap: trimmed };
}

function cleanOneLine(value: string, maxLength?: number): string {
	let cleaned = value
		.replace(/```(?:json)?|```/gi, "")
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	if (maxLength && cleaned.length > maxLength) {
		cleaned = `${cleaned.slice(0, Math.max(1, maxLength - 1))}…`;
	}
	return cleaned;
}

async function resolveRecapModel(ctx: ExtensionContext, config: RecapConfig) {
	if (config.recap.model === "current") return ctx.model;

	const separator = config.recap.model.indexOf("/");
	if (separator > 0) {
		const provider = config.recap.model.slice(0, separator);
		const modelId = config.recap.model.slice(separator + 1);
		const model = ctx.modelRegistry.find(provider, modelId);
		if (model) return model;
	}

	return config.recap.fallbackToCurrentModel ? ctx.model : undefined;
}

function shouldApplyTitle(title: string | undefined, pi: ExtensionAPI, ctx: ExtensionContext, config: RecapConfig, state: RecapState): boolean {
	if (!config.title.applyToSessionName) return false;
	if (!title) return false;

	const policy = config.title.applyPolicy;
	if (policy === "never") return false;
	if (policy === "always") return true;

	const current = currentSessionName(pi, ctx);
	if (!current) return true;
	if (policy === "if-empty") return false;

	return Boolean(state.lastAppliedSessionName && state.lastAppliedTitle && current === state.lastAppliedTitle);
}

function formatModelName(model: NonNullable<ExtensionContext["model"]> | undefined): string | undefined {
	return model ? `${model.provider}/${model.id}` : undefined;
}

async function runRecap(
	pi: ExtensionAPI,
	ctx: ExtensionContext,
	config: RecapConfig,
	state: RecapState,
	reason: RecapReason,
	force = false,
): Promise<RecapEntryData | undefined> {
	if (state.running) return undefined;
	if (!config.recap.enabled) {
		if (reason === "manual" && ctx.hasUI) ctx.ui.notify("recap is disabled by config", "warning");
		return undefined;
	}
	if (config.recap.interactiveOnly && ctx.mode !== "tui") return undefined;

	const entries = ctx.sessionManager.getBranch();
	if (!force && countUserTurns(entries) < config.recap.minSessionTurns) return undefined;

	const source = buildRecentConversation(entries, state.lastRecapSourceToEntryId, config.recap.maxRecentChars);
	if (!source.conversation.trim()) {
		if (reason === "manual" && ctx.hasUI) ctx.ui.notify("No new activity to recap", "warning");
		return undefined;
	}

	if (!force && config.recap.neverTwiceInARow && source.toEntryId && source.toEntryId === state.lastRecapSourceToEntryId) {
		return undefined;
	}

	const model = await resolveRecapModel(ctx, config);
	if (!model) {
		if (ctx.hasUI) ctx.ui.notify("No model available for recap", "warning");
		return undefined;
	}

	state.running = true;
	ctx.ui.setStatus(STATUS_KEY, "recap...");

	try {
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
		if (!auth.ok || !auth.apiKey) {
			if (ctx.hasUI) ctx.ui.notify(auth.ok ? `No API key for ${model.provider}` : auth.error, "warning");
			return undefined;
		}

		const response = await complete(
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
				apiKey: auth.apiKey,
				headers: auth.headers,
				env: auth.env,
				maxTokens: config.recap.maxTokens,
				signal: ctx.signal,
			},
		);

		const raw = response.content
			.filter((item): item is { type: "text"; text: string } => item.type === "text")
			.map((item) => item.text)
			.join("\n")
			.trim();

		if (!raw) {
			if (ctx.hasUI) ctx.ui.notify("Recap model returned empty output", "warning");
			return undefined;
		}

		const parsed = parseModelJson(raw);
		const recap = cleanOneLine(parsed.recap);
		const title = config.title.generate ? cleanOneLine(parsed.title ?? "", config.title.maxLength) || undefined : undefined;
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
		return data;
	} finally {
		state.running = false;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	}
}

function displayRecap(ctx: ExtensionContext, config: RecapConfig, data: RecapEntryData) {
	if (config.display.notify && ctx.hasUI) {
		ctx.ui.notify(`Recap: ${data.recap}`, "info");
	}

	if (config.display.widget && ctx.hasUI) {
		const lines = [
			data.title ? `Recap · ${data.title}` : "Recap",
			data.recap,
			`Generated ${new Date(data.generatedAt).toLocaleTimeString()}`,
		];
		ctx.ui.setWidget(WIDGET_KEY, lines, { placement: config.display.widgetPlacement });
	}
}

function clearWidget(ctx: ExtensionContext) {
	ctx.ui.setWidget(WIDGET_KEY, undefined);
}

function boolValue(value: boolean): string {
	return value ? "on" : "off";
}

function settingItems(config: RecapConfig): SettingItem[] {
	return [
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
			id: "recap.interactiveOnly",
			label: "Interactive only",
			description: "Skip recap outside TUI mode.",
			currentValue: boolValue(config.recap.interactiveOnly),
			values: ["on", "off"],
		},
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
			id: "display.notify",
			label: "Notify display",
			description: "Show recap as a notification/message.",
			currentValue: boolValue(config.display.notify),
			values: ["on", "off"],
		},
		{
			id: "display.widget",
			label: "Widget display",
			description: "Keep latest recap near the editor.",
			currentValue: boolValue(config.display.widget),
			values: ["on", "off"],
		},
		{
			id: "display.widgetPlacement",
			label: "Widget placement",
			description: "Where to render recap widget if enabled.",
			currentValue: config.display.widgetPlacement,
			values: ["aboveEditor", "belowEditor"],
		},
		{
			id: "tmux.enabled",
			label: "Sync tmux window",
			description: "Rename current tmux window when Pi session name changes.",
			currentValue: boolValue(config.tmux.enabled),
			values: ["on", "off"],
		},
		{
			id: "tmux.restoreOnShutdown",
			label: "Restore tmux on shutdown",
			description: "Restore previous tmux window name when Pi exits.",
			currentValue: boolValue(config.tmux.restoreOnShutdown),
			values: ["on", "off"],
		},
	];
}

function applyConfigSetting(config: RecapConfig, id: string, value: string): RecapConfig {
	const next = normalizeConfig(JSON.parse(JSON.stringify(config)) as RecapConfig);
	const on = value === "on";

	switch (id) {
		case "recap.enabled":
			next.recap.enabled = on;
			break;
		case "recap.auto":
			next.recap.auto = on;
			break;
		case "recap.interactiveOnly":
			next.recap.interactiveOnly = on;
			break;
		case "title.applyToSessionName":
			next.title.applyToSessionName = on;
			break;
		case "title.applyPolicy":
			next.title.applyPolicy = normalizeTitlePolicy(value);
			break;
		case "display.notify":
			next.display.notify = on;
			break;
		case "display.widget":
			next.display.widget = on;
			break;
		case "display.widgetPlacement":
			next.display.widgetPlacement = value === "belowEditor" ? "belowEditor" : "aboveEditor";
			break;
		case "tmux.enabled":
			next.tmux.enabled = on;
			break;
		case "tmux.restoreOnShutdown":
			next.tmux.restoreOnShutdown = on;
			break;
	}

	return normalizeConfig(next);
}

async function editConfigJson(pi: ExtensionAPI, ctx: ExtensionContext, state: RecapState) {
	if (!ctx.hasUI) {
		return;
	}

	const edited = await ctx.ui.editor(`Edit ${getGlobalConfigPath()}`, JSON.stringify(state.config, null, 2));
	if (edited === undefined) return;

	try {
		const parsed = JSON.parse(edited) as unknown;
		const next = normalizeConfig(deepMerge(DEFAULT_CONFIG as unknown as Record<string, unknown>, parsed) as RecapConfig);
		state.config = next;
		if (!next.recap.enabled || !next.recap.auto) clearAutoTimer(state);
		await saveGlobalConfig(next);
		await updateTmuxWindow(pi, ctx, next, state);
		ctx.ui.notify(`Saved recap config: ${getGlobalConfigPath()}`, "info");
	} catch (error) {
		ctx.ui.notify(`Invalid recap config JSON: ${error instanceof Error ? error.message : String(error)}`, "error");
	}
}

async function openConfigUi(pi: ExtensionAPI, ctx: ExtensionContext, state: RecapState) {
	if (ctx.mode !== "tui") {
		ctx.ui.notify("/recap-config requires TUI mode. Use /recap-config json to edit raw JSON in UI-capable modes.", "error");
		return;
	}

	await ctx.ui.custom((tui, theme, _kb, done) => {
		const container = new Container();
		container.addChild(new Text(theme.fg("accent", theme.bold("Recap Configuration")), 1, 0));
		container.addChild(new Text(theme.fg("dim", `Saving to ${getGlobalConfigPath()}`), 1, 0));
		container.addChild(new Text(theme.fg("dim", "Enter/Space cycles values · Esc closes · /recap-config json edits full JSON"), 1, 0));

		let settingsList: SettingsList;
		settingsList = new SettingsList(
			settingItems(state.config),
			12,
			getSettingsListTheme(),
			(id, newValue) => {
				const next = applyConfigSetting(state.config, id, newValue);
				state.config = next;
				settingsList.updateValue(id, newValue);

				if (!next.recap.enabled || !next.recap.auto) clearAutoTimer(state);
				void saveGlobalConfig(next)
					.then(async () => {
						await updateTmuxWindow(pi, ctx, next, state);
						ctx.ui.setStatus("recap-config", "saved");
						setTimeout(() => ctx.ui.setStatus("recap-config", undefined), 2000);
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

async function tmux(args: string[]): Promise<string | undefined> {
	if (!process.env.TMUX) return undefined;
	try {
		const { stdout } = await execFileAsync("tmux", args, { encoding: "utf8", timeout: 1000 });
		return String(stdout).trim();
	} catch {
		return undefined;
	}
}

async function ensureTmuxSnapshot(state: RecapState): Promise<TmuxSnapshot | undefined> {
	if (state.tmuxSnapshot) return state.tmuxSnapshot;

	const windowId = await tmux(["display-message", "-p", "#{window_id}"]);
	if (!windowId) return undefined;

	state.tmuxSnapshot = {
		windowId,
		originalName: await tmux(["display-message", "-p", "-t", windowId, "#{window_name}"]),
		originalAutomaticRename: await tmux(["show-window-options", "-qv", "-t", windowId, "automatic-rename"]),
	};

	await tmux(["set-window-option", "-q", "-t", windowId, "automatic-rename", "off"]);
	return state.tmuxSnapshot;
}

function cleanTmuxName(name: string, maxLength: number): string {
	const cleaned = name
		.replace(/[\x00-\x1f\x7f]/g, "")
		.replace(/\s+/g, " ")
		.trim();
	if (cleaned.length <= maxLength) return cleaned;
	return `${cleaned.slice(0, Math.max(1, maxLength - 1))}…`;
}

function buildTmuxWindowName(pi: ExtensionAPI, ctx: ExtensionContext, config: RecapConfig): string {
	const project = path.basename(ctx.cwd) || "project";
	const session = currentSessionName(pi, ctx) ?? ctx.sessionManager.getSessionId().slice(0, 8) ?? "session";
	const raw = config.tmux.template
		.replaceAll("{session}", session)
		.replaceAll("{project}", project)
		.replaceAll("{cwd}", ctx.cwd)
		.replaceAll("{id}", ctx.sessionManager.getSessionId());
	return cleanTmuxName(raw, config.tmux.maxLength);
}

async function updateTmuxWindow(pi: ExtensionAPI, ctx: ExtensionContext, config: RecapConfig, state: RecapState) {
	if (!config.tmux.enabled) return;
	if (ctx.mode !== "tui") return;
	if (!process.env.TMUX) return;

	const snapshot = await ensureTmuxSnapshot(state);
	if (!snapshot) return;

	const name = buildTmuxWindowName(pi, ctx, config);
	await tmux(["rename-window", "-t", snapshot.windowId, name]);
	ctx.ui.setTitle(name);
}

async function restoreTmuxWindow(state: RecapState) {
	const snapshot = state.tmuxSnapshot;
	if (!snapshot) return;

	if (snapshot.originalName) {
		await tmux(["rename-window", "-t", snapshot.windowId, snapshot.originalName]);
	}
	if (snapshot.originalAutomaticRename) {
		await tmux(["set-window-option", "-q", "-t", snapshot.windowId, "automatic-rename", snapshot.originalAutomaticRename]);
	}
}

type RecapState = {
	config: RecapConfig;
	running: boolean;
	applyingSessionName: boolean;
	lastRecap?: RecapEntryData;
	lastRecapAt?: number;
	lastRecapSourceToEntryId?: string;
	lastAppliedSessionName: boolean;
	lastAppliedTitle?: string;
	autoTimer?: ReturnType<typeof setTimeout>;
	tmuxSnapshot?: TmuxSnapshot;
};

function clearAutoTimer(state: RecapState) {
	if (state.autoTimer) clearTimeout(state.autoTimer);
	state.autoTimer = undefined;
}

function scheduleAutoRecap(pi: ExtensionAPI, ctx: ExtensionContext, state: RecapState) {
	clearAutoTimer(state);

	const config = state.config;
	if (!config.recap.enabled || !config.recap.auto) return;
	if (config.recap.interactiveOnly && ctx.mode !== "tui") return;

	state.autoTimer = setTimeout(() => {
		state.autoTimer = undefined;
		if (!ctx.isIdle() || ctx.hasPendingMessages()) return;
		void runRecap(pi, ctx, state.config, state, "auto");
	}, config.recap.idleAfterTurnMs);
}

async function refreshStateFromSession(ctx: ExtensionContext, state: RecapState) {
	const entries = ctx.sessionManager.getBranch();
	const last = getLastRecap(entries);

	state.lastRecap = last?.data;
	state.lastRecapAt = last?.data.generatedAt;
	state.lastRecapSourceToEntryId = last?.data.source?.toEntryId;

	const current = ctx.sessionManager.getSessionName();
	state.lastAppliedSessionName = Boolean(last?.data.appliedSessionName && last.data.title && current === last.data.title);
	state.lastAppliedTitle = state.lastAppliedSessionName ? last?.data.title : undefined;
}

export default function (pi: ExtensionAPI) {
	const state: RecapState = {
		config: DEFAULT_CONFIG,
		running: false,
		applyingSessionName: false,
		lastAppliedSessionName: false,
	};

	pi.on("session_start", async (_event, ctx) => {
		try {
			state.config = await loadConfig(ctx);
		} catch (error) {
			ctx.ui.notify(`Failed to load recap config: ${error instanceof Error ? error.message : String(error)}`, "warning");
			state.config = DEFAULT_CONFIG;
		}

		await refreshStateFromSession(ctx, state);
		await updateTmuxWindow(pi, ctx, state.config, state);
	});

	pi.on("session_info_changed", async (event, ctx) => {
		if (!state.applyingSessionName && event.name !== state.lastAppliedTitle) {
			state.lastAppliedSessionName = false;
			state.lastAppliedTitle = undefined;
		}
		await updateTmuxWindow(pi, ctx, state.config, state);
	});

	pi.on("agent_start", async (_event, ctx) => {
		clearAutoTimer(state);
		if (state.config.display.clearWidgetOnNextAgentStart) clearWidget(ctx);
	});

	pi.on("agent_end", async (_event, ctx) => {
		scheduleAutoRecap(pi, ctx, state);
	});

	pi.on("session_shutdown", async (event, _ctx) => {
		clearAutoTimer(state);
		if (state.config.tmux.restoreOnShutdown && event.reason !== "reload") {
			await restoreTmuxWindow(state);
		}
	});

	pi.registerCommand("recap", {
		description: "Generate a recent activity recap",
		handler: async (_args, ctx: ExtensionCommandContext) => {
			if (!state.config.recap.manualCommand) {
				ctx.ui.notify("/recap is disabled by config", "warning");
				return;
			}
			await ctx.waitForIdle();
			await runRecap(pi, ctx, state.config, state, "manual", true);
		},
	});

	pi.registerCommand("recap-config", {
		description: "Configure recap extension",
		handler: async (args, ctx) => {
			const mode = args.trim();
			if (mode === "json") {
				await editConfigJson(pi, ctx, state);
				return;
			}
			await openConfigUi(pi, ctx, state);
		},
	});
}
