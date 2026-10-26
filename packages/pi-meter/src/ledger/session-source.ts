import { readFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { isRecord } from "../fs.ts";
import type { SessionOrigin } from "./session-parser.ts";

/** Actual files read during one capture/import, not a global provenance registry. */
export interface SessionSource {
	file: string;
	content: string;
	sid: string;
	cwd: string;
	entries: Record<string, unknown>[];
	origins: Map<string, SessionOrigin>;
}

export function sourceEntries(content: string): Record<string, unknown>[] {
	return content.split("\n").flatMap((line) => {
		try { const entry: unknown = JSON.parse(line); return isRecord(entry) ? [entry] : []; }
		catch { return []; }
	});
}

export function fileAlias(file: string): string {
	return basename(file).replace(/\.jsonl?$/, "");
}

/** Normal SDK copies retain IDs; branch copies may remove labels and reconnect parents. */
export function copiedOrigins(entries: readonly Record<string, unknown>[], source: SessionSource): Map<string, SessionOrigin> {
	if (!source.entries.some((entry) => entry.type === "session" && typeof entry.id === "string" && entry.id === source.sid)) return new Map();
	const originals = new Map(source.entries.flatMap((entry) => typeof entry.id === "string" && entry.type !== "session" ? [[entry.id, entry] as const] : []));
	const origins = new Map<string, SessionOrigin>();
	for (const entry of entries) {
		if (typeof entry.id !== "string" || entry.type === "session" || entry.type === "label") continue;
		const original = originals.get(entry.id);
		if (!original || original.type !== entry.type) continue;
		let parent = original.parentId;
		const visited = new Set<unknown>();
		while (parent !== entry.parentId && typeof parent === "string" && !visited.has(parent)) {
			visited.add(parent);
			const ancestor = originals.get(parent);
			if (ancestor?.type !== "label") break;
			parent = ancestor.parentId;
		}
		if (parent !== entry.parentId) continue;
		// A shared ID must belong to the copied ancestry, not merely occur somewhere in a related file.
		if (typeof parent === "string" && !origins.has(parent) && originals.get(parent)?.type !== "label") continue;
		origins.set(entry.id, source.origins.get(entry.id) ?? { sid: source.sid, cwd: source.cwd });
	}
	return origins;
}

export async function readSessionSource(
	file: string,
	aliases: Map<string, string>,
	cache = new Map<string, SessionSource>(),
	visiting = new Set<string>(),
): Promise<SessionSource | undefined> {
	file = resolve(file);
	if (cache.has(file)) return cache.get(file);
	if (visiting.has(file)) return undefined;
	visiting.add(file);
	try {
		const content = await readFile(file, "utf8");
		const entries = sourceEntries(content);
		const header = entries.find((entry) => entry.type === "session");
		const sid = typeof header?.id === "string" && header.id ? header.id : fileAlias(file);
		if (typeof header?.id === "string" && header.id) aliases.set(fileAlias(file), header.id);
		const source: SessionSource = { file, content, entries, sid, cwd: typeof header?.cwd === "string" ? header.cwd : "", origins: new Map() };
		cache.set(file, source);
		if (typeof header?.parentSession === "string") {
			const parent = await readSessionSource(isAbsolute(header.parentSession) ? header.parentSession : resolve(dirname(file), header.parentSession), aliases, cache, visiting);
			if (parent) source.origins = copiedOrigins(entries, parent);
		}
		return source;
	} catch {
		return undefined;
	} finally {
		visiting.delete(file);
	}
}
