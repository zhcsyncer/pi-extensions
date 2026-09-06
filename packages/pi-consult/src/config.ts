import { randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { DEFAULT_PROMPT_GUIDELINES, DEFAULT_PROMPT_SNIPPET } from "./guidance.ts";
import { getConsultPaths } from "./paths.ts";
import {
	isGradedEffort,
	isRecord,
	type ConsultBudget,
	type ConsultConfig,
	type ConsultGates,
	type ConsultGuidance,
	type PanelMember,
} from "./types.ts";

export const DEFAULT_CONSULT_CONFIG: ConsultConfig = {
	panel: [],
	fanout: false,
	gates: { watchdog: 5 },
	budget: { perRun: 3, perSession: 8 },
	disabledForModels: [],
};

export interface LoadedConsultConfig {
	config: ConsultConfig;
	path: string;
	raw: Record<string, unknown>;
	warning?: string;
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch (error) {
		if (isMissingFile(error)) return false;
		throw error;
	}
}

function asNonNegativeInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0 ? Math.floor(value) : fallback;
}

function parsePanelMember(value: unknown): PanelMember | undefined {
	if (!isRecord(value) || typeof value.model !== "string" || value.model.trim() === "") return undefined;
	const member: PanelMember = { model: value.model.trim() };
	if (value.effort !== undefined) {
		if (!isGradedEffort(value.effort)) return undefined;
		member.effort = value.effort;
	}
	return member;
}

function parsePanel(value: unknown): PanelMember[] {
	if (!Array.isArray(value)) return [];
	const panel: PanelMember[] = [];
	for (const entry of value) {
		const member = parsePanelMember(entry);
		if (member) panel.push(member);
	}
	return panel;
}

function parseGates(value: unknown): ConsultGates {
	const record = isRecord(value) ? value : {};
	let watchdog = DEFAULT_CONSULT_CONFIG.gates.watchdog;
	if (record.watchdog === false) watchdog = 0;
	else if (record.watchdog === true) watchdog = DEFAULT_CONSULT_CONFIG.gates.watchdog;
	else watchdog = asNonNegativeInt(record.watchdog, DEFAULT_CONSULT_CONFIG.gates.watchdog);
	return { watchdog };
}

function parseBudget(value: unknown): ConsultBudget {
	const record = isRecord(value) ? value : {};
	return {
		perRun: asNonNegativeInt(record.perRun ?? record.perTurn, DEFAULT_CONSULT_CONFIG.budget.perRun),
		perSession: asNonNegativeInt(record.perSession, DEFAULT_CONSULT_CONFIG.budget.perSession),
	};
}

function parseDisabledForModels(value: unknown): string[] {
	if (!Array.isArray(value)) return [];
	return value.filter((entry): entry is string => typeof entry === "string" && entry.trim().length > 0).map((entry) => entry.trim());
}

function parseGuidance(value: unknown): ConsultGuidance | undefined {
	if (!isRecord(value)) return undefined;
	const guidance: ConsultGuidance = {};
	if (typeof value.promptSnippet === "string" && value.promptSnippet.trim()) {
		guidance.promptSnippet = value.promptSnippet;
	}
	if (Array.isArray(value.promptGuidelines)) {
		const lines = value.promptGuidelines.filter((line): line is string => typeof line === "string" && line.trim().length > 0);
		if (lines.length > 0) guidance.promptGuidelines = lines;
	}
	return guidance.promptSnippet || guidance.promptGuidelines ? guidance : undefined;
}

export function parseConsultConfig(value: unknown): ConsultConfig {
	const record = isRecord(value) ? value : {};
	const config: ConsultConfig = {
		panel: parsePanel(record.panel),
		fanout: typeof record.fanout === "boolean" ? record.fanout : DEFAULT_CONSULT_CONFIG.fanout,
		gates: parseGates(record.gates),
		budget: parseBudget(record.budget),
		disabledForModels: parseDisabledForModels(record.disabledForModels),
	};
	const guidance = parseGuidance(record.guidance);
	if (guidance) config.guidance = guidance;
	return config;
}

export function resolveGuidance(config: ConsultConfig): { promptSnippet: string; promptGuidelines: string[] } {
	return {
		promptSnippet: config.guidance?.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: config.guidance?.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
	};
}

export function serializeConsultConfig(config: ConsultConfig, existingRaw: Record<string, unknown> = {}): Record<string, unknown> {
	const next: Record<string, unknown> = {
		...existingRaw,
		panel: config.panel,
		fanout: config.fanout,
		gates: config.gates,
		budget: config.budget,
		disabledForModels: config.disabledForModels,
	};
	if (config.guidance) next.guidance = config.guidance;
	else delete next.guidance;
	return next;
}

async function writeConfigAtomically(file: string, payload: Record<string, unknown>): Promise<void> {
	const directory = path.dirname(file);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = path.join(directory, `.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(payload, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, file);
		await chmod(file, 0o600);
	} finally {
		await rm(temporary, { force: true });
	}
}

function configFromText(configPath: string, rawText: string): LoadedConsultConfig {
	try {
		const parsed = JSON.parse(rawText) as unknown;
		if (!isRecord(parsed)) {
			return {
				config: { ...DEFAULT_CONSULT_CONFIG },
				path: configPath,
				raw: {},
				warning: `Invalid Consult config at ${configPath}: root must be a JSON object. Using defaults.`,
			};
		}
		return { config: parseConsultConfig(parsed), path: configPath, raw: parsed };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			config: { ...DEFAULT_CONSULT_CONFIG },
			path: configPath,
			raw: {},
			warning: `Invalid Consult config at ${configPath}: ${message}. Using defaults.`,
		};
	}
}

export function loadConsultConfigSync(agentDir?: string): LoadedConsultConfig {
	const configPath = getConsultPaths(agentDir).configFile;
	try {
		return configFromText(configPath, readFileSync(configPath, "utf8"));
	} catch (error) {
		if (isMissingFile(error)) {
			return { config: { ...DEFAULT_CONSULT_CONFIG }, path: configPath, raw: {} };
		}
		const message = error instanceof Error ? error.message : String(error);
		return {
			config: { ...DEFAULT_CONSULT_CONFIG },
			path: configPath,
			raw: {},
			warning: `Invalid Consult config at ${configPath}: ${message}. Using defaults.`,
		};
	}
}

export async function loadConsultConfig(agentDir?: string): Promise<LoadedConsultConfig> {
	const configPath = getConsultPaths(agentDir).configFile;
	if (!(await exists(configPath))) {
		return { config: { ...DEFAULT_CONSULT_CONFIG }, path: configPath, raw: {} };
	}
	try {
		return configFromText(configPath, await readFile(configPath, "utf8"));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			config: { ...DEFAULT_CONSULT_CONFIG },
			path: configPath,
			raw: {},
			warning: `Invalid Consult config at ${configPath}: ${message}. Using defaults.`,
		};
	}
}

export async function saveConsultConfig(config: ConsultConfig, agentDir?: string, existingRaw: Record<string, unknown> = {}): Promise<boolean> {
	const configPath = getConsultPaths(agentDir).configFile;
	try {
		await writeConfigAtomically(configPath, serializeConsultConfig(config, existingRaw));
		return true;
	} catch {
		return false;
	}
}
