import { normalizeDisplaySummary, stripDisplaySummary } from "./display-summary.js";

export const CUSTOM_ARGUMENT_PREVIEW_MAX_LENGTH = 120;
const ARGUMENT_VALUE_MAX_LENGTH = 48;
const ARGUMENT_KEY_MAX_LENGTH = 32;
const SENSITIVE_KEY_PATTERN = /(?:api[_-]?key|token|secret|passw(?:or)?d|authorization|bearer|cookie|credential)/i;
const SENSITIVE_VALUE_PATTERN = /(?:\b(?:sk|tvly|fc|ghp|xoxb|xapp)[-_][A-Za-z0-9_-]{12,}\b|\bgithub_pat_[A-Za-z0-9_]{12,}\b|\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{12,}\b|\bBearer\s+[A-Za-z0-9._~+/=-]{12,}\b)/i;
const URL_KEY_PATTERN = /(?:^|[_-])(?:url|uri)$|(?:Url|URL|Uri|URI)$/;
const SIMPLE_VALUE_PATTERN = /^[A-Za-z0-9_./:@+-]+$/;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function truncateCharacters(value: string, maxLength: number): string {
	const characters = Array.from(value);
	if (characters.length <= maxLength) return value;
	if (maxLength <= 1) return "…".slice(0, maxLength);
	return `${characters.slice(0, maxLength - 1).join("")}…`;
}

function safeKey(value: string): string {
	return truncateCharacters(normalizeDisplaySummary(value, ARGUMENT_KEY_MAX_LENGTH) ?? "arg", ARGUMENT_KEY_MAX_LENGTH);
}

function sanitizeStructuredString(key: string, value: string): string {
	const urlLikeKey = URL_KEY_PATTERN.test(key);
	if (!urlLikeKey && !/^https?:\/\//i.test(value)) return value;
	try {
		const parsed = new URL(value);
		const path = parsed.pathname === "/" ? "" : parsed.pathname.replace(/\/$/, "");
		return `${parsed.host}${path}`;
	} catch {
		return urlLikeKey ? value.split(/[?#]/, 1)[0] ?? value : value;
	}
}

function stringPreview(key: string, value: string): string {
	const firstLine = value.split(/\r\n?|\n/, 1)[0] ?? "";
	const hasMoreLines = /\r|\n/.test(value);
	const normalized = normalizeDisplaySummary(sanitizeStructuredString(key, firstLine), 256) ?? "";
	if (SENSITIVE_VALUE_PATTERN.test(normalized)) return "•••";
	const clipped = truncateCharacters(normalized, ARGUMENT_VALUE_MAX_LENGTH - (hasMoreLines ? 1 : 0));
	const text = `${clipped}${hasMoreLines && !clipped.endsWith("…") ? "…" : ""}`;
	if (!text || !SIMPLE_VALUE_PATTERN.test(text)) return JSON.stringify(text);
	return text;
}

function formatEntry(rawKey: string, value: unknown): string {
	const key = safeKey(rawKey);
	if (SENSITIVE_KEY_PATTERN.test(rawKey)) return `${key}=•••`;
	if (Array.isArray(value)) return `${key}[${value.length}]`;
	if (isRecord(value)) return Object.keys(value).length === 0 ? `${key}{}` : `${key}{…}`;
	if (typeof value === "string") return `${key}=${stringPreview(rawKey, value)}`;
	if (typeof value === "number" || typeof value === "boolean" || value === null) {
		return `${key}=${String(value)}`;
	}
	return `${key}=<${typeof value}>`;
}

export function formatFlatArgumentPreview(
	args: unknown,
	maxLength = CUSTOM_ARGUMENT_PREVIEW_MAX_LENGTH,
): string {
	const stripped = stripDisplaySummary(args);
	const record = isRecord(stripped) ? stripped : {};
	const entries = Object.entries(record);
	if (entries.length === 0) return "no args";
	const preview = entries.map(([key, value]) => formatEntry(key, value)).join(" · ");
	const limit = Number.isFinite(maxLength)
		? Math.max(1, Math.floor(maxLength))
		: CUSTOM_ARGUMENT_PREVIEW_MAX_LENGTH;
	return truncateCharacters(preview, limit);
}
