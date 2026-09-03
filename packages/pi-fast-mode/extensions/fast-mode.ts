/**
 * Fast / Priority mode for Pi.
 *
 * Same model, higher scheduling priority:
 * - openai / openai-codex / xAI Responses via options.serviceTier
 * - custom xAI Completions models via a payload service_tier fallback
 *
 * Toggle until you toggle that model again, /reload, or quit: /fast  or  Ctrl+F
 * Startup default for the current model: /fast default on|off
 * That command also turns this session's switch to match.
 * Unconfigured models start off. There is no all-models default.
 *
 * Settings: fast-mode.models is a list of "provider/id" that start Fast.
 * Current switches are in-memory per model; they are not stored in the session.
 */
import {
	clampThinkingLevel,
	streamOpenAICodexResponses,
	streamOpenAIResponses,
	type Api,
	type Context,
	type Model,
	type SimpleStreamOptions,
} from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isKeyRelease, matchesKey } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildBaseOptions } from "./stream-options.ts";

export const STATUS_KEY = "fast-mode";
export const STATUS_ON = "⚡ FAST";
export const STATUS_OFF = "fast";
export const SETTINGS_FIELD = "fast-mode";
export const SERVICE_TIER = "priority" as const;
export const SHORTCUT = "ctrl+f";
export const SHORTCUT_REPEAT_GUARD_MS = 800;

export type ServiceTierOptions = ReturnType<typeof buildBaseOptions> & {
	serviceTier?: typeof SERVICE_TIER;
	reasoningEffort?: string;
	toolChoice?: SimpleStreamOptions["toolChoice"];
};

export type FastModeModel = Pick<Model<Api>, "provider" | "api"> & {
	id?: string;
};

export type FastModeModelRef = {
	provider?: string;
	id?: string;
};

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function resolveSettingsPath(): string {
	const piDir = process.env.PI_CODING_AGENT_DIR?.trim();
	if (piDir) return join(piDir, "settings.json");
	return join(homedir(), ".pi", "agent", "settings.json");
}

export function readSettingsFile(): { path: string; parsed: Record<string, unknown> } | undefined {
	const path = resolveSettingsPath();
	if (!existsSync(path)) return undefined;
	try {
		const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(parsed)) return undefined;
		return { path, parsed };
	} catch {
		return undefined;
	}
}

export function modelKey(model: FastModeModelRef | undefined): string | undefined {
	if (!model?.provider || !model.id) return undefined;
	return `${model.provider}/${model.id}`;
}

export type SettingsMigration = {
	migrated: boolean;
	notice?: string;
};

export function uniqueModelIds(items: string[]): string[] {
	const seen = new Set<string>();
	const models: string[] = [];
	for (const item of items) {
		if (item.length === 0 || seen.has(item)) continue;
		seen.add(item);
		models.push(item);
	}
	return models;
}

export function readEnabledModelList(block: unknown): string[] {
	if (!isRecord(block) || !Array.isArray(block.models)) return [];
	return uniqueModelIds(block.models.filter((item): item is string => typeof item === "string"));
}

export function modelsFromLegacyMap(models: unknown): string[] | undefined {
	if (!isRecord(models)) return undefined;
	return uniqueModelIds(
		Object.entries(models)
			.filter(([, value]) => value === true)
			.map(([key]) => key),
	);
}

function writeSettingsFile(parsed: Record<string, unknown>): void {
	const path = resolveSettingsPath();
	const temporary = `${path}.${process.pid}.tmp`;
	writeFileSync(temporary, `${JSON.stringify(parsed, null, 2)}\n`, { encoding: "utf8" });
	try {
		renameSync(temporary, path);
	} catch (error) {
		try {
			unlinkSync(temporary);
		} catch {
			// ignore cleanup failure
		}
		throw error;
	}
}

export function loadDefaultEnabled(key: string): boolean {
	const settings = readSettingsFile();
	if (!settings) return false;
	return readEnabledModelList(settings.parsed[SETTINGS_FIELD]).includes(key);
}

export function writeDefaultEnabled(key: string, enabled: boolean): void {
	const path = resolveSettingsPath();
	let parsed: Record<string, unknown> = {};
	if (existsSync(path)) {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw)) throw new Error(`Invalid settings.json: ${path}`);
		parsed = raw;
	}
	const previous = isRecord(parsed[SETTINGS_FIELD]) ? parsed[SETTINGS_FIELD] : {};
	const models = readEnabledModelList(previous).filter((item) => item !== key);
	if (enabled) models.push(key);
	const next: Record<string, unknown> = { ...previous };
	delete next.enabled;
	if (models.length > 0) next.models = models;
	else delete next.models;
	parsed[SETTINGS_FIELD] = next;
	writeSettingsFile(parsed);
}

