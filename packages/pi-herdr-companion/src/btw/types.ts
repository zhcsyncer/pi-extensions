import { randomBytes, randomUUID } from "node:crypto";
import type { SessionContext } from "@earendil-works/pi-coding-agent";
import {
	BTW_TOOL_MODES,
	THINKING_LEVELS,
	isModelName,
	type CompanionConfig,
	type ThinkingLevel,
} from "../config.ts";

export const BTW_PAYLOAD_VERSION = 1 as const;
export const BTW_PAYLOAD_ENV = "PI_HERDR_COMPANION_BTW_PAYLOAD";
export const BTW_LAUNCH_DRAFT_ARG = "--launch-draft";
export const BTW_LAUNCH_DRAFT_COMMAND = `/btw ${BTW_LAUNCH_DRAFT_ARG}`;

export type AgentMessage = SessionContext["messages"][number];
export type BtwConfig = CompanionConfig["btw"];

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
	config: BtwConfig;
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
		config: { ...options.config },
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
	if (typeof value.draftQuestion !== "string") return false;
	if (!isRecord(value.config) || typeof value.config.autoSubmit !== "boolean") return false;
	if (value.config.model !== "inherit" && (typeof value.config.model !== "string" || !isModelName(value.config.model))) return false;
	if (value.config.thinking !== "inherit" && !THINKING_LEVELS.includes(value.config.thinking as ThinkingLevel)) return false;
	if (!BTW_TOOL_MODES.includes(value.config.tools as BtwConfig["tools"])) return false;
	return value.config.split === "down" || value.config.split === "right";
}

export function buildChildPiArgs(payload: BtwPayload, model: string, thinking: string): string[] {
	const toolArgs = payload.config.tools === "inherit"
		? payload.parentActiveTools.length > 0
			? ["--tools", payload.parentActiveTools.join(",")]
			: ["--no-tools"]
		: payload.config.tools === "read-only"
			? ["--tools", "read,grep,find,ls"]
			: payload.config.tools === "none"
				? ["--no-tools"]
				: [];
	return [
		"--no-session",
		"--model",
		model,
		"--thinking",
		thinking,
		...toolArgs,
		...(payload.config.autoSubmit && payload.draftQuestion.trim() ? [BTW_LAUNCH_DRAFT_COMMAND] : []),
	];
}
