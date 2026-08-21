import { isRecord } from "../fs.ts";
import type { UsageRecord } from "./types.ts";

export interface ParsedSession {
	cwd: string | null;
	sid: string;
	records: UsageRecord[];
	skipped: number;
}

export function usageFromAssistantMessage(
	message: unknown,
	meta: { sid: string; cwd: string },
): UsageRecord | undefined {
	if (!isAssistantUsage(message)) return undefined;
	const ts = messageTimestamp(message);
	if (ts === undefined) return undefined;
	const usage = message.usage;
	const cost = isRecord(usage.cost) && typeof usage.cost.total === "number" ? usage.cost.total : 0;
	const provider = typeof message.provider === "string" ? message.provider : "unknown";
	const model = typeof message.model === "string" ? message.model : "unknown";
	return {
		ts,
		sid: meta.sid,
		cwd: meta.cwd,
		model: `${provider}/${model}`,
		in: num(usage.input),
		out: num(usage.output),
		cR: num(usage.cacheRead),
		cW: num(usage.cacheWrite),
		tot: num(usage.totalTokens),
		cost,
		costKnown: isRecord(usage.cost) && typeof usage.cost.total === "number",
	};
}

export function assistantUsageWithoutTimestamp(message: unknown): boolean {
	return isAssistantUsage(message) && messageTimestamp(message) === undefined;
}

export function parseSession(content: string, sid: string): ParsedSession {
	let cwd: string | null = null;
	let skipped = 0;
	const records: UsageRecord[] = [];

	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (!isRecord(entry)) continue;
		if (entry.type === "session" && typeof entry.cwd === "string" && !cwd) {
			cwd = entry.cwd;
			continue;
		}
		if (entry.type !== "message") continue;
		const rec = usageFromAssistantMessage(entry.message, { sid, cwd: cwd ?? "" });
		if (rec) {
			records.push(rec);
			continue;
		}
		if (assistantUsageWithoutTimestamp(entry.message)) skipped += 1;
	}

	return { cwd, sid, records, skipped };
}

/** Live capture and import identity: assistant `message.timestamp` (Unix ms). */
export function recordKey(record: UsageRecord): string {
	return `${record.ts}|${record.sid}|${record.model}`;
}

/** Same turn when live used message start and an old import used entry persist time. */
export function payloadKey(record: UsageRecord): string {
	return `${record.sid}|${record.model}|${record.in}|${record.out}|${record.cR}|${record.cW}|${record.tot}`;
}

export function collapseDuplicateRecords(records: readonly UsageRecord[]): UsageRecord[] {
	const winner = new Map<string, number>();
	for (let i = 0; i < records.length; i++) {
		const record = records[i];
		if (!record) continue;
		const key = payloadKey(record);
		const prevIndex = winner.get(key);
		const previous = prevIndex === undefined ? undefined : records[prevIndex];
		if (previous === undefined || record.ts < previous.ts) winner.set(key, i);
	}
	const keep = new Set(winner.values());
	return records.filter((_, i) => keep.has(i));
}

export function diffRecords(existing: readonly UsageRecord[], incoming: readonly UsageRecord[]): UsageRecord[] {
	const seenExact = new Set(existing.map(recordKey));
	const seenPayload = new Set(existing.map(payloadKey));
	const fresh: UsageRecord[] = [];
	for (const record of incoming) {
		const exact = recordKey(record);
		const payload = payloadKey(record);
		if (seenExact.has(exact) || seenPayload.has(payload)) continue;
		seenExact.add(exact);
		seenPayload.add(payload);
		fresh.push(record);
	}
	return fresh;
}

function isAssistantUsage(message: unknown): message is Record<string, unknown> & { usage: Record<string, unknown> } {
	return isRecord(message) && message.role === "assistant" && isRecord(message.usage);
}

function messageTimestamp(message: Record<string, unknown>): number | undefined {
	if (typeof message.timestamp === "number" && Number.isFinite(message.timestamp)) return message.timestamp;
	return undefined;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