export function migrateFastModeSettings(): SettingsMigration {
	const settings = readSettingsFile();
	if (!settings) return { migrated: false };
	const block = settings.parsed[SETTINGS_FIELD];
	if (!isRecord(block)) return { migrated: false };

	const hasLegacyEnabled = Object.hasOwn(block, "enabled");
	const fromMap = modelsFromLegacyMap(block.models);
	if (!hasLegacyEnabled && fromMap === undefined) return { migrated: false };

	const models = fromMap ?? readEnabledModelList(block);
	const hadGlobalOn = block.enabled === true;
	const next: Record<string, unknown> = { ...block };
	delete next.enabled;
	if (models.length > 0) next.models = models;
	else delete next.models;
	settings.parsed[SETTINGS_FIELD] = next;
	writeSettingsFile(settings.parsed);

	const notices: string[] = [];
	if (hadGlobalOn) {
		notices.push(
			"Fast Mode no longer has a global ON default. Unconfigured models start off. Use /fast default on for each model you want Fast.",
		);
	}
	if (fromMap !== undefined) {
		notices.push(
			fromMap.length > 0
				? `Fast Mode defaults are now an allowlist. Kept: ${fromMap.join(", ")}.`
				: "Fast Mode defaults are now an allowlist. No models were kept.",
		);
	}
	return notices.length > 0 ? { migrated: true, notice: notices.join(" ") } : { migrated: true };
}

export function supportsApi(model: FastModeModel | undefined): boolean {
	if (!model) return false;
	if (model.provider === "openai" || model.provider === "openai-codex") {
		return model.api === "openai-responses" || model.api === "openai-codex-responses";
	}
	if (model.provider === "xai") {
		return model.api === "openai-responses" || model.api === "openai-completions";
	}
	return false;
}

export function buildStreamOptions(
	model: Model<Api>,
	context: Context,
	options: SimpleStreamOptions | undefined,
	serviceTier: typeof SERVICE_TIER | undefined,
): ServiceTierOptions {
	const base = {
		...buildBaseOptions(model, context, options, options?.apiKey),
		toolChoice: options?.toolChoice,
	};
	const clamped = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
	const reasoningEffort = clamped === "off" ? undefined : clamped;
	return {
		...base,
		reasoningEffort,
		...(serviceTier ? { serviceTier } : {}),
	};
}

export function resolveServiceTier(
	enabled: boolean,
	model: Model<Api> | FastModeModel | undefined,
): typeof SERVICE_TIER | undefined {
	if (!enabled || !model || !supportsApi(model)) return undefined;
	return SERVICE_TIER;
}

export function footerStatusLabel(enabled: boolean, supported: boolean): string | undefined {
	if (!supported) return undefined;
	return enabled ? STATUS_ON : STATUS_OFF;
}

export function shouldReloadEnabledFromSettings(reason: unknown): boolean {
	return reason === "startup" || reason === "reload";
}

export function applyXaiPriorityPayload(input: {
	enabled: boolean;
	model: FastModeModel | undefined;
	payload: unknown;
}): Record<string, unknown> | undefined {
	if (!input.enabled || input.model?.provider !== "xai") return undefined;
	if (input.model.api !== "openai-completions") return undefined;
	if (!isRecord(input.payload)) return undefined;
	return { ...input.payload, service_tier: SERVICE_TIER };
}

function modelLabel(model: ExtensionContext["model"]): string {
	if (!model?.provider || !model.id) return "unknown model";
	return `${model.provider}/${model.id}`;
}

