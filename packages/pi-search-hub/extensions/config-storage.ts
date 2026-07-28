import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import type { BackendConfig, ReaderName, SearchConfig } from "./types.js";

export type MigrationNoticeSink = (message: string) => void;

const ROOT_FIELDS = new Set([
	"defaultBackend",
	"combine",
	"combineMode",
	"selectionStrategy",
	"reader",
	"readerFallback",
	"compact",
	"backends",
]);
const BACKEND_FIELDS = new Set([
	"enabled",
	"apiKey",
	"timeout",
	"maxResults",
	"headers",
	"instanceUrl",
	"model",
	"ddgsBackend",
	"ddgsRegion",
	"ddgsTimelimit",
	"tokenBudget",
	"depth",
	"baseUrl",
	"searchDepth",
	"topic",
]);
const READERS = new Set<ReaderName>(["jina", "sofya", "firecrawl", "exa", "exa_mcp"]);
const SELECTION_STRATEGIES = new Set(["sequential", "random", "round-robin", "best-latency"]);
const emittedNotices = new Set<string>();
const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 1_000;
const LOCK_RETRY_MS = 20;
const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function emitNotice(sink: MigrationNoticeSink | undefined, message: string): void {
	if (emittedNotices.has(message)) return;
	emittedNotices.add(message);
	(sink ?? ((text) => console.warn(text)))(message);
}

function droppedSummary(paths: readonly string[]): string {
	if (paths.length === 0) return "";
	const shown = paths.slice(0, 8).join(", ");
	return ` Dropped ${paths.length} unmappable field${paths.length === 1 ? "" : "s"}: ${shown}${paths.length > 8 ? ", …" : ""}.`;
}

function keepString(source: Record<string, unknown>, target: Record<string, unknown>, key: string, dropped: string[], prefix = ""): void {
	if (!(key in source)) return;
	if (typeof source[key] === "string") target[key] = source[key];
	else dropped.push(`${prefix}${key}`);
}

function keepBoolean(source: Record<string, unknown>, target: Record<string, unknown>, key: string, dropped: string[], prefix = ""): void {
	if (!(key in source)) return;
	if (typeof source[key] === "boolean") target[key] = source[key];
	else dropped.push(`${prefix}${key}`);
}

function keepPositiveNumber(source: Record<string, unknown>, target: Record<string, unknown>, key: string, dropped: string[], prefix = ""): void {
	if (!(key in source)) return;
	const value = source[key];
	if (typeof value === "number" && Number.isFinite(value) && value > 0) target[key] = value;
	else dropped.push(`${prefix}${key}`);
}

function normalizeBackend(value: unknown, prefix: string, dropped: string[]): BackendConfig | undefined {
	if (!isRecord(value)) {
		dropped.push(prefix.slice(0, -1));
		return undefined;
	}
	const normalized: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		if (!BACKEND_FIELDS.has(key)) dropped.push(`${prefix}${key}`);
	}
	keepBoolean(value, normalized, "enabled", dropped, prefix);
	for (const key of ["apiKey", "instanceUrl", "model", "ddgsBackend", "ddgsRegion", "ddgsTimelimit", "baseUrl"] as const) {
		keepString(value, normalized, key, dropped, prefix);
	}
	for (const key of ["timeout", "maxResults", "tokenBudget"] as const) {
		keepPositiveNumber(value, normalized, key, dropped, prefix);
	}
	if ("headers" in value) {
		if (isRecord(value.headers)) {
			const headers: Record<string, string> = {};
			for (const [name, headerValue] of Object.entries(value.headers)) {
				if (typeof headerValue === "string") headers[name] = headerValue;
				else dropped.push(`${prefix}headers.${name}`);
			}
			normalized.headers = headers;
		} else {
			dropped.push(`${prefix}headers`);
		}
	}
	if ("depth" in value) {
		if (value.depth === "standard" || value.depth === "deep") normalized.depth = value.depth;
		else dropped.push(`${prefix}depth`);
	}
	if ("searchDepth" in value) {
		if (value.searchDepth === "snippets" || value.searchDepth === "basic") normalized.searchDepth = value.searchDepth;
		else dropped.push(`${prefix}searchDepth`);
	}
	if ("topic" in value) {
		if (value.topic === "general" || value.topic === "news") normalized.topic = value.topic;
		else dropped.push(`${prefix}topic`);
	}
	return normalized as BackendConfig;
}

