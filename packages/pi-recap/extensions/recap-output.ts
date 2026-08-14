export type RecapTitleSource = "model" | "recap-fallback";

export type ResolvedRecapOutput =
	| {
			ok: true;
			recap: string;
			title?: string;
			titleSource?: RecapTitleSource;
	  }
	| {
			ok: false;
			error: string;
	  };

export type ResolveRecapOutputOptions = {
	stopReason: unknown;
	errorMessage?: unknown;
	generateTitle: boolean;
	titleMaxLength: number;
};

export const RECAP_FALLBACK_WARNING = "Model did not generate a usable title; using a recap-derived fallback.";

export function recapOutputWarning(titleSource: RecapTitleSource | undefined): string | undefined {
	return titleSource === "recap-fallback" ? RECAP_FALLBACK_WARNING : undefined;
}

export function cleanOneLine(value: string, maxLength?: number): string {
	let cleaned = value
		.replace(/```(?:json)?|```/gi, "")
		.replace(/[\x00-\x1f\x7f]/g, " ")
		.replace(/\s+/g, " ")
		.trim();

	if (maxLength !== undefined) {
		const limit = Number.isFinite(maxLength) ? Math.max(0, Math.floor(maxLength)) : 0;
		const characters = Array.from(cleaned);
		if (characters.length > limit) {
			if (limit <= 1) return characters.slice(0, limit).join("");
			cleaned = `${characters.slice(0, limit - 1).join("")}…`;
		}
	}
	return cleaned;
}

type ModelPayload =
	| { kind: "json"; value: unknown }
	| { kind: "plain"; value: string }
	| { kind: "invalid-json" };

function tryParseJson(value: string): ModelPayload | undefined {
	try {
		return { kind: "json", value: JSON.parse(value) as unknown };
	} catch {
		return undefined;
	}
}

function parseStructuredJson(value: string): ModelPayload {
	return tryParseJson(value) ?? { kind: "invalid-json" };
}

