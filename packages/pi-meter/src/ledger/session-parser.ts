import { isRecord } from "../fs.ts";
import type { UsageRecord } from "./types.ts";

export interface ParsedSession {
	cwd: string | null;
	sid: string;
	records: UsageRecord[];
}

export function usageFromAssistantMessage(
	message: unknown,
	meta: { ts: number; sid: string; cwd: string },
): UsageRecord | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !isRecord(message.usage)) return undefined;
	const usage = message.usage;
	const cost = isRecord(usage.cost) && typeof usage.cost.total === "number" ? usage.cost.total : 0;
	const provider = typeof message.provider === "string" ? message.provider : "unknown";
	const model = typeof message.model === "string" ? message.model : "unknown";
	return {
		ts: meta.ts,
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

export function parseSession(content: string, sid: string): ParsedSession {
	let cwd: string | null = null;
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
		const ts = typeof entry.timestamp === "string"
			? Date.parse(entry.timestamp)
			: Number(entry.timestamp) || 0;
		const rec = usageFromAssistantMessage(entry.message, { ts, sid, cwd: cwd ?? "" });
		if (rec) records.push(rec);
	}

	return { cwd, sid, records };
}

export function recordKey(record: UsageRecord): string {
	return `${record.ts}|${record.sid}|${record.model}`;
}

export function diffRecords(existing: readonly UsageRecord[], incoming: readonly UsageRecord[]): UsageRecord[] {
	const seen = new Set(existing.map(recordKey));
	return incoming.filter((record) => !seen.has(recordKey(record)));
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
