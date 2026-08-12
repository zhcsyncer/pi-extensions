import { randomBytes, randomUUID } from "node:crypto";
import type { SessionContext } from "@earendil-works/pi-coding-agent";

export const BTW_PAYLOAD_VERSION = 1 as const;
export const BTW_PAYLOAD_ENV = "PI_HERDR_COMPANION_BTW_PAYLOAD";
export const BTW_LAUNCH_DRAFT_ARG = "--launch-draft";
export const BTW_LAUNCH_DRAFT_COMMAND = `/btw ${BTW_LAUNCH_DRAFT_ARG}`;

export type AgentMessage = SessionContext["messages"][number];

export interface ParentContextMetadata {
	generatedAt: string;
	cwd: string;
	session: string;
	model: string;
}

export interface BtwPayload {
	version: typeof BTW_PAYLOAD_VERSION;
	createdAt: string;
	launchId: string;
	capability: string;
	parentSessionId: string;
	parentPaneId: string;
	metadata: ParentContextMetadata;
	parentSystemPrompt: string | null;
	parentSystemPromptFingerprint?: string | null;
	parentActiveTools: string[];
	/** Missing only on pre-fingerprint private payloads; those always use flattened replay. */
	parentToolSchemaFingerprint?: string | null;
	parentThinkingLevel: string;
	messages: AgentMessage[];
	draftQuestion: string;
}

export interface CreateBtwPayloadOptions extends Omit<
	BtwPayload,
	"version" | "launchId" | "capability" | "parentSystemPromptFingerprint" | "parentToolSchemaFingerprint"
> {
	launchId?: string;
	capability?: string;
	parentSystemPromptFingerprint?: string | null;
	parentToolSchemaFingerprint?: string | null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function createBtwPayload(options: CreateBtwPayloadOptions): BtwPayload {
	return {
		version: BTW_PAYLOAD_VERSION,
		createdAt: options.createdAt,
		launchId: options.launchId ?? randomUUID(),
		capability: options.capability ?? randomBytes(32).toString("hex"),
		parentSessionId: options.parentSessionId,
		parentPaneId: options.parentPaneId,
		metadata: { ...options.metadata },
		parentSystemPrompt: options.parentSystemPrompt,
		parentSystemPromptFingerprint: options.parentSystemPromptFingerprint ?? null,
		parentActiveTools: [...options.parentActiveTools],
		parentToolSchemaFingerprint: options.parentToolSchemaFingerprint ?? null,
		parentThinkingLevel: options.parentThinkingLevel,
		messages: options.messages,
		draftQuestion: options.draftQuestion,
	};
}

export function isBtwPayload(value: unknown): value is BtwPayload {
	if (!isRecord(value) || value.version !== BTW_PAYLOAD_VERSION) return false;
	if (typeof value.createdAt !== "string" || !Number.isFinite(Date.parse(value.createdAt))) return false;
	if (typeof value.launchId !== "string" || !value.launchId) return false;
	if (typeof value.capability !== "string" || value.capability.length < 32) return false;
	if (typeof value.parentSessionId !== "string" || !value.parentSessionId) return false;
	if (typeof value.parentPaneId !== "string" || !value.parentPaneId) return false;
	if (!isRecord(value.metadata) ||
		typeof value.metadata.generatedAt !== "string" ||
		typeof value.metadata.cwd !== "string" ||
		typeof value.metadata.session !== "string" ||
		typeof value.metadata.model !== "string") return false;
	if (value.parentSystemPrompt !== null && typeof value.parentSystemPrompt !== "string") return false;
	if (value.parentSystemPromptFingerprint !== undefined && value.parentSystemPromptFingerprint !== null &&
		typeof value.parentSystemPromptFingerprint !== "string") return false;
	if (!Array.isArray(value.parentActiveTools) || !value.parentActiveTools.every((item) => typeof item === "string")) return false;
	if (value.parentToolSchemaFingerprint !== undefined && value.parentToolSchemaFingerprint !== null &&
		typeof value.parentToolSchemaFingerprint !== "string") return false;
	if (typeof value.parentThinkingLevel !== "string") return false;
	if (!Array.isArray(value.messages) || !value.messages.every((message) => isRecord(message) && typeof message.role === "string")) return false;
	return typeof value.draftQuestion === "string";
}

export function buildChildPiArgs(payload: BtwPayload, model: string, thinking: string): string[] {
	return [
		"--no-session",
		"--model",
		model,
		"--thinking",
		thinking,
		...(payload.draftQuestion.trim() ? [BTW_LAUNCH_DRAFT_COMMAND] : []),
	];
}
