import type { BtwPayload } from "./types.ts";

export type CacheMode =
	| { mode: "native" }
	| { mode: "flattened"; reason: string };

function sameStrings(left: readonly string[], right: readonly string[]): boolean {
	return left.length === right.length && left.every((value, index) => value === right[index]);
}

export function decideCacheMode(
	payload: BtwPayload,
	actual: { model?: string; activeTools: string[]; thinkingLevel: string },
): CacheMode {
	if (payload.parentSystemPrompt === null) return { mode: "flattened", reason: "parent system prompt unavailable" };
	if (payload.config.model !== "inherit" || actual.model !== payload.metadata.model) {
		return { mode: "flattened", reason: "model override changed the provider cache prefix" };
	}
	if (payload.config.tools !== "inherit" || !sameStrings(actual.activeTools, payload.parentActiveTools)) {
		return { mode: "flattened", reason: "active tools differ from the parent" };
	}
	if (payload.config.thinking !== "inherit" || actual.thinkingLevel !== payload.parentThinkingLevel) {
		return { mode: "flattened", reason: "thinking level differs from the parent" };
	}
	return { mode: "native" };
}
