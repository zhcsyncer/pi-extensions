export type DetailRequest =
	| { kind: "tool"; toolName: string; target?: string; args: unknown; result: unknown; status?: string; timing?: string }
	| { kind: "steer"; text: string };

export const DETAIL_LIMITS = { characters: 128 * 1024, lines: 4000, lineCharacters: 8192, nodes: 6000, depth: 24 } as const;
export const DETAIL_TRUNCATION = "[Truncated: viewer safety limit reached; remaining content omitted.]";
export const DETAIL_MASKING = "Read-only; credential keys and token-like values masked as [REDACTED]";
const REDACTED = "[REDACTED]";
const SGR = /^(?:[0-9;:]*)$/;

export interface DetailField {
	key: string;
	value: string;
	kind: "string" | "number" | "boolean" | "null" | "json";
}
export interface DetailTab {
	id: "result" | "args" | "details";
	label: string;
	advanced?: boolean;
	text: string;
	rawText: string;
	presentation: "text" | "json" | "markdown" | "fields";
	masked: boolean;
	truncated: boolean;
	diff?: { filePath?: string };
	fields?: DetailField[];
}
export interface DetailModel {
	title: string;
	status?: string;
	timing?: string;
	failed: boolean;
	showTabs: boolean;
	tabs: DetailTab[];
}

/** Only SGR survives. String controls (including unterminated ones) are consumed, never interpreted. */
export function sanitizeDetailText(text: string, keepSgr = true): string {
	const out: string[] = [];
	for (let i = 0; i < text.length;) {
		const code = text.charCodeAt(i);
		const escape = code === 0x1b;
		const next = escape ? text.charCodeAt(i + 1) : code;
		if ((escape && [0x5d, 0x50, 0x5f, 0x5e, 0x58].includes(next)) || [0x9d, 0x90, 0x9f, 0x9e, 0x98].includes(code)) {
			i += escape ? 2 : 1;
			while (i < text.length) {
				if (text.charCodeAt(i) === 7 || text.charCodeAt(i) === 0x9c) { i++; break; }
				if (text.charCodeAt(i) === 0x1b && text[i + 1] === "\\") { i += 2; break; }
				i++;
			}
			continue;
		}
		if ((escape && next === 0x5b) || code === 0x9b) {
			i += escape ? 2 : 1;
			const start = i;
			while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x3f) i++;
			const params = text.slice(start, i);
			if (text[i] === "m" && keepSgr && params.length <= 128 && SGR.test(params)) out.push(`\x1b[${params}m`);
			if (i < text.length && text.charCodeAt(i) >= 0x40 && text.charCodeAt(i) <= 0x7e) i++;
			continue;
		}
		if (escape) {
			i++;
			while (i < text.length && text.charCodeAt(i) >= 0x20 && text.charCodeAt(i) <= 0x2f) i++;
			if (i < text.length && text.charCodeAt(i) >= 0x30 && text.charCodeAt(i) <= 0x7e) i++;
			continue;
		}
		if (code === 13) {
			out.push("\n");
			i += text[i + 1] === "\n" ? 2 : 1;
			continue;
		}
		if (code === 10 || code === 9 || (code >= 32 && !(code >= 0x7f && code <= 0x9f) && !(code >= 0x202a && code <= 0x202e) && !(code >= 0x2066 && code <= 0x2069))) out.push(text[i]);
		i++;
	}
	return out.join("");
}

function credentialKey(key: string): boolean {
	const normalized = key.replace(/[^a-z0-9]/gi, "");
	return /password|passwd|passphrase|secret|credential|authorization|authentication|cookie|apikey|accesskey|privatekey|token|sessionid/i.test(normalized) || /^(?:pwd|auth)$/i.test(normalized);
}

