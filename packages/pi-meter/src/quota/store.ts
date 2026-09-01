import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord, pathExists, readTextFile, writeFileAtomically } from "../fs.ts";
import { getMeterPaths } from "../paths.ts";
import { emptyQuotaStore } from "./policy.ts";
import type { QuotaResetCredit, QuotaResets, QuotaSnapshot, QuotaStoreFile, QuotaWindow } from "./types.ts";
import { QUOTA_MIN_INTERVAL_MS, QUOTA_TTL_MS } from "./types.ts";

function parseWindow(value: unknown): QuotaWindow | undefined {
	if (!isRecord(value) || typeof value.id !== "string" || typeof value.label !== "string") return undefined;
	if (typeof value.usedPercent !== "number" || !Number.isFinite(value.usedPercent)) return undefined;
	return {
		id: value.id,
		label: value.label,
		usedPercent: value.usedPercent,
		...(typeof value.resetsAt === "string" ? { resetsAt: value.resetsAt } : {}),
		...(typeof value.note === "string" ? { note: value.note } : {}),
	};
}

function isSourceId(value: unknown): value is string {
	return typeof value === "string" && value.length > 0;
}

function parseResetItem(value: unknown): QuotaResetCredit | undefined {
	if (!isRecord(value) || typeof value.expiresAt !== "string") return undefined;
	if (Number.isNaN(new Date(value.expiresAt).getTime())) return undefined;
	return {
		expiresAt: value.expiresAt,
		...(typeof value.title === "string" && value.title ? { title: value.title } : {}),
	};
}

function parseResets(value: unknown): QuotaResets | undefined {
	if (!isRecord(value) || typeof value.availableCount !== "number" || !Number.isFinite(value.availableCount)) {
		return undefined;
	}
	const availableCount = Math.max(0, Math.floor(value.availableCount));
	if (availableCount <= 0) return undefined;
	const items = Array.isArray(value.items)
		? value.items.map(parseResetItem).filter((item): item is QuotaResetCredit => item !== undefined)
		: [];
	return {
		availableCount,
		...(items.length > 0 ? { items } : {}),
	};
}

function parseSnapshot(value: unknown): QuotaSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	if (!isSourceId(value.provider)) return undefined;
	if (typeof value.title !== "string" || typeof value.fetchedAt !== "number") return undefined;
	const windows = Array.isArray(value.windows) ? value.windows.map(parseWindow).filter((item): item is QuotaWindow => item !== undefined) : [];
	const resets = parseResets(value.resets);
	return {
		provider: value.provider,
		title: value.title,
		primary: parseWindow(value.primary),
		windows,
		fetchedAt: value.fetchedAt,
		ok: value.ok === true,
		...(typeof value.error === "string" ? { error: value.error } : {}),
		...(value.stale === true ? { stale: true } : {}),
		...(resets ? { resets } : {}),
	};
}

export function parseQuotaStore(value: unknown, fallback = emptyQuotaStore()): QuotaStoreFile {
	if (!isRecord(value) || value.version !== 1) return fallback;
	const providers: QuotaStoreFile["providers"] = {};
	if (isRecord(value.providers)) {
		for (const [id, snapshot] of Object.entries(value.providers)) {
			const parsed = parseSnapshot({ ...((isRecord(snapshot) ? snapshot : {})), provider: id });
			if (parsed) providers[parsed.provider] = parsed;
		}
	}
	const lastAttemptAt: QuotaStoreFile["lastAttemptAt"] = {};
	if (isRecord(value.lastAttemptAt)) {
		for (const [id, ts] of Object.entries(value.lastAttemptAt)) {
			if (isSourceId(id) && typeof ts === "number") {
				lastAttemptAt[id] = ts;
			}
		}
	}
	return {
		version: 1,
		ttlMs: typeof value.ttlMs === "number" && value.ttlMs > 0 ? value.ttlMs : fallback.ttlMs,
		minIntervalMs: typeof value.minIntervalMs === "number" && value.minIntervalMs > 0 ? value.minIntervalMs : fallback.minIntervalMs,
		providers,
		lastAttemptAt,
	};
}

export async function loadQuotaStore(
	agentDir = getAgentDir(),
	defaults = { ttlMs: QUOTA_TTL_MS, minIntervalMs: QUOTA_MIN_INTERVAL_MS },
): Promise<QuotaStoreFile> {
	const path = getMeterPaths(agentDir).quotaFile;
	if (!(await pathExists(path))) return emptyQuotaStore(Date.now(), defaults.ttlMs, defaults.minIntervalMs);
	try {
		const raw = await readTextFile(path);
		return parseQuotaStore(raw ? JSON.parse(raw) : {}, emptyQuotaStore(Date.now(), defaults.ttlMs, defaults.minIntervalMs));
	} catch {
		return emptyQuotaStore(Date.now(), defaults.ttlMs, defaults.minIntervalMs);
	}
}

export async function saveQuotaStore(store: QuotaStoreFile, agentDir = getAgentDir()): Promise<void> {
	const path = getMeterPaths(agentDir).quotaFile;
	await writeFileAtomically(path, `${JSON.stringify(store)}\n`);
}
