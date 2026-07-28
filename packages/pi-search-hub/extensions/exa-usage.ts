import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { getExaUsagePath, getLegacyExaUsagePath } from "./paths.js";

const EXA_MONTHLY_LIMIT = 1000;
const EXA_WARNING_THRESHOLD = 800;
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 2_000;
const LOCK_RETRY_MS = 25;
const emittedNotices = new Set<string>();

interface ExaUsageRecord {
	count: number;
	resetAt: string;
}

interface LockedUsage {
	record?: ExaUsageRecord;
	notices: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function currentMonthStart(): string {
	const now = new Date();
	return new Date(now.getFullYear(), now.getMonth(), 1).toISOString();
}

function parseUsage(text: string): { record: ExaUsageRecord; dropped: string[] } {
	const value = JSON.parse(text) as unknown;
	if (!isRecord(value)) throw new Error("the root value must be a JSON object");
	if (typeof value.count !== "number" || !Number.isFinite(value.count) || value.count < 0) {
		throw new Error("count must be a non-negative number");
	}
	if (typeof value.resetAt !== "string" || Number.isNaN(Date.parse(value.resetAt))) {
		throw new Error("resetAt must be an ISO date string");
	}
	return {
		record: { count: Math.floor(value.count), resetAt: value.resetAt },
		dropped: Object.keys(value).filter((key) => key !== "count" && key !== "resetAt"),
	};
}

function emitOnce(message: string): void {
	if (emittedNotices.has(message)) return;
	emittedNotices.add(message);
	console.warn(message);
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch (error) {
		if (isRecord(error) && error.code === "ENOENT") return false;
		throw error;
	}
}

async function atomicWriteUsage(file: string, record: ExaUsageRecord): Promise<void> {
	const directory = dirname(file);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(record, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, file);
		await chmod(file, 0o600);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function withUsageLock<T>(fn: () => Promise<T>): Promise<T> {
	const usagePath = getExaUsagePath();
	const directory = dirname(usagePath);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const lockPath = join(directory, ".usage.lock");
	const deadline = Date.now() + LOCK_WAIT_MS;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	while (!handle) {
		try {
			handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			try {
				if (Date.now() - (await stat(lockPath)).mtimeMs > LOCK_STALE_MS) {
					await unlink(lockPath);
					continue;
				}
			} catch (statError) {
				if (isRecord(statError) && statError.code === "ENOENT") continue;
				throw statError;
			}
			if (Date.now() >= deadline) throw new Error(`timed out waiting for ${lockPath}`);
			await new Promise((resolve) => setTimeout(resolve, LOCK_RETRY_MS));
		}
	}
	try {
		return await fn();
	} finally {
		await handle.close();
		await rm(lockPath, { force: true });
	}
}

async function readUsageLocked(): Promise<LockedUsage> {
	const target = getExaUsagePath();
	const legacy = getLegacyExaUsagePath();
	const notices: string[] = [];
	if (await exists(target)) {
		try {
			const parsed = parseUsage(await readFile(target, "utf8"));
			if (parsed.dropped.length > 0) {
				await atomicWriteUsage(target, parsed.record);
				notices.push(`Search Hub upgraded Exa usage state at ${target}; dropped fields: ${parsed.dropped.join(", ")}.`);
			}
			if (await exists(legacy)) notices.push(`Search Hub ignored conflicting legacy Exa usage state at ${legacy}.`);
			return { record: parsed.record, notices };
		} catch (error) {
			return { notices: [`Search Hub could not read Exa usage state at ${target}: ${error instanceof Error ? error.message : String(error)}. The file was preserved.`] };
		}
	}
	if (!(await exists(legacy))) return { record: { count: 0, resetAt: currentMonthStart() }, notices };
	try {
		const parsed = parseUsage(await readFile(legacy, "utf8"));
		await atomicWriteUsage(target, parsed.record);
		const verified = parseUsage(await readFile(target, "utf8")).record;
		await unlink(legacy);
		notices.push(`Search Hub migrated Exa usage state from ${legacy} to ${target}${parsed.dropped.length > 0 ? `; dropped fields: ${parsed.dropped.join(", ")}` : ""}.`);
		return { record: verified, notices };
	} catch (error) {
		return { notices: [`Search Hub failed to migrate Exa usage state from ${legacy} to ${target}: ${error instanceof Error ? error.message : String(error)}. The legacy file was preserved.`] };
	}
}

function quotaWarning(usage: ExaUsageRecord): string | null {
	if (usage.resetAt !== currentMonthStart() || usage.count < EXA_WARNING_THRESHOLD) return null;
	const remaining = EXA_MONTHLY_LIMIT - usage.count;
	if (remaining <= 0) return `⚠️ Exa quota exhausted (${usage.count}/${EXA_MONTHLY_LIMIT}). Upgrade at https://exa.ai/pricing`;
	return `⚠️ Exa quota low (${remaining} remaining of ${EXA_MONTHLY_LIMIT}/month)`;
}

export async function checkExaUsage(): Promise<string | null> {
	try {
		return await withUsageLock(async () => {
			const loaded = await readUsageLocked();
			for (const notice of loaded.notices) emitOnce(notice);
			return loaded.notices[0] ?? (loaded.record ? quotaWarning(loaded.record) : null);
		});
	} catch (error) {
		const warning = `Search Hub failed to check Exa usage: ${error instanceof Error ? error.message : String(error)}.`;
		emitOnce(warning);
		return warning;
	}
}

export async function incrementExaUsage(): Promise<string | null> {
	try {
		return await withUsageLock(async () => {
			const loaded = await readUsageLocked();
			for (const notice of loaded.notices) emitOnce(notice);
			if (!loaded.record) return loaded.notices[0] ?? "Search Hub could not update Exa usage state.";
			const usage = loaded.record;
			const month = currentMonthStart();
			if (usage.resetAt !== month) {
				usage.count = 0;
				usage.resetAt = month;
			}
			usage.count++;
			await atomicWriteUsage(getExaUsagePath(), usage);
			if (loaded.notices.length > 0) return loaded.notices[0];
			if (usage.count === EXA_WARNING_THRESHOLD) {
				return `⚠️ Exa quota at ${EXA_WARNING_THRESHOLD}/${EXA_MONTHLY_LIMIT}. ${EXA_MONTHLY_LIMIT - usage.count} requests remaining this month.`;
			}
			if (usage.count > EXA_WARNING_THRESHOLD) return quotaWarning(usage);
			return null;
		});
	} catch (error) {
		const warning = `Search Hub failed to update Exa usage: ${error instanceof Error ? error.message : String(error)}.`;
		emitOnce(warning);
		return warning;
	}
}

export function resetExaUsageNoticesForTests(): void {
	emittedNotices.clear();
}
