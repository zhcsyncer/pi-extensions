import { appendFile, copyFile, unlink } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ensurePrivateDir, isRecord, pathExists, readTextFile, withDirectoryLock, writeFileAtomically } from "../fs.ts";
import { getMeterPaths, type MeterPaths } from "../paths.ts";
import type { BudgetLimit, BudgetsConfig, UsageRecord } from "./types.ts";

export interface LedgerStore {
	append(record: UsageRecord): Promise<boolean>;
	readAll(): Promise<UsageRecord[]>;
	loadBudgets(): Promise<BudgetsConfig>;
	saveBudgets(config: BudgetsConfig): Promise<void>;
	loadWarned(): Promise<Record<string, boolean>>;
	markWarned(keys: string[]): Promise<void>;
}

export function serializeUsageRecord(record: UsageRecord): unknown[] {
	return [
		record.ts,
		record.sid,
		record.cwd,
		record.model,
		record.in,
		record.out,
		record.cR,
		record.cW,
		record.tot,
		record.cost,
		record.costKnown ? 1 : 0,
	];
}

export function parseUsageLine(line: string): UsageRecord | undefined {
	if (!line.trim()) return undefined;
	try {
		const value = JSON.parse(line) as unknown;
		if (Array.isArray(value)) return parseArrayRecord(value);
		if (isRecord(value)) return parseObjectRecord(value);
		return undefined;
	} catch {
		return undefined;
	}
}

function parseArrayRecord(value: unknown[]): UsageRecord | undefined {
	if (value.length < 10) return undefined;
	const tot = asNumber(value[8]);
	const cost = asNumber(value[9]);
	return {
		ts: asNumber(value[0]),
		sid: String(value[1] ?? ""),
		cwd: String(value[2] ?? ""),
		model: String(value[3] ?? ""),
		in: asNumber(value[4]),
		out: asNumber(value[5]),
		cR: asNumber(value[6]),
		cW: asNumber(value[7]),
		tot,
		cost,
		costKnown: value.length > 10 ? value[10] === 1 : cost > 0,
	};
}

function parseObjectRecord(value: Record<string, unknown>): UsageRecord | undefined {
	if (typeof value.model !== "string") return undefined;
	return {
		ts: asNumber(value.ts),
		sid: String(value.sid ?? ""),
		cwd: String(value.cwd ?? ""),
		model: value.model,
		in: asNumber(value.in),
		out: asNumber(value.out),
		cR: asNumber(value.cR),
		cW: asNumber(value.cW),
		tot: asNumber(value.tot),
		cost: asNumber(value.cost),
		costKnown: value.costKnown === true || (value.costKnown !== false && asNumber(value.cost) > 0),
	};
}

function asNumber(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function parseBudgets(raw: string | undefined): BudgetsConfig {
	if (!raw) return { limits: [] };
	try {
		const parsed = JSON.parse(raw) as unknown;
		if (!isRecord(parsed) || !Array.isArray(parsed.limits)) return { limits: [] };
		return { limits: parsed.limits.filter(isBudgetLimit) };
	} catch {
		return { limits: [] };
	}
}

function isBudgetLimit(value: unknown): value is BudgetLimit {
	if (!isRecord(value)) return false;
	return (
		(value.scope === "global" || value.scope === "session" || value.scope === "project") &&
		(value.period === "day" || value.period === "week" || value.period === "month" || value.period === "year") &&
		(value.metric === "cost" || value.metric === "tot" || value.metric === "in" || value.metric === "out") &&
		typeof value.max === "number" &&
		value.max > 0
	);
}

function parseWarned(raw: string | undefined): Record<string, boolean> {
	if (!raw) return {};
	try {
		if (raw.trim().startsWith("{")) {
			const parsed = JSON.parse(raw) as unknown;
			if (!isRecord(parsed)) return {};
			const out: Record<string, boolean> = {};
			for (const [key, value] of Object.entries(parsed)) {
				if (value) out[key] = true;
			}
			return out;
		}
	} catch {
		return {};
	}
	const out: Record<string, boolean> = {};
	for (const line of raw.split("\n")) {
		if (line.trim()) out[line.trim()] = true;
	}
	return out;
}

async function copyIfMissing(from: string, to: string): Promise<boolean> {
	if (!(await pathExists(from)) || (await pathExists(to))) return false;
	await copyFile(from, to);
	return true;
}

export async function migrateLegacyLedger(paths: MeterPaths): Promise<string | undefined> {
	const notes: string[] = [];
	await withDirectoryLock(paths.dataDir, ".ledger-migration.lock", async () => {
		if (await copyIfMissing(paths.legacyUsageFile, paths.usageFile)) {
			await unlink(paths.legacyUsageFile);
			notes.push(`usage.jsonl ${paths.legacyUsageFile} → ${paths.usageFile}`);
		}
		if (await copyIfMissing(paths.legacyBudgetsFile, paths.budgetsFile)) {
			await unlink(paths.legacyBudgetsFile);
			notes.push(`budgets.json ${paths.legacyBudgetsFile} → ${paths.budgetsFile}`);
		}
		if (await copyIfMissing(paths.legacyWarnedFile, paths.warnedFile)) {
			await unlink(paths.legacyWarnedFile);
			notes.push(`warned.jsonl ${paths.legacyWarnedFile} → ${paths.warnedFile}`);
		}
	});
	return notes.length > 0 ? `Migrated local meter ledger from analytics/: ${notes.join("; ")}.` : undefined;
}

export class FileLedgerStore implements LedgerStore {
	constructor(private readonly paths: MeterPaths) {}

	async append(record: UsageRecord): Promise<boolean> {
		try {
			await ensurePrivateDir(this.paths.dataDir);
			await appendFile(this.paths.usageFile, `${JSON.stringify(serializeUsageRecord(record))}\n`, "utf8");
			return true;
		} catch {
			return false;
		}
	}

	async readAll(): Promise<UsageRecord[]> {
		const raw = await readTextFile(this.paths.usageFile);
		if (!raw) return [];
		const records: UsageRecord[] = [];
		for (const line of raw.split("\n")) {
			const record = parseUsageLine(line);
			if (record) records.push(record);
		}
		return records;
	}

	async loadBudgets(): Promise<BudgetsConfig> {
		return parseBudgets(await readTextFile(this.paths.budgetsFile));
	}

	async saveBudgets(config: BudgetsConfig): Promise<void> {
		await writeFileAtomically(this.paths.budgetsFile, `${JSON.stringify(config, null, 2)}\n`);
	}

	async loadWarned(): Promise<Record<string, boolean>> {
		return parseWarned(await readTextFile(this.paths.warnedFile));
	}

	async markWarned(keys: string[]): Promise<void> {
		if (keys.length === 0) return;
		try {
			await ensurePrivateDir(this.paths.dataDir);
			await appendFile(this.paths.warnedFile, keys.map((key) => `${key}\n`).join(""), "utf8");
		} catch {
			// in-memory flag still prevents re-fire this process
		}
	}
}

export async function createLedgerStore(agentDir = getAgentDir()): Promise<{ store: FileLedgerStore; migration?: string }> {
	const paths = getMeterPaths(agentDir);
	const migration = await migrateLegacyLedger(paths);
	return { store: new FileLedgerStore(paths), ...(migration ? { migration } : {}) };
}
