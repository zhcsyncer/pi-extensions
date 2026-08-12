import { createHash } from "node:crypto";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";
import type { BtwPayload } from "./types.ts";

export type CacheMode =
	| { mode: "native" }
	| { mode: "flattened"; reason: string };

const UNSERIALIZABLE = Symbol("unserializable");

function canonicalJsonValue(value: unknown, seen: Set<object>): unknown | typeof UNSERIALIZABLE {
	if (value === null || typeof value === "string" || typeof value === "boolean") return value;
	if (typeof value === "number") return Number.isFinite(value) ? value : UNSERIALIZABLE;
	if (typeof value !== "object") return UNSERIALIZABLE;
	if (seen.has(value)) return UNSERIALIZABLE;
	seen.add(value);
	try {
		if (Array.isArray(value)) {
			const normalized: unknown[] = [];
			for (const item of value) {
				const candidate = canonicalJsonValue(item, seen);
				if (candidate === UNSERIALIZABLE) return UNSERIALIZABLE;
				normalized.push(candidate);
			}
			return normalized;
		}
		const normalized: Record<string, unknown> = {};
		for (const key of Object.keys(value).sort()) {
			const candidate = canonicalJsonValue((value as Record<string, unknown>)[key], seen);
			if (candidate === UNSERIALIZABLE) return UNSERIALIZABLE;
			normalized[key] = candidate;
		}
		return normalized;
	} finally {
		seen.delete(value);
	}
}

export function fingerprintSystemPrompt(systemPrompt: string): string {
	return createHash("sha256").update(systemPrompt).digest("hex");
}

/** Keep the exact parent prompt as the cache prefix without discarding child handlers. */
export function composeNativeSystemPrompt(parentSystemPrompt: string, currentSystemPrompt: string): string {
	if (currentSystemPrompt === parentSystemPrompt || currentSystemPrompt.startsWith(`${parentSystemPrompt}\n`)) {
		return currentSystemPrompt;
	}
	return `${parentSystemPrompt}\n\n## Current side-session system context\n${currentSystemPrompt}`;
}

/** Fingerprint the ordered active provider schema, not only its tool names. */
export function fingerprintActiveToolSchemas(
	activeToolNames: readonly string[],
	allTools: readonly ToolInfo[],
): string | null {
	const byName = new Map(allTools.map((tool) => [tool.name, tool]));
	const ordered: unknown[] = [];
	for (const name of activeToolNames) {
		const tool = byName.get(name);
		if (!tool || typeof tool.description !== "string" || tool.parameters === undefined) return null;
		if (tool.promptGuidelines !== undefined &&
			(!Array.isArray(tool.promptGuidelines) || !tool.promptGuidelines.every((item) => typeof item === "string"))) return null;
		ordered.push({
			name,
			description: tool.description,
			parameters: tool.parameters,
			promptGuidelines: tool.promptGuidelines ?? null,
		});
	}
	const canonical = canonicalJsonValue(ordered, new Set());
	if (canonical === UNSERIALIZABLE) return null;
	return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function decideCacheMode(
	payload: BtwPayload,
	actual: {
		model?: string;
		activeTools: string[];
		toolSchemaFingerprint?: string | null;
		thinkingLevel: string;
	},
): CacheMode {
	if (payload.parentSystemPrompt === null || !payload.parentSystemPromptFingerprint) {
		return { mode: "flattened", reason: "parent system prompt or fingerprint unavailable" };
	}
	if (fingerprintSystemPrompt(payload.parentSystemPrompt) !== payload.parentSystemPromptFingerprint) {
		return { mode: "flattened", reason: "parent system prompt fingerprint mismatch" };
	}
	if (!payload.parentToolSchemaFingerprint) {
		return { mode: "flattened", reason: "parent active-tool schema fingerprint unavailable" };
	}
	if (actual.model !== payload.metadata.model) {
		return { mode: "flattened", reason: "model differs from the parent" };
	}
	if (!sameStrings(actual.activeTools, payload.parentActiveTools)) {
		return { mode: "flattened", reason: "active tools differ from the parent" };
	}
	if (!actual.toolSchemaFingerprint || actual.toolSchemaFingerprint !== payload.parentToolSchemaFingerprint) {
		return { mode: "flattened", reason: "ordered active-tool schemas differ from the parent" };
	}
	if (actual.thinkingLevel !== payload.parentThinkingLevel) {
		return { mode: "flattened", reason: "thinking level differs from the parent" };
	}
	return { mode: "native" };
}
