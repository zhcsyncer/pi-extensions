import { isRecord } from "../fs.ts";
import { isSummaryKind, type SummaryKind, type UsageRecord } from "./types.ts";

export interface ParsedSession {
	cwd: string | null;
	sid: string;
	records: UsageRecord[];
	skipped: number;
}

export interface SessionOrigin {
	sid: string;
	cwd: string;
}

type RecordMeta = SessionOrigin;

export interface ParseSessionOptions {
	origins?: ReadonlyMap<string, SessionOrigin>;
}

export interface DiffOptions {
	/** Only a complete source snapshot may match unidentified legacy rows. */
	legacyMatching?: boolean;
	sessionAliases?: ReadonlyMap<string, string>;
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
	const total = isRecord(costValue) ? costValue.total : costValue;
	const costKnown = validCost(total);
	// Partial reported components remain a subtotal, never a confirmed complete cost.
	const cost = costKnown ? total : isRecord(costValue)
		? [costValue.input, costValue.output, costValue.cacheRead, costValue.cacheWrite]
			.reduce<number>((sum, part) => sum + (validCost(part) ? part : 0), 0)
		: 0;
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

function toolResultRawUsage(message: Record<string, unknown>): Array<{ model: string; usage: Record<string, unknown>; index: number }> {
	if (!isRecord(message.details) || !isRecord(message.details.envelope) || !Array.isArray(message.details.envelope.raw)) {
		return [];
	}
	return message.details.envelope.raw.flatMap((entry, index) =>
		isRecord(entry) && typeof entry.model === "string" && isRecord(entry.usage)
			? [{ model: entry.model, usage: entry.usage, index }]
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
		return raw.map((entry) =>
			recordFromUsage(entry.usage, meta, ts, entry.model, toolCallId ? `${toolCallId}:${entry.index}` : undefined),
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
	model = "unknown/unknown",
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

export function parseSession(content: string, sid: string, options: ParseSessionOptions = {}): ParsedSession {
	const entries: Record<string, unknown>[] = [];
	for (const line of content.split("\n")) {
		if (!line.trim()) continue;
		let entry: unknown;
		try {
			entry = JSON.parse(line);
		} catch {
			continue;
		}
		if (isRecord(entry)) entries.push(entry);
	}
	const header = entries.find((entry) => entry.type === "session");
	const cwd = typeof header?.cwd === "string" ? header.cwd : null;
	if (typeof header?.id === "string" && header.id) sid = header.id;
	const records: UsageRecord[] = [];
	let skipped = 0;
	let lastModel = "unknown/unknown";
	const models = new Map<string, string>();
	for (const entry of entries) {
		const parentModel = typeof entry.parentId === "string" ? models.get(entry.parentId) : undefined;
		lastModel = modelChangeLabel(entry) ?? assistantModelLabel(entry.message) ?? parentModel ?? (entry.parentId === null ? "unknown/unknown" : lastModel);
		if (typeof entry.id === "string") models.set(entry.id, lastModel);
		const meta = (typeof entry.id === "string" ? options.origins?.get(entry.id) : undefined) ?? { sid, cwd: cwd ?? "" };
		const parsed = usageRecordsFromSessionEntry(entry, meta, lastModel);
		records.push(...parsed);
		if (parsed.length === 0 && (entry.type === "message" ? usageMessageWithoutTimestamp(entry.message)
			: summaryUsageWithoutTimestamp(entry) || (entry.type === "usage" && isRecord(entry.usage) && sessionEntryTimestamp(entry) === undefined))) skipped++;
	}
	return { cwd, sid, records, skipped };
}

/** Read finalized entries only. Execution events and context projections are not expenses. */
export function usageRecordsFromSessionEntry(entry: unknown, meta: SessionOrigin, model = "unknown/unknown"): UsageRecord[] {
	if (!isRecord(entry)) return [];
	let records: UsageRecord[] = [];
	if (entry.type === "message") {
		records = usageRecordsFromMessage(entry.message, meta);
		if (isRecord(entry.message) && entry.message.toolName === "consult") {
			const raw = toolResultRawUsage(entry.message);
			if (raw.length > 0) records = records.map((record, index) => ({ ...record, part: `raw:${raw[index].index}` }));
		}
	} else if (entry.type === "usage" && isRecord(entry.usage)) {
		const ts = sessionEntryTimestamp(entry);
		if (ts !== undefined) records = [{
			...recordFromUsage(entry.usage, meta, ts, `${typeof entry.provider === "string" ? entry.provider : "unknown"}/${typeof entry.model === "string" ? entry.model : "unknown"}`),
			...(typeof entry.kind === "string" ? { usageKind: entry.kind } : {}),
		}];
	} else {
		const summary = usageFromSessionSummaryEntry(entry, meta, model);
		if (summary) records = [summary];
	}
	return records.map((record) => ({ ...record, ...(typeof entry.id === "string" && entry.id ? { entryId: entry.id } : {}) }));
}

/** New records use finalized entry identity; the old key remains a legacy compatibility rule. */
export function recordKey(record: UsageRecord): string {
	return record.entryId ? JSON.stringify([record.sid, record.entryId, record.part ?? "whole"])
		: `${record.ts}|${record.sid}|${record.model}${record.sourceId ? `|${record.sourceId}` : ""}`;
}

/** Old-format compatibility only; equal payloads are not evidence of equal new entries. */
function legacyPayloadKey(record: UsageRecord): string {
	return `${record.sid}|${record.model}|${record.in}|${record.out}|${record.cR}|${record.cW}|${record.tot}`;
}

export function payloadKey(record: UsageRecord): string {
	return record.entryId ? recordKey(record) : `${legacyPayloadKey(record)}${record.sourceId ? `|${record.sourceId}` : ""}`;
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

export function diffRecords(existing: readonly UsageRecord[], incoming: readonly UsageRecord[], options: DiffOptions = {}): UsageRecord[] {
	const normalize = (record: UsageRecord): UsageRecord => record.entryId ? record : {
		...record, sid: options.sessionAliases?.get(record.sid) ?? record.sid,
	};
	const old = existing.map(normalize);
	const seenExact = new Set(old.map(recordKey));
	const legacy = options.legacyMatching === false ? [] : old.filter((record) => !record.entryId);
	const used = new Set<number>();
	const unique = new Map<string, UsageRecord>();
	for (const value of incoming) {
		const record = normalize(value);
		if (!unique.has(recordKey(record))) unique.set(recordKey(record), record);
	}
	const pending = [...unique.values()].filter((record) => !seenExact.has(recordKey(record)));
	// Reserve explicit source matches before spending any old no-ID payload allowance.
	const matched = new Set<UsageRecord>();
	for (const record of pending) {
		const source = sourceIdentity(record);
		if (!source) continue;
		const index = legacy.findIndex((candidate, i) => !used.has(i) && sourceIdentity(candidate) === source);
		if (index >= 0) { used.add(index); matched.add(record); }
	}
	return pending.filter((record) => {
		if (matched.has(record)) return false;
		if (record.sourceId) {
			const index = legacy.findIndex((candidate, i) => !used.has(i) && !candidate.sourceId && legacyPayloadKey(candidate) === legacyPayloadKey(record));
			if (index >= 0) { used.add(index); return false; }
		}
		return true;
	});
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

function validCost(value: unknown): value is number {
	return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

function num(value: unknown): number {
	return typeof value === "number" && Number.isFinite(value) ? value : 0;
}