function maskTokens(text: string): string {
	return text
		.replace(/\b(?:Bearer|Basic)\s+[^\s"'<>]+/gi, REDACTED)
		.replace(/-----BEGIN [^-]*PRIVATE KEY-----[\s\S]*/g, REDACTED)
		.replace(/(\b[a-z][a-z0-9+.-]*:\/\/)[^\s/@]+:[^\s/@]+@/gi, `$1${REDACTED}@`)
		.replace(/\b((?:[a-z_]*?(?:token|secret|password|passwd|api[_-]?key|credential)|authorization)\s*[=:]\s*)[^\s&;,"']+/gi, `$1${REDACTED}`)
		.replace(/\b(?:sk-[a-z0-9_-]{8,}|gh[pousr]_[a-z0-9_]{8,}|github_pat_[a-z0-9_]{8,}|xox[baprs]-[a-z0-9-]{8,}|eyJ[a-z0-9_-]*\.[a-z0-9_-]+\.[a-z0-9_-]+)\b/gi, REDACTED)
		.replace(/[a-z0-9_+/=-]{32,}/gi, (value) => /[a-z]/i.test(value) && /[0-9]/.test(value) ? REDACTED : value);
}

// Never invoke tool-owned getters or toJSON methods while inspecting a snapshot.
function field(value: unknown, key: string): unknown {
	if (value === null || typeof value !== "object") return undefined;
	try {
		const descriptor = Object.getOwnPropertyDescriptor(value, key);
		return descriptor && "value" in descriptor ? descriptor.value : undefined;
	} catch { return undefined; }
}

function nonempty(value: unknown): boolean {
	if (value === undefined || value === null || value === "") return false;
	if (Array.isArray(value)) return (field(value, "length") as number) > 0;
	if (typeof value !== "object") return true;
	try {
		let inspected = 0;
		for (const key in value) {
			if (Object.hasOwn(value, key)) return true;
			if (++inspected >= DETAIL_LIMITS.nodes) return true;
		}
	} catch { return true; }
	return false;
}

interface FormattingReport {
	text: string;
	masked: boolean;
	truncated: boolean;
}

function characterBudget(maxCharacters: number): number {
	return Math.max(0, Math.min(DETAIL_LIMITS.characters, Number.isFinite(maxCharacters) ? Math.floor(maxCharacters) : DETAIL_LIMITS.characters));
}

// Use intrinsic byte-length getters, not an attachment's potentially overridden properties.
function binaryBytes(value: object): number | undefined {
	try {
		if (ArrayBuffer.isView(value)) {
			const prototype = value instanceof DataView ? DataView.prototype : Object.getPrototypeOf(Uint8Array.prototype);
			return Object.getOwnPropertyDescriptor(prototype, "byteLength")!.get!.call(value);
		}
		if (value instanceof ArrayBuffer) return Object.getOwnPropertyDescriptor(ArrayBuffer.prototype, "byteLength")!.get!.call(value);
	} catch { /* A detached buffer has no readable payload. */ }
	return undefined;
}

function formatJsonReport(value: unknown, mask = true, maxCharacters: number = DETAIL_LIMITS.characters): FormattingReport {
	const chunks: string[] = [];
	const ancestors = new Set<object>();
	let remaining = characterBudget(maxCharacters);
	let inputRemaining = remaining;
	let nodes = 0;
	let entries = 0;
	let truncated = false;
	let masked = false;
	const append = (text: string) => {
		if (text.length > remaining) { chunks.push(text.slice(0, remaining)); remaining = 0; truncated = true; }
		else { chunks.push(text); remaining -= text.length; }
	};
	const boundedString = (text: string) => {
		const bounded = text.slice(0, Math.min(remaining, inputRemaining));
		inputRemaining -= bounded.length;
		if (bounded.length < text.length) truncated = true;
		return mask ? sanitizeDetailText(bounded, false) : bounded;
	};
	const quoteClean = (text: string) => {
		const clean = mask ? maskTokens(text) : text;
		if (clean !== text) masked = true;
		append(JSON.stringify(clean));
	};
	const quote = (text: string) => quoteClean(boundedString(text));
	const visit = (item: unknown, depth: number): void => {
		if (remaining <= 0) { truncated = true; return; }
		if (++nodes > DETAIL_LIMITS.nodes || depth > DETAIL_LIMITS.depth) { truncated = true; quote("[Truncated: structure limit]"); return; }
		if (item === null) { append("null"); return; }
		if (typeof item === "string") { quote(item); return; }
		if (typeof item === "boolean" || (typeof item === "number" && Number.isFinite(item))) { append(String(item)); return; }
		if (typeof item !== "object") {
			// Bound bigint conversion as well: decimal formatting otherwise allocates before slicing.
			if (typeof item === "bigint") {
				if (item > (1n << 4096n) || item < -(1n << 4096n)) { truncated = true; quote("[Truncated: bigint limit]"); }
				else quote(`${item}n`);
			} else quote(typeof item === "number" ? String(item) : `[${typeof item}]`);
			return;
		}
		if (ancestors.has(item)) { quote("[Circular]"); return; }
		const bytes = binaryBytes(item);
		if (bytes !== undefined) { quote(`[Binary attachment: ${bytes} bytes]`); return; }
		ancestors.add(item);
		const array = Array.isArray(item);
		append(array ? "[" : "{");
		let count = 0;
		const entry = (key: string) => {
			append(`${count++ ? "," : ""}\n${"  ".repeat(depth + 1)}`);
			let cleanKey = key;
			if (!array) {
				const keyFits = key.length <= Math.min(remaining, inputRemaining);
				cleanKey = boundedString(key); quoteClean(cleanKey); append(": ");
				// A cropped key cannot reliably identify a credential. Never expose its value.
				if (!keyFits) { quoteClean("[Truncated: key limit]"); return; }
			}
			if (remaining <= 0) { truncated = true; return; }
			const descriptor = Object.getOwnPropertyDescriptor(item, key);
			if (descriptor && !("value" in descriptor)) quote("[Accessor omitted]");
			else if (mask && credentialKey(cleanKey)) {
				if (descriptor?.value !== REDACTED) masked = true;
				quoteClean(REDACTED);
			} else visit(descriptor?.value, depth + 1);
		};
		const exhausted = () => {
			if (remaining <= 0 || nodes >= DETAIL_LIMITS.nodes || ++entries > DETAIL_LIMITS.nodes) { truncated = true; return true; }
			return false;
		};
		try {
			if (array) {
				const length = field(item, "length") as number;
				for (let i = 0; i < length; i++) {
					if (exhausted()) break;
					entry(String(i));
				}
			} else {
				for (const key in item) {
					if (exhausted()) break;
					if (Object.hasOwn(item, key)) entry(key);
				}
			}
		} catch { truncated = true; }
		if (count) append(`\n${"  ".repeat(depth)}`);
		append(array ? "]" : "}");
		ancestors.delete(item);
	};
	visit(value, 0);
	return { text: chunks.join("") + (truncated ? `\n${DETAIL_TRUNCATION}` : ""), masked, truncated };
}

/** Bounded pretty JSON, preserving structure rather than flattening to an inline preview. */
export function formatDetailJson(value: unknown, mask = true, maxCharacters: number = DETAIL_LIMITS.characters): string {
	return formatJsonReport(value, mask, maxCharacters).text;
}

function boundedText(text: string, keepSgr = true, maxCharacters: number = DETAIL_LIMITS.characters, maxLines: number = DETAIL_LIMITS.lines): FormattingReport {
	const limit = characterBudget(maxCharacters);
	let truncated = text.length > limit;
	const clean = sanitizeDetailText(text.slice(0, limit), keepSgr);
	const lines = clean.split("\n", maxLines + 1);
	if (lines.length > maxLines) { lines.length = maxLines; truncated = true; }
	for (let i = 0; i < lines.length; i++) {
		if (lines[i].length > DETAIL_LIMITS.lineCharacters) {
			lines[i] = `${sanitizeDetailText(lines[i].slice(0, DETAIL_LIMITS.lineCharacters), keepSgr)}${keepSgr ? "\x1b[0m" : ""} [Truncated: long line]`;
			truncated = true;
		}
	}
	return { text: lines.join("\n") + (truncated ? `${keepSgr ? "\x1b[0m" : ""}\n${DETAIL_TRUNCATION}` : ""), masked: false, truncated };
}

function boundReport(report: FormattingReport, maxCharacters: number = DETAIL_LIMITS.characters, maxLines: number = DETAIL_LIMITS.lines): FormattingReport {
	const bounded = boundedText(report.text, true, maxCharacters, maxLines);
	return { ...bounded, masked: report.masked, truncated: report.truncated || bounded.truncated };
}

function jsonReport(value: unknown, mask = true): FormattingReport {
	return boundReport(formatJsonReport(value, mask));
}

function attachment(block: unknown): FormattingReport {
	const info: Record<string, unknown> = { type: field(block, "type") };
	for (const key of ["mimeType", "mediaType", "name", "filename", "uri", "url", "path", "size", "width", "height"]) {
		const value = field(block, key);
		if (typeof value === "string" || typeof value === "number") info[key] = value;
	}
	const source = field(block, "source");
	if (!info.mimeType) {
		const mediaType = field(source, "mediaType");
		if (typeof mediaType === "string") info.mimeType = mediaType;
	}
	const data = field(block, "data") ?? field(source, "data");
	if (typeof data === "string") info.encodedCharacters = data.length;
	const report = jsonReport(info);
	return { ...report, text: `[Attachment; non-text payload not displayed]\n${report.text}` };
}

function editDiff(request: Extract<DetailRequest, { kind: "tool" }>, details: unknown): (FormattingReport & { diff: NonNullable<DetailTab["diff"]> }) | undefined {
	if (request.toolName !== "edit") return undefined;
	const payload = field(details, "diff");
	if (typeof payload !== "string") return undefined;
	if (!sanitizeDetailText(payload.slice(0, DETAIL_LIMITS.characters), false).trim()) return undefined;
	const report = boundedText(payload, false);
	const path = field(request.args, "path") ?? field(request.args, "file_path");
	return {
		...report,
		diff: { filePath: typeof path === "string" ? sanitizeDetailText(path.slice(0, 4096), false) : undefined },
	};
}

function metadataReport(result: unknown, details: unknown, hasDetails: boolean): FormattingReport | undefined {
	if (!hasDetails && (Array.isArray(result) || field(result, "content") === undefined)) return undefined;
	const envelopeKeys = new Set(["content", "details", "isError", "isPartial", "role", "toolCallId", "toolName", "timestamp", "usage"]);
	const metadata = Object.create(null) as Record<string, unknown>;
	let hasExtra = false;
	let incomplete = false;
	try {
		if (result && typeof result === "object") {
			let entries = 0;
			for (const key in result) {
				if (++entries > DETAIL_LIMITS.nodes) { incomplete = true; break; }
				if (!Object.hasOwn(result, key)) continue;
				if (key === "content") {
					const content = field(result, key);
					// Retain an empty envelope for exact structured inspection, but
					// never copy text/image payloads already represented in Result.
					if (content === undefined || content === null || content === "" || (Array.isArray(content) && field(content, "length") === 0)) {
						const descriptor = Object.getOwnPropertyDescriptor(result, key);
						if (descriptor) Object.defineProperty(metadata, key, descriptor);
					}
					continue;
				}
				const descriptor = Object.getOwnPropertyDescriptor(result, key);
				if (descriptor) Object.defineProperty(metadata, key, descriptor);
				if (!envelopeKeys.has(key)) hasExtra = true;
			}
		}
	} catch { incomplete = true; }
	if (hasExtra || incomplete) {
		const report = jsonReport(metadata);
		return incomplete ? boundReport({ ...report, truncated: true, text: `${report.text}\n${DETAIL_TRUNCATION}` }) : report;
	}
	return hasDetails ? jsonReport(details) : undefined;
}

function resultReport(request: Extract<DetailRequest, { kind: "tool" }>, hasDetails: boolean, hasDiff: boolean, metadata: FormattingReport | undefined): FormattingReport {
	const content = field(request.result, "content");
	let parts: FormattingReport[] = [];
	let hasText = false;
	let length = 0;
	let blocks = 0;
	const add = (report: FormattingReport) => { parts.push(report); length += report.text.length + 2; };
	const addBlock = (block: unknown) => {
		const type = field(block, "type");
		const text = typeof block === "string" ? block : type === "text" ? field(block, "text") : undefined;
		if (typeof text === "string") {
			const report = boundedText(text, true, DETAIL_LIMITS.characters - length);
			if (sanitizeDetailText(report.text, false).trim()) hasText = true;
			add(report);
		} else if (type === "image" || type === "audio" || type === "video" || type === "file") {
			add(attachment(block));
		} else {
			add(jsonReport(block)); hasText = true;
		}
	};
	if (Array.isArray(content)) {
		const count = field(content, "length") as number;
		for (let i = 0; i < count; i++) {
			if (length >= DETAIL_LIMITS.characters || ++blocks > 1000) { add({ text: DETAIL_TRUNCATION, masked: false, truncated: true }); break; }
			addBlock(field(content, String(i)));
		}
	} else if (content !== undefined) addBlock(content);
	else if (typeof request.result === "string") addBlock(request.result);
	else if (request.result !== undefined && request.result !== null && !hasDetails) {
		add(jsonReport(request.result)); hasText = true;
	}
	if (!hasText && metadata && !hasDiff) {
		parts = [metadata, ...parts.filter((part) => sanitizeDetailText(part.text, false).trim())];
	}
	if (!parts.some((part) => part.text.trim()) && !hasDiff) {
		return jsonReport(request.result ?? { message: "No result content." });
	}
	return boundReport({
		text: parts.map((part) => part.text).join("\n\n"),
		masked: parts.some((part) => part.masked), truncated: parts.some((part) => part.truncated),
	});
}

function resultTab(report: FormattingReport, toolName: string): DetailTab {
	const tab: DetailTab = { id: "result", label: "Result", ...report, rawText: report.text, presentation: "text" };
	if (!report.truncated) {
		try {
			const pretty = jsonReport(JSON.parse(report.text), false);
			return { ...tab, text: pretty.text, presentation: "json", truncated: pretty.truncated };
		} catch { /* Native text stays native. */ }
	}
	// Files and command/search output are literal even when their content resembles Markdown.
	if (!["read", "bash", "grep", "find", "ls", "edit", "write"].includes(toolName) &&
		/(?:^|\n) {0,3}(?:#{1,6}[ \t]+\S|`{3,}|~{3,})|\[[^\]\n]+\]\([^\s)]+\)/.test(report.text)) tab.presentation = "markdown";
	return tab;
}

function argsTab(args: unknown): DetailTab {
	// All field values come from this safe snapshot, never a second walk of tool-owned args.
	const report = jsonReport(args);
	const tab: DetailTab = { id: "args", label: "Args", ...report, rawText: report.text, presentation: "json" };
	if (report.truncated) return tab;
	try {
		const parsed: unknown = JSON.parse(report.text);
		if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed) || Object.getPrototypeOf(parsed) !== Object.prototype) return tab;
		const fields: DetailField[] = Object.entries(parsed).map(([key, value]) => {
			const kind: DetailField["kind"] = value === null ? "null" : typeof value === "object" ? "json" : typeof value as "string" | "number" | "boolean";
			return { key, kind, value: kind === "json" ? JSON.stringify(value, null, 2) : String(value) };
		});
		if (fields.some((item) => boundedText(item.value, false).truncated)) return tab;
		return { ...tab, presentation: "fields", fields };
	} catch { return tab; }
}

function chrome(value: string): string {
	return sanitizeDetailText(value.slice(0, 160), false).replace(/\s+/g, " ");
}

export function buildDetailModel(request: DetailRequest): DetailModel {
	if (request.kind === "steer") {
		const report = boundedText(request.text);
		return {
			title: "Steer", failed: false, showTabs: false,
			tabs: [{ id: "result", label: "Result", ...report, rawText: report.text, presentation: "text" }],
		};
	}
	const details = field(request.result, "details");
	const hasDetails = nonempty(details);
	const metadata = metadataReport(request.result, details, hasDetails);
	const status = request.status === undefined ? undefined : chrome(request.status);
	const failed = field(request.result, "isError") === true || /\b(?:error|failed|failure)\b/i.test(status ?? "");
	const diff = !failed ? editDiff(request, details) : undefined;
	const result = resultReport(request, hasDetails, !!diff, metadata);
	let primary = resultTab(result, request.toolName);
	if (diff) {
		// Reserve room for both sources: a long success/warning message must not crowd out the diff.
		const needsSplit = result.text.length + diff.text.length + 2 > DETAIL_LIMITS.characters ||
			result.text.split("\n").length + diff.text.split("\n").length + 1 > DETAIL_LIMITS.lines;
		const original = needsSplit ? boundReport(result, DETAIL_LIMITS.characters / 2 - 100, DETAIL_LIMITS.lines / 2 - 2) : result;
		const rawDiff = needsSplit ? boundReport(diff, DETAIL_LIMITS.characters / 2 - 100, DETAIL_LIMITS.lines / 2 - 2) : diff;
		const raw = boundReport({
			text: original.text ? `${original.text}\n\n${rawDiff.text}` : rawDiff.text,
			masked: original.masked, truncated: original.truncated || rawDiff.truncated,
		});
		primary = { id: "result", label: "Result", ...diff, rawText: raw.text, presentation: "text", masked: raw.masked, truncated: diff.truncated || raw.truncated };
	}
	const tabs = [primary, argsTab(request.args)];
	if (metadata) tabs.push({ id: "details", label: "Metadata", advanced: true, ...metadata, rawText: metadata.text, presentation: "json" });
	return {
		title: chrome(request.target ?? request.toolName), status: status ?? (failed ? "failed" : undefined),
		timing: request.timing === undefined ? undefined : chrome(request.timing),
		failed, showTabs: true, tabs,
	};
}
