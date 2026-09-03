import { isRecord } from "../fs.ts";
import type { UsageRecord } from "./types.ts";

export interface ParsedSession {
	cwd: string | null;
	sid: string;
	records: UsageRecord[];
	skipped: number;
}

interface RecordMeta {
	sid: string;
	cwd: string;
}

function recordFromUsage(
	usage: Record<string, unknown>,
	meta: RecordMeta,
	ts: number,
	model: string,
	sourceId?: string,
): UsageRecord {
	const costValue = usage.cost;
	const cost = isRecord(costValue) && typeof costValue.total === "number"
		? costValue.total
		: typeof costValue === "number"
			? costValue
			: 0;
	const costKnown = (isRecord(costValue) && typeof costValue.total === "number") || typeof costValue === "number";
	return {
		ts,
		sid: meta.sid,
		cwd: meta.cwd,
		model,
		in: num(usage.input),
		out: num(usage.output),
		cR: num(usage.cacheRead),
		cW: num(usage.cacheWrite),
		tot: num(usage.totalTokens),
		cost,
		costKnown,
		...(sourceId ? { sourceId } : {}),
	};
}

export function usageFromAssistantMessage(message: unknown, meta: RecordMeta): UsageRecord | undefined {
	if (!isAssistantUsage(message)) return undefined;
	const ts = messageTimestamp(message);
	if (ts === undefined) return undefined;
	const provider = typeof message.provider === "string" ? message.provider : "unknown";
	const model = typeof message.model === "string" ? message.model : "unknown";
	const responseId = typeof message.responseId === "string" && message.responseId ? `:${message.responseId}` : "";
	return recordFromUsage(message.usage, meta, ts, `${provider}/${model}`, `assistant:${ts}${responseId}`);
}

function toolResultRawUsage(message: Record<string, unknown>): Array<{ model: string; usage: Record<string, unknown> }> {
	if (!isRecord(message.details) || !isRecord(message.details.envelope) || !Array.isArray(message.details.envelope.raw)) {
		return [];
	}
	return message.details.envelope.raw.flatMap((entry) =>
		isRecord(entry) && typeof entry.model === "string" && isRecord(entry.usage)
			? [{ model: entry.model, usage: entry.usage }]
			: [],
	);
}

function toolResultModel(message: Record<string, unknown>): string {
	if (isRecord(message.details) && Array.isArray(message.details.models)) {
		const models = message.details.models.filter((model): model is string => typeof model === "string" && model.length > 0);
		if (models.length === 1) return models[0] ?? "tool/unknown";
	}
	const toolName = typeof message.toolName === "string" && message.toolName ? message.toolName : "unknown";
	return `tool/${toolName}`;
}

export function usageFromToolResultMessage(message: unknown, meta: RecordMeta): UsageRecord[] {
	if (!isRecord(message) || message.role !== "toolResult") return [];
	const ts = messageTimestamp(message);
	if (ts === undefined) return [];
	const toolCallId = typeof message.toolCallId === "string" && message.toolCallId ? message.toolCallId : undefined;
	const raw = message.toolName === "consult" ? toolResultRawUsage(message) : [];
	if (raw.length > 0) {
		return raw.map((entry, index) =>
			recordFromUsage(entry.usage, meta, ts, entry.model, toolCallId ? `${toolCallId}:${index}` : undefined),
		);
	}
	if (!isRecord(message.usage)) return [];
	return [recordFromUsage(message.usage, meta, ts, toolResultModel(message), toolCallId)];
}

export function usageRecordsFromMessage(message: unknown, meta: RecordMeta): UsageRecord[] {
	const assistant = usageFromAssistantMessage(message, meta);
	return assistant ? [assistant] : usageFromToolResultMessage(message, meta);
}

export function usageMessageWithoutTimestamp(message: unknown): boolean {
	if (!isRecord(message) || messageTimestamp(message) !== undefined) return false;
	if (isAssistantUsage(message)) return true;
	if (message.role !== "toolResult") return false;
	return isRecord(message.usage) || toolResultRawUsage(message).length > 0;
}

/** Kept for extensions importing the older assistant-specific helper. */
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
		const parsed = usageRecordsFromMessage(entry.message, { sid, cwd: cwd ?? "" });
		if (parsed.length > 0) {
			records.push(...parsed);
			continue;
		}
		if (usageMessageWithoutTimestamp(entry.message)) skipped += 1;
	}

	return { cwd, sid, records, skipped };
}

/** Live capture and import identity; tool results add their stable tool-call source id. */
export function recordKey(record: UsageRecord): string {
	return `${record.ts}|${record.sid}|${record.model}${record.sourceId ? `|${record.sourceId}` : ""}`;
}

/** Same usage when live capture and history import observe the same underlying message. */
function legacyPayloadKey(record: UsageRecord): string {
	return `${record.sid}|${record.model}|${record.in}|${record.out}|${record.cR}|${record.cW}|${record.tot}`;
}

export function payloadKey(record: UsageRecord): string {
	return `${legacyPayloadKey(record)}${record.sourceId ? `|${record.sourceId}` : ""}`;
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
	const legacyPayloads = new Map<string, number>();
	for (const record of existing) {
		if (record.sourceId) continue;
		const key = legacyPayloadKey(record);
		legacyPayloads.set(key, (legacyPayloads.get(key) ?? 0) + 1);
	}
	const fresh: UsageRecord[] = [];
	for (const record of incoming) {
		const exact = recordKey(record);
		if (seenExact.has(exact)) continue;
		if (record.sourceId) {
			const legacy = legacyPayloadKey(record);
			const remaining = legacyPayloads.get(legacy) ?? 0;
			if (remaining > 0) {
				legacyPayloads.set(legacy, remaining - 1);
				seenExact.add(exact);
				continue;
			}
		}
		seenExact.add(exact);
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
