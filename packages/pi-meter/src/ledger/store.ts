import { appendFile, copyFile, stat } from "node:fs/promises";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { ensurePrivateDir, isRecord, pathExists, readTextFile, withDirectoryLock, writeFileAtomically } from "../fs.ts";
import { getMeterPaths, type MeterPaths } from "../paths.ts";
import { collapseDuplicateRecords, diffRecords, recordKey, type DiffOptions } from "./session-parser.ts";
import { isSummaryKind, type BudgetLimit, type BudgetsConfig, type UsageRecord } from "./types.ts";

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
		record.sourceId ?? null,
		...(record.kind || record.entryId || record.usageKind ? [record.kind ?? null] : []),
		...(record.entryId || record.usageKind ? [{ entryId: record.entryId, part: record.part, usageKind: record.usageKind }] : []),
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
		costKnown: validCost(value[9]) && (value.length > 10 ? value[10] === 1 : cost > 0),
		...(typeof value[11] === "string" && value[11] ? { sourceId: value[11] } : {}),
		...(isSummaryKind(value[12]) ? { kind: value[12] } : {}),
		...identityFields(value[13]),
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
		costKnown: validCost(value.cost) && (value.costKnown === true || (value.costKnown !== false && asNumber(value.cost) > 0)),
		...(typeof value.sourceId === "string" && value.sourceId ? { sourceId: value.sourceId } : {}),
		...(isSummaryKind(value.kind) ? { kind: value.kind } : {}),
		...identityFields(value),
	};
}

function identityFields(value: unknown): Pick<UsageRecord, "entryId" | "part" | "usageKind"> {
	if (!isRecord(value)) return {};
	return {
		...(typeof value.entryId === "string" && value.entryId ? { entryId: value.entryId } : {}),
		...(typeof value.part === "string" && value.part ? { part: value.part } : {}),
		...(typeof value.usageKind === "string" ? { usageKind: value.usageKind } : {}),
	};
}

function validCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
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
			// Retain the original legacy file; adapting identities is not a destructive migration.
			notes.push(`usage.jsonl ${paths.legacyUsageFile} → ${paths.usageFile}`);
		}
		if (await copyIfMissing(paths.legacyBudgetsFile, paths.budgetsFile)) {
			notes.push(`budgets.json ${paths.legacyBudgetsFile} → ${paths.budgetsFile}`);
		}
		if (await copyIfMissing(paths.legacyWarnedFile, paths.warnedFile)) {
			notes.push(`warned.jsonl ${paths.legacyWarnedFile} → ${paths.warnedFile}`);
		}
	});
	return notes.length > 0 ? `Migrated local meter ledger from analytics/: ${notes.join("; ")}.` : undefined;
}

export class FileLedgerStore implements LedgerStore {
	private stamp = "";
	private cached: UsageRecord[] = [];
	private keys = new Set<string>();
	private sessionAliases = new Map<string, string>();
	private queue: Promise<unknown> = Promise.resolve();

	private serial<T>(action: () => Promise<T>): Promise<T> {
		const next = this.queue.then(action);
		this.queue = next.catch(() => {});
		return next;
	}

	constructor(private readonly paths: MeterPaths) {}

	private async fileStamp(): Promise<string> {
		try {
			const info = await stat(this.paths.usageFile);
			return `${info.ino}:${info.size}:${info.mtimeMs}:${info.ctimeMs}`;
		} catch (error) {
			if (isRecord(error) && error.code === "ENOENT") return "missing";
			throw error;
		}
	}

	async append(record: UsageRecord): Promise<boolean> {
		try {
			return (await this.appendRecords([record], { legacyMatching: false })).length > 0;
		} catch {
			return false;
		}
	}

	/** One lock for live, import and other Meter instances sharing this ledger. */
	async appendRecords(records: readonly UsageRecord[], options: DiffOptions = { legacyMatching: false }): Promise<UsageRecord[]> {
		// Read-side aliases keep session budgets attached to the same actual session
		// without rewriting old rows when live capture switches to header identity.
		for (const [alias, sid] of options.sessionAliases ?? []) this.sessionAliases.set(alias, sid);
		if (records.length === 0) return [];
		return this.serial(() => withDirectoryLock(this.paths.dataDir, ".usage.lock", async () => {
			await this.refresh();
			const batch = new Set<string>();
			const fresh = options.legacyMatching === false
				? records.filter((record) => {
					const key = recordKey(record);
					if (this.keys.has(key) || batch.has(key)) return false;
					batch.add(key);
					return true;
				})
				: diffRecords(this.cached, records, options);
			if (fresh.length === 0) return [];
			await appendFile(this.paths.usageFile, fresh.map((record) => `${JSON.stringify(serializeUsageRecord(record))}\n`).join(""), "utf8");
			if (fresh.every((record) => record.entryId)) {
				this.cached.push(...fresh);
				for (const record of fresh) this.keys.add(recordKey(record));
			} else {
				this.cached = collapseDuplicateRecords([...this.cached, ...fresh]);
				this.keys = new Set(this.cached.map(recordKey));
			}
			this.stamp = await this.fileStamp();
			return fresh;
		}));
	}

	async replaceAll(records: readonly UsageRecord[]): Promise<void> {
		await this.serial(() => withDirectoryLock(this.paths.dataDir, ".usage.lock", async () => {
			const body = records.map((record) => `${JSON.stringify(serializeUsageRecord(record))}\n`).join("");
			await writeFileAtomically(this.paths.usageFile, body);
			this.stamp = "";
		}));
	}

	/** Compatibility entrypoint: duplicate suppression is now read-side only. */
	async compactDuplicates(): Promise<number> {
		await this.readAll();
		return 0;
	}

	private async refresh(): Promise<void> {
		const stamp = await this.fileStamp();
		if (stamp !== this.stamp) {
			const raw = await readTextFile(this.paths.usageFile);
			const records: UsageRecord[] = [];
			for (const line of (raw ?? "").split("\n")) {
				const record = parseUsageLine(line);
				if (record) records.push(record);
			}
			// Preserve old budget totals without rewriting or deleting legacy rows.
			this.cached = collapseDuplicateRecords(records);
			this.keys = new Set(this.cached.map(recordKey));
			this.stamp = stamp;
		}
	}

	async readAll(): Promise<UsageRecord[]> {
		return this.serial(async () => {
			await this.refresh();
			return this.cached.map((record) => !record.entryId && this.sessionAliases.has(record.sid)
				? { ...record, sid: this.sessionAliases.get(record.sid)! } : { ...record });
		});
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
	const store = new FileLedgerStore(paths);
	return { store, ...(migration ? { migration } : {}) };
}
