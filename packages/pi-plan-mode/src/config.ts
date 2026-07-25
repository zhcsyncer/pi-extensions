import { readFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type PlanContentLanguage = "auto" | "en" | "zh-CN";

export interface PlanModeConfig {
	contentLanguage: PlanContentLanguage;
}

export interface LoadedPlanModeConfig {
	config: PlanModeConfig;
	path: string;
	warning?: string;
}

export const DEFAULT_PLAN_MODE_CONFIG: PlanModeConfig = {
	contentLanguage: "auto",
};

const CONTENT_LANGUAGES = new Set<PlanContentLanguage>(["auto", "en", "zh-CN"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

export function getPlanModeConfigPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "plan-mode.json");
}

export function parsePlanModeConfig(value: unknown): PlanModeConfig {
	if (!isRecord(value)) throw new Error("the root value must be a JSON object");
	if (value.contentLanguage === undefined) return { ...DEFAULT_PLAN_MODE_CONFIG };
	if (typeof value.contentLanguage !== "string" || !CONTENT_LANGUAGES.has(value.contentLanguage as PlanContentLanguage)) {
		throw new Error('contentLanguage must be one of "auto", "en", or "zh-CN"');
	}
	return { contentLanguage: value.contentLanguage as PlanContentLanguage };
}

export async function loadPlanModeConfig(agentDir = getAgentDir()): Promise<LoadedPlanModeConfig> {
	const configPath = getPlanModeConfigPath(agentDir);
	let raw: string;
	try {
		raw = await readFile(configPath, "utf8");
	} catch (error) {
		if (isMissingFile(error)) return { config: { ...DEFAULT_PLAN_MODE_CONFIG }, path: configPath };
		return {
			config: { ...DEFAULT_PLAN_MODE_CONFIG },
			path: configPath,
			warning: `Failed to read Plan Mode config at ${configPath}: ${error instanceof Error ? error.message : String(error)}. Using contentLanguage "auto".`,
		};
	}

	try {
		return { config: parsePlanModeConfig(JSON.parse(raw) as unknown), path: configPath };
	} catch (error) {
		return {
			config: { ...DEFAULT_PLAN_MODE_CONFIG },
			path: configPath,
			warning: `Invalid Plan Mode config at ${configPath}: ${error instanceof Error ? error.message : String(error)}. Using contentLanguage "auto".`,
		};
	}
}
