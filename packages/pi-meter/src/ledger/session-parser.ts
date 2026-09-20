import { isRecord } from "../fs.ts";
import { isSummaryKind, type SummaryKind, type UsageRecord } from "./types.ts";

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
	kind?: SummaryKind,
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
		...(kind ? { kind } : {}),
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

/** Child sessions own per-message accounting; parent rollups remain available to Pi's native stats. */
function isSubagentUsageRollup(message: Record<string, unknown>): boolean {
	// Upstream Agent results may carry usage without our explicit rollup marker.
	if (message.toolName === "Agent") return true;
	if (message.toolName !== "get_subagent_result" || !isRecord(message.details)) return false;
	const rollup = message.details.subagentUsageRollup;
	return isRecord(rollup) && rollup.version === 1 && typeof rollup.agentId === "string";
}

export function usageFromToolResultMessage(message: unknown, meta: RecordMeta): UsageRecord[] {
	if (!isRecord(message) || message.role !== "toolResult" || isSubagentUsageRollup(message)) return [];
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
	if (message.role !== "toolResult" || isSubagentUsageRollup(message)) return false;
	return isRecord(message.usage) || toolResultRawUsage(message).length > 0;
}

/** Kept for extensions importing the older assistant-specific helper. */
export function assistantUsageWithoutTimestamp(message: unknown): boolean {
	return isAssistantUsage(message) && messageTimestamp(message) === undefined;
}

export function usageFromSessionSummaryEntry(
	entry: unknown,
	meta: RecordMeta,
	model: string,
): UsageRecord | undefined {
	if (!isRecord(entry) || !isSummaryKind(entry.type) || !isRecord(entry.usage)) return undefined;
	const ts = sessionEntryTimestamp(entry);
	if (ts === undefined) return undefined;
	const id = typeof entry.id === "string" && entry.id ? entry.id : undefined;
	if (!id) return undefined;
	const label = model || "unknown/unknown";
	return recordFromUsage(entry.usage, meta, ts, label, `${entry.type}:${id}`, entry.type);
}

export function summaryUsageWithoutTimestamp(entry: unknown): boolean {
	return isRecord(entry) && isSummaryKind(entry.type) && isRecord(entry.usage) && sessionEntryTimestamp(entry) === undefined;
}

export function parseSession(content: string, sid: string): ParsedSession {
	let cwd: string | null = null;
	let skipped = 0;
	let lastModel = "unknown/unknown";
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
		const changed = modelChangeLabel(entry);
		if (changed) {
			lastModel = changed;
			continue;
		}
		const meta = { sid, cwd: cwd ?? "" };
		if (entry.type === "message") {
			const assistantModel = assistantModelLabel(entry.message);
			if (assistantModel) lastModel = assistantModel;
			const parsed = usageRecordsFromMessage(entry.message, meta);
			if (parsed.length > 0) {
				records.push(...parsed);
				continue;
			}
			if (usageMessageWithoutTimestamp(entry.message)) skipped += 1;
			continue;
		}
		const summary = usageFromSessionSummaryEntry(entry, meta, lastModel);
		if (summary) {
			records.push(summary);
			continue;
		}
		if (summaryUsageWithoutTimestamp(entry)) skipped += 1;
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

function sourceIdentity(record: UsageRecord): string | undefined {
	return record.sourceId ? `${record.sid}|${record.sourceId}` : undefined;
}

export function diffRecords(existing: readonly UsageRecord[], incoming: readonly UsageRecord[]): UsageRecord[] {
	const seenExact = new Set(existing.map(recordKey));
	const seenSource = new Set(
		existing.flatMap((record) => {
			const identity = sourceIdentity(record);
			return identity ? [identity] : [];
		}),
	);
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
		const identity = sourceIdentity(record);
		if (identity && seenSource.has(identity)) continue;
		if (record.sourceId) {
			const legacy = legacyPayloadKey(record);
			const remaining = legacyPayloads.get(legacy) ?? 0;
			if (remaining > 0) {
				legacyPayloads.set(legacy, remaining - 1);
				seenExact.add(exact);
				if (identity) seenSource.add(identity);
				continue;
			}
		}
		seenExact.add(exact);
		if (identity) seenSource.add(identity);
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

function sessionEntryTimestamp(entry: Record<string, unknown>): number | undefined {
	if (typeof entry.timestamp === "number" && Number.isFinite(entry.timestamp)) return entry.timestamp;
	if (typeof entry.timestamp !== "string" || !entry.timestamp) return undefined;
	const ts = Date.parse(entry.timestamp);
	return Number.isFinite(ts) ? ts : undefined;
}

function modelChangeLabel(entry: Record<string, unknown>): string | undefined {
	if (entry.type !== "model_change") return undefined;
	const provider = typeof entry.provider === "string" ? entry.provider : "unknown";
	const modelId = typeof entry.modelId === "string" ? entry.modelId : "unknown";
	return `${provider}/${modelId}`;
}

function assistantModelLabel(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant") return undefined;
	const provider = typeof message.provider === "string" ? message.provider : undefined;
	const model = typeof message.model === "string" ? message.model : undefined;
	if (!provider && !model) return undefined;
	return `${provider ?? "unknown"}/${model ?? "unknown"}`;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
