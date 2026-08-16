import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { isRecord, pathExists, readTextFile, writeFileAtomically } from "../fs.ts";
import { getMeterPaths } from "../paths.ts";
import { emptyQuotaStore } from "./policy.ts";
import type { QuotaProviderId, QuotaSnapshot, QuotaStoreFile, QuotaWindow } from "./types.ts";
import { QUOTA_MIN_INTERVAL_MS, QUOTA_PROVIDERS, QUOTA_TTL_MS } from "./types.ts";

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

function parseSnapshot(value: unknown): QuotaSnapshot | undefined {
	if (!isRecord(value)) return undefined;
	if (!QUOTA_PROVIDERS.includes(value.provider as QuotaProviderId)) return undefined;
	if (typeof value.title !== "string" || typeof value.fetchedAt !== "number") return undefined;
	const windows = Array.isArray(value.windows) ? value.windows.map(parseWindow).filter((item): item is QuotaWindow => item !== undefined) : [];
	return {
		provider: value.provider as QuotaProviderId,
		title: value.title,
		primary: parseWindow(value.primary),
		windows,
		fetchedAt: value.fetchedAt,
		ok: value.ok === true,
		...(typeof value.error === "string" ? { error: value.error } : {}),
		...(value.stale === true ? { stale: true } : {}),
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
			if (QUOTA_PROVIDERS.includes(id as QuotaProviderId) && typeof ts === "number") {
				lastAttemptAt[id as QuotaProviderId] = ts;
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
