import { BACKEND_DEFS } from "./backends/registry.js";

export const WEB_READ_RESULT_MAX_CHARS = 10_000;

export interface SearchHubCallPresentation {
	target: string;
	metadata?: string[];
}

export interface SearchHubResultPresentation {
	summary: string;
	previewStartLine?: number;
}

const READER_LABELS: Record<string, string> = {
	jina: "Jina",
	sofya: "Sofya",
	firecrawl: "Firecrawl",
	exa: "Exa",
	exa_mcp: "Exa MCP",
};

function toRecord(value: unknown): Record<string, unknown> {
	return value !== null && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function singleLine(value: unknown, maxLength: number): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.replace(/[\u0000-\u001f\u007f-\u009f]+/g, " ").replace(/\s+/g, " ").trim();
	if (!normalized) return undefined;
	return normalized.length > maxLength
		? normalized.slice(0, Math.max(1, maxLength - 1)).trimEnd() + "…"
		: normalized;
}

function getTextOutput(result: unknown): string {
	const content = toRecord(result).content;
	if (!Array.isArray(content)) return "";
	return content
		.map((entry) => {
			const record = toRecord(entry);
			return record.type === "text" && typeof record.text === "string" ? record.text : "";
		})
		.filter(Boolean)
		.join("\n");
}

function backendLabel(backend: string): string {
	return BACKEND_DEFS[backend]?.label || backend;
}

function readerLabel(reader: unknown, fallback = "jina"): string {
	const key = typeof reader === "string" && reader ? reader : fallback;
	return READER_LABELS[key] || key;
}

function resultCountLabel(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	const count = Math.floor(value);
	return `${count} ${count === 1 ? "result" : "results"}`;
}

function getSearchHeaderLineCount(result: unknown): number {
	const lines = getTextOutput(result).split(/\r?\n/);
	return lines[0]?.startsWith("## Search Results:") ? Math.min(3, lines.length) : 0;
}

function getUsableBackendStats(value: unknown): { usable: number; total: number } | undefined {
	const stats = toRecord(value);
	const entries = Object.values(stats);
	if (entries.length === 0) return undefined;
	const usable = entries.filter((entry) => {
		const record = toRecord(entry);
		return record.success === true && typeof record.count === "number" && record.count > 0;
	}).length;
	return { usable, total: entries.length };
}

function shortenUrl(value: unknown): string | undefined {
	const raw = singleLine(value, 256);
	if (!raw) return undefined;
	try {
		const url = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
		const path = `${url.hostname}${url.pathname === "/" ? "" : url.pathname}${url.search}`;
		return singleLine(path, 88);
	} catch {
		return singleLine(raw.replace(/^https?:\/\//i, ""), 88);
	}
}

function formatCharacterCount(value: unknown): string | undefined {
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	const count = Math.floor(value);
	if (count < 1_000) return `${count} chars`;
	if (count < 1_000_000) {
		const digits = count < 10_000 && count % 1_000 !== 0 ? 1 : 0;
		return `${(count / 1_000).toFixed(digits)}k chars`;
	}
	const digits = count < 10_000_000 && count % 1_000_000 !== 0 ? 1 : 0;
	return `${(count / 1_000_000).toFixed(digits)}m chars`;
}

export function getWebSearchCallPresentation(args: unknown): SearchHubCallPresentation | undefined {
	const input = toRecord(args);
	const query = singleLine(input.query, 72);
	if (!query) return undefined;

	const requestedBackend = typeof input.backend === "string" && input.backend
		? input.backend
		: "auto";
	const metadata = [requestedBackend === "auto" ? "auto" : backendLabel(requestedBackend)];
	if (input.combine === true && requestedBackend === "auto") metadata.push("combine");
	const requestedResults = typeof input.numResults === "number" && Number.isFinite(input.numResults)
		? Math.max(1, Math.min(20, Math.floor(input.numResults)))
		: 10;
	metadata.push(`top ${requestedResults}`);
	if (input.compact === true) metadata.push("compact");

	return { target: `“${query}”`, metadata };
}

export function getWebSearchResultPresentation(result: unknown): SearchHubResultPresentation | undefined {
	const details = toRecord(toRecord(result).details);
	const backend = typeof details.backend === "string" ? details.backend : undefined;
	const count = resultCountLabel(details.resultCount);
	if (!backend || !count) return undefined;

	const metadata: string[] = [];
	let label: string;
	if (backend === "combined" || backend === "combined-targeted") {
		label = backend === "combined-targeted" ? "Targeted combine" : "Combined";
		const stats = getUsableBackendStats(details.backendStats);
		const usable = typeof details.usableBackendCount === "number"
			? Math.max(0, Math.floor(details.usableBackendCount))
			: stats?.usable;
		if (usable !== undefined && stats) metadata.push(`${usable}/${stats.total} backends usable`);
	} else {
		const fallbackSuffix = " (fallback)";
		const isFallback = backend.endsWith(fallbackSuffix);
		const backendKey = isFallback ? backend.slice(0, -fallbackSuffix.length) : backend;
		label = backendLabel(backendKey) + (isFallback ? " fallback" : "");
	}

	return {
		summary: [label, count, ...metadata].join(" · "),
		previewStartLine: getSearchHeaderLineCount(result),
	};
}

export function getWebReadCallPresentation(
	args: unknown,
	defaultReader = "jina",
): SearchHubCallPresentation | undefined {
	const input = toRecord(args);
	const target = shortenUrl(input.url);
	if (!target) return undefined;

	const metadata = [readerLabel(input.reader, defaultReader)];
	if (input.mode === "rush" || input.mode === "smart") metadata.push(input.mode);
	if (Array.isArray(input.keywords) && input.keywords.length > 0) {
		metadata.push(`${input.keywords.length} ${input.keywords.length === 1 ? "keyword" : "keywords"}`);
	}
	if (input.fresh === true) metadata.push("fresh");
	if (typeof input.objective === "string" && input.objective.trim()) metadata.push("selector");

	return { target, metadata };
}

export function getWebReadResultPresentation(result: unknown): SearchHubResultPresentation | undefined {
	const details = toRecord(toRecord(result).details);
	const reader = typeof details.reader === "string" ? details.reader : undefined;
	const length = formatCharacterCount(details.length);
	if (!reader || !length) return undefined;

	const metadata = details.truncated === true
		? [`truncated to ${formatCharacterCount(WEB_READ_RESULT_MAX_CHARS)}`]
		: [];
	return {
		summary: [readerLabel(reader), length, ...metadata].join(" · "),
		previewStartLine: 0,
	};
}
