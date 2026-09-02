import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { parseConsultLog, type ConsultAdoption } from "./events.ts";
import { CONSULT_TOOL_NAME } from "./messages.ts";
import { isRecord } from "./types.ts";

export interface ResolvedConsultAdoptions {
	adoptions: Map<string, ConsultAdoption>;
	pendingToolCallId?: string;
}

function assistantText(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "assistant" || !Array.isArray(message.content)) return undefined;
	return message.content
		.filter((part) => isRecord(part) && part.type === "text" && typeof part.text === "string")
		.map((part) => (part as { text: string }).text)
		.join("\n");
}

function successfulConsultToolCallId(message: unknown): string | undefined {
	if (!isRecord(message) || message.role !== "toolResult" || message.toolName !== CONSULT_TOOL_NAME) return undefined;
	if (message.isError === true || typeof message.toolCallId !== "string") return undefined;
	if (isRecord(message.details) && isRecord(message.details.envelope) && message.details.envelope.error) return undefined;
	return message.toolCallId;
}

export function resolveConsultAdoptions(entries: readonly SessionEntry[]): ResolvedConsultAdoptions {
	const adoptions = new Map<string, ConsultAdoption>();
	let pendingToolCallId: string | undefined;

	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const message = entry.message;
		if (isRecord(message) && message.role === "user") {
			pendingToolCallId = undefined;
			continue;
		}
		if (isRecord(message) && message.role === "toolResult" && message.toolName === CONSULT_TOOL_NAME) {
			pendingToolCallId = successfulConsultToolCallId(message);
			continue;
		}
		const text = assistantText(message);
		if (!text || !pendingToolCallId) continue;
		const adoption = parseConsultLog(text);
		if (!adoption) continue;
		if (!adoptions.has(pendingToolCallId)) adoptions.set(pendingToolCallId, adoption);
		pendingToolCallId = undefined;
	}

	return { adoptions, ...(pendingToolCallId ? { pendingToolCallId } : {}) };
}

export class ConsultAdoptionStore {
	private adoptions = new Map<string, ConsultAdoption>();
	private invalidators = new Map<string, () => void>();
	private pendingToolCallId: string | undefined;

	restore(entries: readonly SessionEntry[]): void {
		const resolved = resolveConsultAdoptions(entries);
		this.adoptions = resolved.adoptions;
		this.pendingToolCallId = resolved.pendingToolCallId;
		for (const toolCallId of this.adoptions.keys()) this.invalidators.get(toolCallId)?.();
	}

	watch(toolCallId: string, invalidate: () => void): void {
		this.invalidators.set(toolCallId, invalidate);
	}

	get(toolCallId: string | undefined): ConsultAdoption | undefined {
		return toolCallId ? this.adoptions.get(toolCallId) : undefined;
	}

	markConsult(toolCallId: string): void {
		this.pendingToolCallId = toolCallId;
	}

	clearPending(): void {
		this.pendingToolCallId = undefined;
	}

	recordLatest(adoption: ConsultAdoption): string | undefined {
		const toolCallId = this.pendingToolCallId;
		this.pendingToolCallId = undefined;
		if (!toolCallId || this.adoptions.has(toolCallId)) return undefined;
		this.adoptions.set(toolCallId, adoption);
		this.invalidators.get(toolCallId)?.();
		return toolCallId;
	}
}