export default function fastMode(pi: ExtensionAPI): void {
	const remembered = new Map<string, boolean>();
	let unsubscribeTerminalInput: (() => void) | undefined;
	let shortcutRepeatGuard: ReturnType<typeof setTimeout> | undefined;
	let shortcutLatched = false;

	function enabledFor(model: FastModeModelRef | undefined): boolean {
		const key = modelKey(model);
		if (!key) return false;
		const cached = remembered.get(key);
		if (cached !== undefined) return cached;
		const fromSettings = loadDefaultEnabled(key);
		remembered.set(key, fromSettings);
		return fromSettings;
	}

	function resolveTier(model: Model<Api> | undefined): typeof SERVICE_TIER | undefined {
		return resolveServiceTier(enabledFor(model), model);
	}

	function updateStatus(ctx: ExtensionContext): void {
		const on = enabledFor(ctx.model);
		const label = footerStatusLabel(on, supportsApi(ctx.model));
		if (!label) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (on) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("warning", ctx.ui.theme.bold(label)));
			return;
		}
		ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", label));
	}

	function setEnabled(ctx: ExtensionContext, next: boolean): void {
		const key = modelKey(ctx.model);
		if (key) remembered.set(key, next);
		updateStatus(ctx);
		// Successful toggles stay in the footer. notify() is appended to the chat
		// transcript, so only use it when the footer cannot show the new state.
		if (next && !supportsApi(ctx.model)) {
			ctx.ui.notify(`Fast mode ON, but ${modelLabel(ctx.model)} is not supported`, "warning");
		}
	}

	function toggle(ctx: ExtensionContext): void {
		setEnabled(ctx, !enabledFor(ctx.model));
	}

	function setDefaultEnabled(ctx: ExtensionContext, next: boolean): void {
		if (!supportsApi(ctx.model)) {
			ctx.ui.notify(`Cannot set Fast default: ${modelLabel(ctx.model)} is not supported`, "error");
			return;
		}
		const key = modelKey(ctx.model);
		if (!key) {
			ctx.ui.notify("Cannot set Fast default: unknown model", "error");
			return;
		}
		try {
			writeDefaultEnabled(key, next);
		} catch (error) {
			ctx.ui.notify(`Failed to write fast-mode default: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		setEnabled(ctx, next);
		ctx.ui.notify(
			next ? `Startup default for ${key} is Fast ON.` : `Startup default for ${key} is Fast OFF.`,
			"info",
		);
	}

	pi.registerProvider("openai-codex", {
		api: "openai-codex-responses",
		streamSimple(model, context: Context, options?: SimpleStreamOptions) {
			const tier = resolveTier(model);
			return streamOpenAICodexResponses(
				model as Model<"openai-codex-responses">,
				context,
				buildStreamOptions(model, context, options, tier) as never,
			);
		},
	});

	pi.registerProvider("openai", {
		api: "openai-responses",
		streamSimple(model, context: Context, options?: SimpleStreamOptions) {
			const tier = resolveTier(model);
			return streamOpenAIResponses(
				model as Model<"openai-responses">,
				context,
				buildStreamOptions(model, context, options, tier) as never,
			);
		},
	});

	pi.registerProvider("xai", {
		api: "openai-responses",
		streamSimple(model, context: Context, options?: SimpleStreamOptions) {
			const tier = resolveTier(model);
			return streamOpenAIResponses(
				model as Model<"openai-responses">,
				context,
				buildStreamOptions(model, context, options, tier) as never,
			);
		},
	});

	// Pi's built-in xAI catalog is entirely Responses. Keep the serialized
	// payload hook only for custom xAI Completions models from models.json.
	pi.on("before_provider_request", (event, ctx) => {
		return applyXaiPriorityPayload({
			enabled: enabledFor(ctx.model),
			model: ctx.model,
			payload: event.payload,
		});
	});

	pi.registerCommand("fast", {
		description: "Toggle Fast / Priority mode, or set this model's startup default",
		getArgumentCompletions: (prefix) => {
			const values = ["on", "off", "default on", "default off"];
			const items = values.filter((value) => value.startsWith(prefix.trim().toLowerCase()));
			return items.length ? items.map((value) => ({ value, label: value })) : null;
		},
		handler: async (args, ctx) => {
			const tokens = args.trim().toLowerCase().split(/\s+/).filter(Boolean);
			if (tokens.length === 0) {
				toggle(ctx);
				return;
			}
			if (tokens[0] === "on" && tokens.length === 1) {
				setEnabled(ctx, true);
				return;
			}
			if (tokens[0] === "off" && tokens.length === 1) {
				setEnabled(ctx, false);
				return;
			}
			if (tokens[0] === "default") {
				if (tokens[1] === "on" && tokens.length === 2) {
					setDefaultEnabled(ctx, true);
					return;
				}
				if (tokens[1] === "off" && tokens.length === 2) {
					setDefaultEnabled(ctx, false);
					return;
				}
				ctx.ui.notify("Usage: /fast default on|off", "error");
				return;
			}
			ctx.ui.notify("Usage: /fast [on|off|default on|default off]", "error");
		},
	});

	pi.on("session_start", (event, ctx) => {
		if (shouldReloadEnabledFromSettings(event.reason)) {
			try {
				const migration = migrateFastModeSettings();
				if (migration.notice) ctx.ui.notify(migration.notice, "warning");
			} catch (error) {
				ctx.ui.notify(
					`Failed to migrate fast-mode settings: ${error instanceof Error ? error.message : String(error)}`,
					"error",
				);
			}
			remembered.clear();
		}
		unsubscribeTerminalInput?.();
		if (shortcutRepeatGuard) clearTimeout(shortcutRepeatGuard);
		shortcutRepeatGuard = undefined;
		shortcutLatched = false;
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
			// Kitty flag 2 emits press and release; matchesKey matches both.
			// Consume the release so it does not reach the editor (also bound to
			// ctrl+f), but only toggle on press.
			if (isKeyRelease(data)) {
				return matchesKey(data, SHORTCUT) ? { consume: true } : undefined;
			}
			if (!matchesKey(data, SHORTCUT)) return undefined;

			if (!shortcutLatched) {
				shortcutLatched = true;
				toggle(ctx);
			}
			if (shortcutRepeatGuard) clearTimeout(shortcutRepeatGuard);
			shortcutRepeatGuard = setTimeout(() => {
				shortcutLatched = false;
				shortcutRepeatGuard = undefined;
			}, SHORTCUT_REPEAT_GUARD_MS);
			return { consume: true };
		});
		updateStatus(ctx);
	});

	pi.on("model_select", (_event, ctx) => {
		updateStatus(ctx);
	});

	pi.on("session_shutdown", (_event, ctx) => {
		unsubscribeTerminalInput?.();
		unsubscribeTerminalInput = undefined;
		if (shortcutRepeatGuard) clearTimeout(shortcutRepeatGuard);
		shortcutRepeatGuard = undefined;
		shortcutLatched = false;
		ctx.ui.setStatus(STATUS_KEY, undefined);
	});
}
