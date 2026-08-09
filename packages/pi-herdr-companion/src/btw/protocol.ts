import type { BtwPayload, AgentMessage } from "./types.ts";

export const MERGE_PROTOCOL_VERSION = 1 as const;
export const MERGE_REQUEST_FILE = "merge-request.json";
export const MERGE_STATE_FILE = "merge-state.json";
export const MERGE_ACK_FILE = "merge-ack.json";
export const LAUNCH_STATE_FILE = "launch-state.json";
export const MERGE_MESSAGE_CUSTOM_TYPE = "pi-herdr-companion.btw-merge";
export const MERGE_PHASE_CUSTOM_TYPE = "pi-herdr-companion.btw-merge-phase";
export const MAX_MERGE_SUMMARY_BYTES = 64 * 1024;
export const MAX_MERGE_PROMPT_BYTES = 16 * 1024;
export const MERGE_TRANSCRIPT_BUDGET_BYTES = 48 * 1024;
export const TRANSCRIPT_TRUNCATION_NOTE = "[earlier side-thread turns omitted to fit the merge budget]";

export type MergePhase = "message_appended" | "prompt_submitted" | "acked";

export interface MergeRequest {
	protocolVersion: typeof MERGE_PROTOCOL_VERSION;
	requestId: string;
	launchId: string;
	parentSessionId: string;
	capability: string;
	createdAt: string;
	summary: string;
	prompt: string;
}

export interface MergeDispatchLease {
	id: string;
	startedAt: string;
}

export interface MergeState {
	protocolVersion: typeof MERGE_PROTOCOL_VERSION;
	requestId: string;
	phase: MergePhase;
	updatedAt: string;
	dispatch?: MergeDispatchLease;
}

export interface MergeAck {
	protocolVersion: typeof MERGE_PROTOCOL_VERSION;
	requestId: string;
	status: "accepted" | "rejected";
	processedAt: string;
	reason?: string;
}

