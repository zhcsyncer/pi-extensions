import { unlink } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeFileAtomically, isRecord, pathExists, readTextFile } from "./fs.ts";
import { FOOTER_LOCALS, parseFooterLocal, type FooterLocal } from "./ledger/footer.ts";
import { getMeterPaths } from "./paths.ts";

export type QuotaPolarity = "used" | "remaining";

export interface MeterConfig {
	footer: {
		local: FooterLocal;
		quota: boolean;
	};
	quota: {
		polarity: QuotaPolarity;
		snapshotTtlMs: number;
		minRefreshIntervalMs: number;
	};
}

export const DEFAULT_METER_CONFIG: MeterConfig = {
	footer: {
		local: "today-spend",
		quota: true,
	},
	quota: {
		polarity: "remaining",
		snapshotTtlMs: 60_000,
		minRefreshIntervalMs: 30_000,
	},
};

export interface LoadedMeterConfig {
	config: MeterConfig;
	path: string;
	warning?: string;
	migration?: string;
}

function asPositiveInt(value: unknown, fallback: number): number {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : fallback;
}

function asBoolean(value: unknown, fallback: boolean): boolean {
	return typeof value === "boolean" ? value : fallback;
}

export function parseQuotaVisibleArg(arg: string, current: boolean): boolean | undefined {
	const raw = arg.trim().toLowerCase();
	if (raw === "on" || raw === "quota on" || raw === "quota=on") return true;
	if (raw === "off" || raw === "quota off" || raw === "quota=off") return false;
	if (raw === "quota" || raw === "quota toggle") return !current;
	return undefined;
}

export function parseMeterConfig(value: unknown, extras: { footerLocal?: unknown } = {}): MeterConfig {
	const record = isRecord(value) ? value : {};
	const footer = isRecord(record.footer) ? record.footer : {};
	const quota = isRecord(record.quota) ? record.quota : {};
	const polarity = record.quotaPolarity === "used" || record.quotaPolarity === "remaining"
		? record.quotaPolarity
		: quota.polarity === "used" || quota.polarity === "remaining"
			? quota.polarity
			: DEFAULT_METER_CONFIG.quota.polarity;
	const local = parseFooterLocal(footer.local)
		?? parseFooterLocal(extras.footerLocal)
		?? parseFooterLocal(record.footerPreset)
		?? DEFAULT_METER_CONFIG.footer.local;
	return {
		footer: {
			local,
			quota: asBoolean(footer.quota, DEFAULT_METER_CONFIG.footer.quota),
		},
		quota: {
			polarity,
			snapshotTtlMs: asPositiveInt(quota.snapshotTtlMs ?? record.snapshotTtlMs, DEFAULT_METER_CONFIG.quota.snapshotTtlMs),
			minRefreshIntervalMs: asPositiveInt(quota.minRefreshIntervalMs ?? record.minRefreshIntervalMs, DEFAULT_METER_CONFIG.quota.minRefreshIntervalMs),
		},
	};
}

async function readJsonRecord(path: string): Promise<{ ok: true; value: Record<string, unknown> } | { ok: false; reason?: string }> {
	if (!(await pathExists(path))) return { ok: false };
	try {
		const raw = await readTextFile(path);
		const parsed = raw ? JSON.parse(raw) as unknown : {};
		if (!isRecord(parsed)) return { ok: false, reason: "not an object" };
		return { ok: true, value: parsed };
	} catch (error) {
		return { ok: false, reason: error instanceof Error ? error.message : String(error) };
	}
}

function footerLocalFromFile(value: Record<string, unknown>): FooterLocal | undefined {
	return parseFooterLocal(value.preset) ?? parseFooterLocal(isRecord(value.footer) ? value.footer.local : undefined);
}

export async function loadMeterConfig(agentDir = getAgentDir()): Promise<LoadedMeterConfig> {
	const paths = getMeterPaths(agentDir);
	const canonical = await readJsonRecord(paths.configFile);
	const sidecar = await readJsonRecord(paths.footerFile);
	const legacy = await readJsonRecord(paths.legacyFooterFile);
	const extras = {
		footerLocal: sidecar.ok
			? footerLocalFromFile(sidecar.value)
			: legacy.ok
				? footerLocalFromFile(legacy.value)
				: undefined,
	};
	if (canonical.ok === false && canonical.reason) {
		return {
			config: parseMeterConfig({}, extras),
			path: paths.configFile,
			warning: `Invalid pi-meter config at ${paths.configFile}: ${canonical.reason}. Using defaults.`,
		};
	}
	const config = parseMeterConfig(canonical.ok ? canonical.value : {}, extras);
	const notes: string[] = [];
	if (!canonical.ok && extras.footerLocal) notes.push(`footer preset ${extras.footerLocal}`);
	if (canonical.ok && extras.footerLocal && !isRecord(canonical.value.footer)) notes.push(`footer preset ${extras.footerLocal}`);
	const needsWrite = !canonical.ok || Boolean(extras.footerLocal) || (canonical.ok && !isRecord(canonical.value.footer));
	if (needsWrite) {
		try {
			await saveMeterConfig(config, agentDir);
			if (await pathExists(paths.footerFile)) {
				await unlink(paths.footerFile);
				notes.push(`${paths.footerFile} → ${paths.configFile}`);
			}
			if (await pathExists(paths.legacyFooterFile)) {
				await unlink(paths.legacyFooterFile);
				notes.push(`${paths.legacyFooterFile} → ${paths.configFile}`);
			}
		} catch (error) {
			return {
				config,
				path: paths.configFile,
				warning: `Could not consolidate pi-meter config (${error instanceof Error ? error.message : String(error)}).`,
			};
		}
	}
	return {
		config,
		path: paths.configFile,
		...(notes.length > 0 ? { migration: `Consolidated meter preferences into config.json: ${notes.join("; ")}.` } : {}),
	};
}

export async function saveMeterConfig(config: MeterConfig, agentDir = getAgentDir()): Promise<string> {
	const path = getMeterPaths(agentDir).configFile;
	await writeFileAtomically(path, `${JSON.stringify(config, null, 2)}\n`);
	return path;
}

export function footerLocalChoices(): { key: FooterLocal; label: string; description: string }[] {
	return FOOTER_LOCALS;
}
