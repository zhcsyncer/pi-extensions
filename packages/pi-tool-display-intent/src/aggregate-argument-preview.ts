const DEFAULT_MAX_LENGTH = 100;
const VALUE_MAX_LENGTH = 48;
// Inline identification is not a payload viewer. Do not scan arbitrarily large text.
const SOURCE_MAX_LENGTH = 4096;
const KEY_MAX_LENGTH = 128;

const PREFERRED_KEYS = [
	"description", "subject", "why", "purpose", "reason",
	"query", "pattern",
	"path", "filepath", "file", "filename", "targetpath", "target",
	"url", "uri", "endpointurl", "endpointuri",
	"name", "title", "id", "action", "operation", "command", "cmd",
];
const ID_PRIORITY = PREFERRED_KEYS.indexOf("id");
const SENSITIVE_KEY_PATTERN = /(?:(?:api|access|client)[_-]?key|token|secret|passw(?:or)?d|pwd|authorization|authentication|bearer|cookie|credential|private[_-]?key|signing[_-]?key)/i;
const SENSITIVE_VALUE_PATTERN = /(?:\b(?:sk|tvly|tavily|fc|gh[pousr]|xox[a-z]|xapp)[-_][A-Za-z0-9_-]{12,}\b|\bgithub_pat_[A-Za-z0-9_]{12,}\b|\b(?:AKIA|ASIA)[A-Z0-9]{16}\b|\bAIza[A-Za-z0-9_-]{35}\b|\b[A-Za-z0-9_-]{24,}\.[A-Za-z0-9_-]{6,}\.[A-Za-z0-9_-]{12,}\b|\b(?:Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{12,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\b(?:api[_-]?key|token|secret|password|authorization|cookie|credential)\s*[=:]\s*\S+)/i;
const OMITTED_KEYS = new Set([
	"displaysummary", "text", "input", "options", "headers", "auth", "authheader", "authheaders",
	"page", "pages", "pagenumber", "pagesize", "perpage", "cursor", "nextcursor",
	"offset", "limit", "maxresults", "numresults", "startline", "endline", "line", "lines",
	"context", "count", "depth", "retries", "retry", "attempts", "maxlength", "maxchars", "maxbytes",
	"minlength", "verbose", "debug", "dryrun", "enabled", "active", "recursive", "force",
	"exact", "casesensitive", "ignorecase", "multiselect", "fresh", "combine", "compact",
	"strict", "confirm", "wait", "background",
]);

function normalizedKey(key: string): string {
	return key.replace(/[_-]/g, "").toLowerCase();
}

function isIdKey(key: string): boolean {
	return /^id$/i.test(key) || /(?:[_-]id$|[a-z]Id$|[a-z]ID$)/.test(key);
}

function priority(key: string): number {
	const known = PREFERRED_KEYS.indexOf(normalizedKey(key));
	return known >= 0 ? known : isIdKey(key) ? ID_PRIORITY : PREFERRED_KEYS.length;
}

function isUsefulKey(key: string): boolean {
	if (!key || key.length > KEY_MAX_LENGTH || SENSITIVE_KEY_PATTERN.test(key)) return false;
	const normalized = normalizedKey(key);
	return !OMITTED_KEYS.has(normalized)
		&& !/(?:prompt|content|body|oldtext|newtext|edits|payload|data)$/.test(normalized)
		&& !/timeout/.test(normalized);
}

function truncate(value: string, maxLength: number): string {
	const characters = Array.from(value);
	if (characters.length <= maxLength) return value;
	return maxLength > 0 ? `${characters.slice(0, maxLength - 1).join("")}…` : "";
}

function stripTerminalControls(value: string): string {
	return value
		.replace(/(?:\x1b\]|\x9d)[\s\S]*?(?:\x07|\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b[P^_X]|[\x90\x98\x9e\x9f])[\s\S]*?(?:\x1b\\|\x9c|$)/g, "")
		.replace(/(?:\x1b\[|\x9b)[0-?]*[ -/]*[@-~]/g, "")
		.replace(/\x1b[ -/]*[@-~]/g, "")
		.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "");
}

function safeUrl(value: string): string {
	try {
		const input = value.startsWith("//") ? `https:${value}`
			: /^[a-z][a-z0-9+.-]*:\/\//i.test(value) ? value : `https://${value}`;
		const url = new URL(input);
		// Never display opaque URL schemes or malformed authority fragments.
		if (!url.host && url.protocol !== "file:") return "";
		const path = url.pathname === "/" ? "" : url.pathname.replace(/\/$/, "");
		return `${url.host}${path}`;
	} catch {
		return "";
	}
}

function stringPreview(key: string, value: string): string {
	if (!value || value.length > SOURCE_MAX_LENGTH) return "";
	const clean = stripTerminalControls(value).trim();
	const multiline = /[\r\n\u2028\u2029]/.test(clean);
	let text = (clean.split(/[\r\n\u2028\u2029]/, 1)[0] ?? "").replace(/\s+/g, " ").trim();
	if (/(?:url|uri)$/.test(normalizedKey(key))) {
		text = safeUrl(text);
	} else {
		text = text.replace(/(?:[a-z][a-z0-9+.-]*:\/\/|(?<![\w/.])\/\/)[^\s<>"']+/gi, safeUrl).trim();
	}
	// Check before clipping, so a credential beginning near the visible cutoff is not exposed.
	if (!text || SENSITIVE_VALUE_PATTERN.test(text) || /^(?:true|false|null|undefined)$/i.test(text)) return "";
	return truncate(multiline && !text.endsWith("…") ? `${text}…` : text, VALUE_MAX_LENGTH);
}

/** Values-only identification for generic aggregate rows; full arguments remain in the detail viewer. */
export function formatAggregateArgumentPreview(args: unknown, maxLength = DEFAULT_MAX_LENGTH): string {
	const limit = Number.isFinite(maxLength)
		? Math.min(DEFAULT_MAX_LENGTH, Math.max(0, Math.floor(maxLength)))
		: DEFAULT_MAX_LENGTH;
	if (limit === 0 || args === null || typeof args !== "object") return "";

	try {
		if (Array.isArray(args)) return "";
		// Sort names, not values: never evaluate accessors or invoke serialization hooks.
		const keys = Object.keys(args).filter(isUsefulKey).sort((left, right) =>
			priority(left) - priority(right) || (left < right ? -1 : left > right ? 1 : 0));
		const values: string[] = [];
		for (const key of keys) {
			const descriptor = Object.getOwnPropertyDescriptor(args, key);
			if (!descriptor || !Object.hasOwn(descriptor, "value")) continue;
			const value: unknown = descriptor.value;
			const preview = typeof value === "string" ? stringPreview(key, value)
				: typeof value === "number" && isIdKey(key) && Number.isSafeInteger(value) ? String(value) : "";
			if (!preview || values.includes(preview)) continue;
			values.push(preview);
			if (values.length === 2) break;
		}
		return truncate(values.join(" · "), limit);
	} catch {
		// Argument reflection can fail on revoked/hostile proxies; rendering must remain safe.
		return "";
	}
}