export interface LaunchState {
	version: 1;
	launchId: string;
	paneId?: string;
	status: "payload_created" | "pane_created" | "child_ready";
	updatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMergeSummaryWithinBounds(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.length > 0 && Buffer.byteLength(trimmed, "utf8") <= MAX_MERGE_SUMMARY_BYTES;
}

export function isMergePromptWithinBounds(value: string): boolean {
	const trimmed = value.trim();
	return trimmed.length > 0 && Buffer.byteLength(trimmed, "utf8") <= MAX_MERGE_PROMPT_BYTES;
}

export function isMergeRequest(value: unknown): value is MergeRequest {
	if (!isRecord(value) || value.protocolVersion !== MERGE_PROTOCOL_VERSION) return false;
	return typeof value.requestId === "string" && value.requestId.length > 0 &&
		typeof value.launchId === "string" && value.launchId.length > 0 &&
		typeof value.parentSessionId === "string" && value.parentSessionId.length > 0 &&
		typeof value.capability === "string" && value.capability.length >= 32 &&
		typeof value.createdAt === "string" &&
		typeof value.summary === "string" && isMergeSummaryWithinBounds(value.summary) &&
		typeof value.prompt === "string" && isMergePromptWithinBounds(value.prompt);
}

export function isMergeState(value: unknown): value is MergeState {
	if (!isRecord(value) || value.protocolVersion !== MERGE_PROTOCOL_VERSION) return false;
	if (typeof value.requestId !== "string" || !value.requestId) return false;
	if (value.phase !== "message_appended" && value.phase !== "prompt_submitted" && value.phase !== "acked") return false;
	if (typeof value.updatedAt !== "string") return false;
	if (value.dispatch !== undefined) {
		if (!isRecord(value.dispatch) || typeof value.dispatch.id !== "string" || typeof value.dispatch.startedAt !== "string") return false;
	}
	return true;
}

export function isMergeAck(value: unknown): value is MergeAck {
	return isRecord(value) && value.protocolVersion === MERGE_PROTOCOL_VERSION &&
		typeof value.requestId === "string" && value.requestId.length > 0 &&
		(value.status === "accepted" || value.status === "rejected") &&
		typeof value.processedAt === "string" &&
		(value.reason === undefined || typeof value.reason === "string");
}

export function isLaunchState(value: unknown): value is LaunchState {
	return isRecord(value) && value.version === 1 &&
		typeof value.launchId === "string" && value.launchId.length > 0 &&
		(value.paneId === undefined || typeof value.paneId === "string") &&
		(value.status === "payload_created" || value.status === "pane_created" || value.status === "child_ready") &&
		typeof value.updatedAt === "string";
}

export function ackMatchesRequest(ack: unknown, request: unknown): boolean {
	if (!isMergeAck(ack)) return false;
	const requestId = isRecord(request) && typeof request.requestId === "string" ? request.requestId : "unknown";
	return ack.requestId === requestId;
}

export function validateRequestAgainstPayload(request: MergeRequest, payload: BtwPayload): string | undefined {
	if (request.launchId !== payload.launchId) return "launch ID mismatch";
	if (request.capability !== payload.capability) return "capability mismatch";
	if (request.parentSessionId !== payload.parentSessionId) return "parent session mismatch";
	return undefined;
}

export function buildMergeMessageContent(summary: string): string {
	return `Merged from /btw (side-thread transcript)\n\n<btw-merge>\n${summary.trim()}\n</btw-merge>`;
}

function textContent(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((block): block is { type: "text"; text: string } =>
			isRecord(block) && block.type === "text" && typeof block.text === "string")
		.map((block) => block.text)
		.join("\n")
		.trim();
}

function tailUtf8(text: string, maximumBytes: number): string {
	let result = text;
	while (Buffer.byteLength(result, "utf8") > maximumBytes) {
		const excess = Buffer.byteLength(result, "utf8") - maximumBytes;
		result = result.slice(Math.max(1, Math.ceil(excess / 2)));
	}
	return result;
}

/** User/assistant text only; tool calls, thinking, images, and tool results are excluded. */
export function buildMergeTranscript(messages: readonly AgentMessage[], budgetBytes = MERGE_TRANSCRIPT_BUDGET_BYTES): string | undefined {
	const turns: string[] = [];
	for (const message of messages) {
		const candidate = message as { role?: string; content?: unknown };
		if (candidate.role !== "user" && candidate.role !== "assistant") continue;
		const text = textContent(candidate.content);
		if (text) turns.push(`${candidate.role === "user" ? "User" : "Assistant"}:\n${text}`);
	}
	if (turns.length === 0) return undefined;

	const kept: string[] = [];
	let used = 0;
	for (let index = turns.length - 1; index >= 0; index -= 1) {
		const turn = turns[index] as string;
		const bytes = Buffer.byteLength(turn, "utf8") + 2;
		if (used + bytes > budgetBytes) {
			kept.unshift(kept.length === 0
				? `${TRANSCRIPT_TRUNCATION_NOTE}\n${tailUtf8(turn, Math.max(1, budgetBytes - Buffer.byteLength(TRANSCRIPT_TRUNCATION_NOTE, "utf8") - 1))}`
				: TRANSCRIPT_TRUNCATION_NOTE);
			break;
		}
		kept.unshift(turn);
		used += bytes;
	}
	const transcript = kept.join("\n\n");
	if (Buffer.byteLength(transcript, "utf8") <= budgetBytes) return transcript;
	const noteBytes = Buffer.byteLength(`${TRANSCRIPT_TRUNCATION_NOTE}\n`, "utf8");
	return `${TRANSCRIPT_TRUNCATION_NOTE}\n${tailUtf8(transcript, Math.max(1, budgetBytes - noteBytes))}`;
}

export function textOfUserMessage(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "user") return undefined;
	const text = textContent(message.content);
	return text || undefined;
}
