import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { usageRecordsFromSessionEntry, type SessionOrigin } from "./session-parser.ts";
import { copiedOrigins, readSessionSource } from "./session-source.ts";
import type { FileLedgerStore } from "./store.ts";
import type { UsageRecord } from "./types.ts";

type SessionReader = ExtensionContext["sessionManager"];

/** Session-local observation cursor. No timers, event interception or history-file mutations. */
export class SessionUsageCapture {
	private sid: string | undefined;
	private seen = new Set<string>();
	private models = new Map<string, string>();
	private origins = new Map<string, SessionOrigin>();
	private aliases = new Map<string, string>();
	private queue: Promise<unknown> = Promise.resolve();

	capture(manager: SessionReader, store: FileLedgerStore): Promise<UsageRecord[]> {
		const next = this.queue.then(() => this.collect(manager, store));
		this.queue = next.catch(() => {});
		return next;
	}

	private async collect(manager: SessionReader, store: FileLedgerStore): Promise<UsageRecord[]> {
		const sid = manager.getSessionId();
		const initial = sid !== this.sid;
		// The public SessionManager method exists in 1.1, but its readonly Pick omits it.
		const counted = manager as SessionReader & { getEntryCount?: () => number };
		const count = counted.getEntryCount?.();
		if (!initial && count === this.seen.size) return [];
		let entries: SessionEntry[];
		if (initial) {
			entries = manager.getEntries();
			this.origins = new Map();
			this.aliases = new Map();
			const file = manager.getSessionFile();
			const source = file ? await readSessionSource(file, this.aliases) : undefined;
			if (source) this.origins = source.origins;
			else {
				const parentFile = manager.getHeader()?.parentSession;
				const parent = parentFile ? await readSessionSource(parentFile, this.aliases) : undefined;
				if (parent) this.origins = copiedOrigins(entries.map((entry) => ({ ...entry })), parent);
			}
		} else if (count === undefined) {
			// Without a count, even the same leaf can hide additions on another branch.
			entries = manager.getEntries().filter((entry) => !this.seen.has(entry.id));
		} else {
			entries = [];
			let id = manager.getLeafId();
			const walking = new Set<string>();
			while (id && !this.seen.has(id) && !walking.has(id)) {
				walking.add(id);
				const entry = manager.getEntry(id);
				if (!entry) break;
				entries.push(entry);
				id = entry.parentId;
			}
			entries.reverse();
			// A host can append and navigate off-branch between observations. Reconcile
			// only that discontinuity, not every append or unchanged display.
			if (count !== undefined && count !== this.seen.size + entries.length) {
				entries = manager.getEntries().filter((entry) => !this.seen.has(entry.id));
			}
		}
		const models = new Map<string, string>();
		const records: UsageRecord[] = [];
		for (const entry of entries) {
			let model = (entry.parentId ? models.get(entry.parentId) ?? (!initial ? this.models.get(entry.parentId) : undefined) : undefined) ?? "unknown/unknown";
			if (entry.type === "model_change") model = `${entry.provider}/${entry.modelId}`;
			if (entry.type === "message" && entry.message.role === "assistant") {
				model = `${entry.message.provider}/${entry.message.model}`;
			}
			models.set(entry.id, model);
			records.push(...usageRecordsFromSessionEntry(entry, this.origins.get(entry.id) ?? { sid, cwd: manager.getCwd() }, model));
		}
		const added = await store.appendRecords(records, { legacyMatching: initial, sessionAliases: this.aliases });
		// Failed writes leave the cursor unchanged so the next lifecycle boundary retries.
		if (initial) this.seen.clear();
		for (const entry of entries) this.seen.add(entry.id);
		if (initial) this.models = models;
		else for (const [id, model] of models) this.models.set(id, model);
		this.sid = sid;
		return added;
	}
}
