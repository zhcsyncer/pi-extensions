/**
 * Fast / Priority mode for Pi.
 *
 * Same model, higher scheduling priority:
 * - openai / openai-codex Responses via options.serviceTier
 * - xAI Responses / Completions via payload service_tier
 *
 * Toggle until you toggle again, /reload, or quit: /fast  or  Ctrl+F
 * Startup default: /fast default on|off
 *
 * Settings key: fast-mode.enabled
 * Current switch is in-memory only; it is not stored in the session.
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
import { matchesKey } from "@earendil-works/pi-tui";
import { existsSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { buildBaseOptions } from "./stream-options.ts";

export const STATUS_KEY = "fast-mode";
export const SETTINGS_FIELD = "fast-mode";
export const SERVICE_TIER = "priority" as const;
export const SHORTCUT = "ctrl+f";
export const SHORTCUT_REPEAT_GUARD_MS = 800;

export type ServiceTierOptions = ReturnType<typeof buildBaseOptions> & {
	serviceTier?: typeof SERVICE_TIER;
	reasoningEffort?: string;
};

export type FastModeModel = Pick<Model<Api>, "provider" | "api">;

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

export function loadDefaultEnabled(): boolean {
	const settings = readSettingsFile();
	if (!settings) return false;
	const block = settings.parsed[SETTINGS_FIELD];
	return isRecord(block) && block.enabled === true;
}

export function writeDefaultEnabled(enabled: boolean): void {
	const path = resolveSettingsPath();
	let parsed: Record<string, unknown> = {};
	if (existsSync(path)) {
		const raw = JSON.parse(readFileSync(path, "utf8")) as unknown;
		if (!isRecord(raw)) throw new Error(`Invalid settings.json: ${path}`);
		parsed = raw;
	}
	const previous = isRecord(parsed[SETTINGS_FIELD]) ? parsed[SETTINGS_FIELD] : {};
	parsed[SETTINGS_FIELD] = { ...previous, enabled };
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
	const base = buildBaseOptions(model, context, options, options?.apiKey);
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

export function shouldReloadEnabledFromSettings(reason: unknown): boolean {
	return reason === "startup" || reason === "reload";
}

export function applyXaiPriorityPayload(input: {
	enabled: boolean;
	model: FastModeModel | undefined;
	payload: unknown;
}): Record<string, unknown> | undefined {
	if (!input.enabled || input.model?.provider !== "xai") return undefined;
	if (!supportsApi(input.model)) return undefined;
	if (!isRecord(input.payload)) return undefined;
	return { ...input.payload, service_tier: SERVICE_TIER };
}

function modelLabel(model: ExtensionContext["model"]): string {
	if (!model?.provider || !model.id) return "unknown model";
	return `${model.provider}/${model.id}`;
}

export default function fastMode(pi: ExtensionAPI): void {
	let enabled = loadDefaultEnabled();
	let unsubscribeTerminalInput: (() => void) | undefined;
	let shortcutRepeatGuard: ReturnType<typeof setTimeout> | undefined;
	let shortcutLatched = false;

	function resolveTier(model: Model<Api> | undefined): typeof SERVICE_TIER | undefined {
		return resolveServiceTier(enabled, model);
	}

	function updateStatus(ctx: ExtensionContext): void {
		if (!supportsApi(ctx.model)) {
			ctx.ui.setStatus(STATUS_KEY, undefined);
			return;
		}
		if (!enabled) {
			ctx.ui.setStatus(STATUS_KEY, ctx.ui.theme.fg("dim", "fast: off · Ctrl+F"));
			return;
		}
		const label = ctx.ui.theme.fg("warning", ctx.ui.theme.bold("⚡ FAST"));
		const detail = ctx.ui.theme.fg("muted", " priority if granted");
		ctx.ui.setStatus(STATUS_KEY, `${label}${detail}`);
	}

	function announce(ctx: ExtensionContext): void {
		if (!enabled) {
			ctx.ui.notify("Fast mode OFF", "info");
			return;
		}
		if (supportsApi(ctx.model)) {
			ctx.ui.notify(`Fast mode ON · requesting ${SERVICE_TIER} · billed if granted`, "warning");
			return;
		}
		ctx.ui.notify(`Fast mode ON, but ${modelLabel(ctx.model)} is not supported`, "warning");
	}

	function setEnabled(ctx: ExtensionContext, next: boolean): void {
		enabled = next;
		updateStatus(ctx);
		announce(ctx);
	}

	function toggle(ctx: ExtensionContext): void {
		setEnabled(ctx, !enabled);
	}

	function setDefaultEnabled(ctx: ExtensionContext, next: boolean): void {
		try {
			writeDefaultEnabled(next);
		} catch (error) {
			ctx.ui.notify(`Failed to write fast-mode default: ${error instanceof Error ? error.message : String(error)}`, "error");
			return;
		}
		ctx.ui.notify(
			next
				? "Startup default is Fast ON. Current switch is unchanged."
				: "Startup default is Fast OFF. Current switch is unchanged.",
			"info",
		);
		updateStatus(ctx);
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

	// xAI is mixed-API (4.5 Responses, 4.6 Completions). registerProvider() can
	// wrap only one api id, so inject the field on the serialized payload for both.
	pi.on("before_provider_request", (event, ctx) => {
		return applyXaiPriorityPayload({
			enabled,
			model: ctx.model,
			payload: event.payload,
		});
	});

	pi.registerCommand("fast", {
		description: "Toggle Fast / Priority mode, or set the new-session default",
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
			enabled = loadDefaultEnabled();
		}
		unsubscribeTerminalInput?.();
		if (shortcutRepeatGuard) clearTimeout(shortcutRepeatGuard);
		shortcutRepeatGuard = undefined;
		shortcutLatched = false;
		unsubscribeTerminalInput = ctx.ui.onTerminalInput((data) => {
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