function clearlyMalformedJson(value: string): boolean {
	const trimmed = value.trimStart();
	if (/^\{\s*"[^"]*"\s*:/s.test(trimmed)) return true;
	if (/^\[\s*(?:["{\[]|-?\d|true\b|false\b|null\b)/s.test(trimmed)) return true;
	return /^["'](?:recap|title)["']\s*:/i.test(trimmed);
}

const JSON_FENCE_OPENING = /^```json\b[^\S\r\n]*(?:\r?\n)?/i;
const GENERIC_FENCE_OPENING = /^```(?:[a-z0-9_-]+)?[^\S\r\n]*\r?\n/i;

function completeJsonFenceBody(value: string): string | undefined {
	const match = value.match(/^```json\b[^\S\r\n]*(?:\r?\n)?([\s\S]*)\r?\n?```[^\S\r\n]*$/i);
	return match ? (match[1] ?? "").trim() : undefined;
}

function completeGenericFenceBody(value: string): string | undefined {
	const match = value.match(/^```(?:[a-z0-9_-]+)?[^\S\r\n]*\r?\n([\s\S]*)\r?\n?```[^\S\r\n]*$/i);
	return match ? (match[1] ?? "").trim() : undefined;
}

function isExplicitJsonLike(value: string): boolean {
	const trimmed = value.trimStart();
	if (JSON_FENCE_OPENING.test(trimmed)) return true;
	if (trimmed.startsWith("{") || trimmed.startsWith("[")) return true;
	if (/^["'](?:recap|title)["']\s*:/i.test(trimmed)) return true;

	const genericOpening = trimmed.match(GENERIC_FENCE_OPENING);
	return genericOpening ? isExplicitJsonLike(trimmed.slice(genericOpening[0].length)) : false;
}

function parseExplicitJsonLike(value: string): ModelPayload {
	const trimmed = value.trim();
	const wholeJson = tryParseJson(trimmed);
	if (wholeJson) return wholeJson;

	const jsonFenceBody = completeJsonFenceBody(trimmed);
	if (jsonFenceBody !== undefined) return parseStructuredJson(jsonFenceBody);
	if (JSON_FENCE_OPENING.test(trimmed)) return { kind: "invalid-json" };

	const genericFenceBody = completeGenericFenceBody(trimmed);
	if (genericFenceBody !== undefined) {
		return isExplicitJsonLike(genericFenceBody)
			? parseExplicitJsonLike(genericFenceBody)
			: { kind: "invalid-json" };
	}

	const genericOpening = trimmed.match(GENERIC_FENCE_OPENING);
	if (genericOpening && isExplicitJsonLike(trimmed.slice(genericOpening[0].length))) {
		return { kind: "invalid-json" };
	}

	return { kind: "invalid-json" };
}

function parseModelPayload(raw: string): ModelPayload {
	const trimmed = raw.trim();
	const wholeJson = tryParseJson(trimmed);
	if (wholeJson) return wholeJson;

	const jsonFenceBody = completeJsonFenceBody(trimmed);
	if (jsonFenceBody !== undefined) return parseStructuredJson(jsonFenceBody);
	if (JSON_FENCE_OPENING.test(trimmed)) return { kind: "invalid-json" };

	const completeFenceBody = completeGenericFenceBody(trimmed);
	if (completeFenceBody !== undefined) return parseModelPayload(completeFenceBody);

	const openingFence = trimmed.match(GENERIC_FENCE_OPENING);
	if (openingFence) {
		const body = trimmed.slice(openingFence[0].length);
		const parsedBody = parseModelPayload(body);
		return parsedBody.kind === "plain" ? { kind: "plain", value: body } : { kind: "invalid-json" };
	}

	const jsonPreamble = trimmed.match(
		/^(?:(?:sure|certainly)[,!.]?\s*)?here(?:'s| is)\s+(?:(?:the|your|requested)\s+)*(?:(?:recap|result)\s+)?json(?:\s+(?:output|response))?\s*:\s*([\s\S]*)$/i,
	);
	if (jsonPreamble) {
		const candidate = jsonPreamble[1]?.trim() ?? "";
		if (isExplicitJsonLike(candidate)) return parseExplicitJsonLike(candidate);
	}

	if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
		return clearlyMalformedJson(trimmed) ? { kind: "invalid-json" } : { kind: "plain", value: trimmed };
	}

	return clearlyMalformedJson(trimmed) ? { kind: "invalid-json" } : { kind: "plain", value: trimmed };
}

function failureForStopReason(stopReason: unknown, errorMessage: unknown): string | undefined {
	if (stopReason === "length") return "Recap model output was truncated by the token limit";
	if (stopReason !== "error") return undefined;

	const detail = typeof errorMessage === "string" ? errorMessage.trim() : "";
	return detail ? `Recap model failed: ${detail}` : "Recap model failed";
}

export function resolveRecapOutput(raw: string, options: ResolveRecapOutputOptions): ResolvedRecapOutput {
	const stopFailure = failureForStopReason(options.stopReason, options.errorMessage);
	if (stopFailure) return { ok: false, error: stopFailure };
	if (!raw.trim()) return { ok: false, error: "Recap model returned empty output" };

	const payload = parseModelPayload(raw);
	if (payload.kind === "invalid-json") {
		return { ok: false, error: "Recap model returned malformed or truncated JSON" };
	}

	let recapValue: string;
	let modelTitle: string | undefined;
	if (payload.kind === "json") {
		if (typeof payload.value !== "object" || payload.value === null || Array.isArray(payload.value)) {
			return { ok: false, error: "Recap model returned JSON without a valid recap" };
		}
		const record = payload.value as Record<string, unknown>;
		if (typeof record.recap !== "string") {
			return { ok: false, error: "Recap model returned JSON without a valid recap" };
		}
		recapValue = record.recap;
		modelTitle = typeof record.title === "string" ? record.title : undefined;
	} else {
		recapValue = payload.value;
	}

	const recap = cleanOneLine(recapValue);
	if (!recap) return { ok: false, error: "Recap model returned an empty recap" };
	if (!options.generateTitle) return { ok: true, recap };

	const title = cleanOneLine(modelTitle ?? "", options.titleMaxLength);
	if (title) return { ok: true, recap, title, titleSource: "model" };

	const fallbackTitle = cleanOneLine(recap, options.titleMaxLength);
	if (!fallbackTitle) return { ok: false, error: "Recap model returned an empty recap" };
	return { ok: true, recap, title: fallbackTitle, titleSource: "recap-fallback" };
}
