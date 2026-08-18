import { unlink } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { writeFileAtomically, isRecord, pathExists, readTextFile } from "./fs.ts";
import { FOOTER_LOCALS, parseFooterLocal, type FooterLocal } from "./ledger/footer.ts";
import { parseLedgerWindowMode, type LedgerWindowMode } from "./ledger/time.ts";
import { getMeterPaths } from "./paths.ts";

export type QuotaPolarity = "used" | "remaining";
export type { LedgerWindowMode };

export interface MeterConfig {
	footer: {
		local: FooterLocal;
		quota: {
			visible: boolean;
			polarity: QuotaPolarity;
		};
	};
	quota: {
		snapshotTtlMs: number;
		minRefreshIntervalMs: number;
	};
	ledger: {
		windowMode: LedgerWindowMode;
	};
}

export const DEFAULT_METER_CONFIG: MeterConfig = {
	footer: {
		local: "today-spend",
		quota: {
			visible: true,
			polarity: "remaining",
		},
	},
	quota: {
		snapshotTtlMs: 60_000,
		minRefreshIntervalMs: 30_000,
	},
	ledger: {
		windowMode: "rolling",
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

function asQuotaPolarity(value: unknown, fallback: QuotaPolarity): QuotaPolarity {
	return value === "used" || value === "remaining" ? value : fallback;
}

export function parseMeterConfig(value: unknown, extras: { footerLocal?: unknown } = {}): MeterConfig {
	const record = isRecord(value) ? value : {};
	const footer = isRecord(record.footer) ? record.footer : {};
	const footerQuota = isRecord(footer.quota) ? footer.quota : {};
	const quota = isRecord(record.quota) ? record.quota : {};
	const legacyPolarity = asQuotaPolarity(
		record.quotaPolarity,
		asQuotaPolarity(quota.polarity, DEFAULT_METER_CONFIG.footer.quota.polarity),
	);
	const local = parseFooterLocal(footer.local)
		?? parseFooterLocal(extras.footerLocal)
		?? parseFooterLocal(record.footerPreset)
		?? DEFAULT_METER_CONFIG.footer.local;
	const ledger = isRecord(record.ledger) ? record.ledger : {};
	return {
		footer: {
			local,
			quota: {
				visible: asBoolean(
					footerQuota.visible,
					asBoolean(footer.quota, DEFAULT_METER_CONFIG.footer.quota.visible),
				),
				polarity: asQuotaPolarity(footerQuota.polarity, legacyPolarity),
			},
		},
		quota: {
			snapshotTtlMs: asPositiveInt(quota.snapshotTtlMs ?? record.snapshotTtlMs, DEFAULT_METER_CONFIG.quota.snapshotTtlMs),
			minRefreshIntervalMs: asPositiveInt(quota.minRefreshIntervalMs ?? record.minRefreshIntervalMs, DEFAULT_METER_CONFIG.quota.minRefreshIntervalMs),
		},
		ledger: {
			windowMode: parseLedgerWindowMode(ledger.windowMode) ?? DEFAULT_METER_CONFIG.ledger.windowMode,
		},
	};
}

function needsConfigShapeMigration(value: Record<string, unknown>): boolean {
	const footer = isRecord(value.footer) ? value.footer : {};
	const footerQuota = isRecord(footer.quota) ? footer.quota : undefined;
	const quota = isRecord(value.quota) ? value.quota : {};
	return !footerQuota
		|| typeof footerQuota.visible !== "boolean"
		|| (footerQuota.polarity !== "used" && footerQuota.polarity !== "remaining")
		|| "polarity" in quota
		|| "quotaPolarity" in value
		|| "snapshotTtlMs" in value
		|| "minRefreshIntervalMs" in value
		|| "footerPreset" in value;
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
	const shapeMigration = canonical.ok && needsConfigShapeMigration(canonical.value);
	if (!canonical.ok && extras.footerLocal) notes.push(`footer preset ${extras.footerLocal}`);
	if (canonical.ok && extras.footerLocal && !isRecord(canonical.value.footer)) notes.push(`footer preset ${extras.footerLocal}`);
	if (shapeMigration) notes.push("footer quota settings");
	const needsWrite = !canonical.ok
		|| Boolean(extras.footerLocal)
		|| (canonical.ok && !isRecord(canonical.value.footer))
		|| shapeMigration;
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