export function normalizeSearchConfigForStorage(value: unknown): { config: SearchConfig; dropped: string[] } {
	if (!isRecord(value)) throw new Error("the root value must be a JSON object");
	const dropped: string[] = [];
	const normalized: Record<string, unknown> = {};
	for (const key of Object.keys(value)) {
		if (!ROOT_FIELDS.has(key)) dropped.push(key);
	}
	keepString(value, normalized, "defaultBackend", dropped);
	keepBoolean(value, normalized, "combine", dropped);
	keepBoolean(value, normalized, "compact", dropped);
	if ("combineMode" in value) {
		if (value.combineMode === "all" || value.combineMode === "targeted") normalized.combineMode = value.combineMode;
		else dropped.push("combineMode");
	}
	if ("selectionStrategy" in value) {
		if (typeof value.selectionStrategy === "string" && SELECTION_STRATEGIES.has(value.selectionStrategy)) {
			normalized.selectionStrategy = value.selectionStrategy;
		} else dropped.push("selectionStrategy");
	}
	if ("reader" in value) {
		if (typeof value.reader === "string" && READERS.has(value.reader as ReaderName)) normalized.reader = value.reader;
		else dropped.push("reader");
	}
	if ("readerFallback" in value) {
		if (Array.isArray(value.readerFallback)) {
			const readers: ReaderName[] = [];
			for (const [index, reader] of value.readerFallback.entries()) {
				if (typeof reader === "string" && READERS.has(reader as ReaderName)) {
					if (!readers.includes(reader as ReaderName)) readers.push(reader as ReaderName);
				} else dropped.push(`readerFallback[${index}]`);
			}
			normalized.readerFallback = readers;
		} else dropped.push("readerFallback");
	}
	if ("backends" in value) {
		if (isRecord(value.backends)) {
			const backends: Record<string, BackendConfig | undefined> = {};
			for (const [backend, backendValue] of Object.entries(value.backends)) {
				const normalizedBackend = normalizeBackend(backendValue, `backends.${backend}.`, dropped);
				if (normalizedBackend) backends[backend] = normalizedBackend;
			}
			normalized.backends = backends;
		} else dropped.push("backends");
	}
	return { config: normalized as SearchConfig, dropped: [...new Set(dropped)] };
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

function withLock<T>(directory: string, name: string, fn: () => T): T {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const lockPath = join(directory, name);
	const deadline = Date.now() + LOCK_WAIT_MS;
	let descriptor: number | undefined;
	while (descriptor === undefined) {
		try {
			descriptor = openSync(lockPath, "wx", 0o600);
			writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
					unlinkSync(lockPath);
					continue;
				}
			} catch (statError) {
				if (isRecord(statError) && statError.code === "ENOENT") continue;
				throw statError;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for migration lock ${lockPath}`);
			sleepSync(LOCK_RETRY_MS);
		}
	}
	try {
		return fn();
	} finally {
		closeSync(descriptor);
		rmSync(lockPath, { force: true });
	}
}

export function writeSearchConfigAtomically(file: string, config: SearchConfig): void {
	const directory = dirname(file);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		renameSync(temporary, file);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function saveSearchConfig(file: string, config: SearchConfig): void {
	withLock(dirname(file), ".config-migration.lock", () => writeSearchConfigAtomically(file, config));
}

function readAndNormalize(file: string): { config: SearchConfig; dropped: string[]; raw: unknown } {
	const raw = JSON.parse(readFileSync(file, "utf8")) as unknown;
	const normalized = normalizeSearchConfigForStorage(raw);
	return { ...normalized, raw };
}

export function loadMigratedSearchConfig(options: {
	targetPath: string;
	legacyPath: string;
	scope: "global" | "project";
	onNotice?: MigrationNoticeSink;
}): SearchConfig {
	const { targetPath, legacyPath, scope, onNotice } = options;
	if (existsSync(targetPath)) {
		try {
			let loaded = readAndNormalize(targetPath);
			if (JSON.stringify(loaded.raw) !== JSON.stringify(loaded.config)) {
				loaded = withLock(dirname(targetPath), ".config-migration.lock", () => {
					const current = readAndNormalize(targetPath);
					if (JSON.stringify(current.raw) !== JSON.stringify(current.config)) writeSearchConfigAtomically(targetPath, current.config);
					return current;
				});
				emitNotice(onNotice, `Search Hub upgraded ${scope} config at ${targetPath}.${droppedSummary(loaded.dropped)}`);
			}
			if (existsSync(legacyPath)) {
				emitNotice(onNotice, `Search Hub ignored conflicting legacy ${scope} config at ${legacyPath}; canonical config is ${targetPath}.`);
			}
			return loaded.config;
		} catch (error) {
			emitNotice(onNotice, `Search Hub could not read canonical ${scope} config at ${targetPath}: ${error instanceof Error ? error.message : String(error)}. The legacy file was not used or removed.`);
			return {};
		}
	}
	if (!existsSync(legacyPath)) return {};
	try {
		return withLock(dirname(targetPath), ".config-migration.lock", () => {
			if (existsSync(targetPath)) return readAndNormalize(targetPath).config;
			const loaded = readAndNormalize(legacyPath);
			writeSearchConfigAtomically(targetPath, loaded.config);
			const verified = readAndNormalize(targetPath).config;
			if (JSON.stringify(verified) !== JSON.stringify(loaded.config)) throw new Error("semantic round trip verification failed");
			unlinkSync(legacyPath);
			emitNotice(onNotice, `Search Hub migrated ${scope} config from ${legacyPath} to ${targetPath}.${droppedSummary(loaded.dropped)}`);
			return verified;
		});
	} catch (error) {
		emitNotice(onNotice, `Search Hub failed to migrate ${scope} config from ${legacyPath} to ${targetPath}: ${error instanceof Error ? error.message : String(error)}. The legacy file was preserved.`);
		try {
			return readAndNormalize(legacyPath).config;
		} catch {
			return {};
		}
	}
}

export function resetSearchConfigMigrationNoticesForTests(): void {
	emittedNotices.clear();
}
