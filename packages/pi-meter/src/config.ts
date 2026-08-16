import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeFileAtomically, isRecord, pathExists, readTextFile } from "./fs.ts";
import { getMeterPaths } from "./paths.ts";

export type QuotaPolarity = "used" | "remaining";

export interface MeterConfig {
	quotaPolarity: QuotaPolarity;
	tokenDetails: boolean;
	snapshotTtlMs: number;
	minRefreshIntervalMs: number;
}

export const DEFAULT_METER_CONFIG: MeterConfig = {
	quotaPolarity: "remaining",
	tokenDetails: false,
	snapshotTtlMs: 60_000,
	minRefreshIntervalMs: 30_000,
};

export interface LoadedMeterConfig {
	config: MeterConfig;
	path: string;
	warning?: string;
}

function asPositiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

export function parseTokenDetailsArg(arg: string, current: boolean): boolean | undefined {
	const raw = arg.trim().toLowerCase().replace(/^\/+analytics\s+/, "");
	if (raw === "details" || raw === "detail" || raw === "details toggle") return !current;
	if (raw === "details on" || raw === "details=on" || raw === "expand") return true;
	if (raw === "details off" || raw === "details=off" || raw === "compact") return false;
	return undefined;
}

export function parseMeterConfig(value: unknown): MeterConfig {
	if (!isRecord(value)) return { ...DEFAULT_METER_CONFIG };
	const polarity = value.quotaPolarity === "used" || value.quotaPolarity === "remaining"
		? value.quotaPolarity
		: DEFAULT_METER_CONFIG.quotaPolarity;
	return {
		quotaPolarity: polarity,
		tokenDetails: value.tokenDetails === true,
		snapshotTtlMs: asPositiveInt(value.snapshotTtlMs, DEFAULT_METER_CONFIG.snapshotTtlMs),
		minRefreshIntervalMs: asPositiveInt(value.minRefreshIntervalMs, DEFAULT_METER_CONFIG.minRefreshIntervalMs),
	};
}

export async function loadMeterConfig(agentDir = getAgentDir()): Promise<LoadedMeterConfig> {
	const path = getMeterPaths(agentDir).configFile;
	if (!(await pathExists(path))) return { config: { ...DEFAULT_METER_CONFIG }, path };
	try {
		const raw = await readTextFile(path);
		return { config: parseMeterConfig(raw ? JSON.parse(raw) : {}), path };
	} catch (error) {
		return {
			config: { ...DEFAULT_METER_CONFIG },
			path,
			warning: `Invalid pi-meter config at ${path}: ${error instanceof Error ? error.message : String(error)}. Using defaults.`,
		};
	}
}

export async function saveMeterConfig(config: MeterConfig, agentDir = getAgentDir()): Promise<string> {
	const path = getMeterPaths(agentDir).configFile;
	await writeFileAtomically(path, `${JSON.stringify(config, null, 2)}\n`);
	return path;
}
