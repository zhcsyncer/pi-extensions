import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ProcessLifetime } from "../config.ts";

export const PROCESS_STATE_CUSTOM_TYPE = "pi-herdr-companion.process-state";
export const PROCESS_TOOL_NAME = "herdr_process";
export const PROCESS_STATE_VERSION = 1 as const;
export const PROCESS_OWNER = "@zhcsyncer/pi-herdr-companion";

export interface ProcessEntry {
	owner: typeof PROCESS_OWNER;
	paneId: string;
	label: string;
	command: string;
	cwd: string;
	lifetime: ProcessLifetime;
	createdAt: string;
	ownerSessionId: string;
	ownerPaneId: string;
}

export interface ProcessRegistrySnapshot {
	version: typeof PROCESS_STATE_VERSION;
	entries: ProcessEntry[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isProcessEntry(value: unknown): value is ProcessEntry {
	if (!isRecord(value)) return false;
	return value.owner === PROCESS_OWNER &&
		typeof value.paneId === "string" && value.paneId.length > 0 &&
		typeof value.label === "string" && value.label.length > 0 &&
		typeof value.command === "string" && value.command.length > 0 &&
		typeof value.cwd === "string" && value.cwd.length > 0 &&
		(value.lifetime === "session" || value.lifetime === "persistent") &&
		typeof value.createdAt === "string" &&
		typeof value.ownerSessionId === "string" && value.ownerSessionId.length > 0 &&
		typeof value.ownerPaneId === "string" && value.ownerPaneId.length > 0;
}

export function parseProcessRegistrySnapshot(value: unknown): ProcessRegistrySnapshot | undefined {
	if (!isRecord(value) || value.version !== PROCESS_STATE_VERSION || !Array.isArray(value.entries)) return undefined;
	if (!value.entries.every(isProcessEntry)) return undefined;
	const seenPanes = new Set<string>();
	const seenLabels = new Set<string>();
	for (const entry of value.entries) {
		if (seenPanes.has(entry.paneId) || seenLabels.has(entry.label)) return undefined;
		seenPanes.add(entry.paneId);
		seenLabels.add(entry.label);
	}
	return { version: PROCESS_STATE_VERSION, entries: value.entries.map((entry) => ({ ...entry })) };
}

function snapshotFromEntry(entry: SessionEntry): ProcessRegistrySnapshot | undefined {
	if (entry.type === "custom" && entry.customType === PROCESS_STATE_CUSTOM_TYPE) {
		return parseProcessRegistrySnapshot(entry.data);
	}
	if (entry.type !== "message" || entry.message.role !== "toolResult" || entry.message.toolName !== PROCESS_TOOL_NAME) {
		return undefined;
	}
	if (!isRecord(entry.message.details)) return undefined;
	return parseProcessRegistrySnapshot(entry.message.details.registry);
}

/** Rebuild from the latest valid state on the active branch, never from memory alone. */
export function restoreProcessRegistry(entries: readonly SessionEntry[]): ProcessRegistrySnapshot {
	let latest: ProcessRegistrySnapshot | undefined;
	for (const entry of entries) latest = snapshotFromEntry(entry) ?? latest;
	return latest ?? { version: PROCESS_STATE_VERSION, entries: [] };
}

export function normalizeProcessLabel(value: string): string {
	const normalized = value
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 24);
	if (!normalized || !/^[a-z0-9]/.test(normalized)) throw new Error("Process label must contain a letter or digit");
	return normalized;
}

export function deriveProcessLabel(command: string): string {
	const tokens = command.trim().split(/\s+/).filter(Boolean);
	const keywords = ["dev", "preview", "watch", "serve", "server", "docs", "test"];
	for (const keyword of keywords) {
		if (tokens.some((token) => token.toLowerCase().replace(/[^a-z0-9_-]/g, "") === keyword)) return keyword;
	}
	const wrappers = new Set(["npm", "pnpm", "yarn", "bun", "bunx", "npx", "exec", "run"]);
	const candidate = tokens.find((token) => !wrappers.has(token.toLowerCase())) ?? "process";
	try {
		return normalizeProcessLabel(candidate.split("/").at(-1) ?? candidate);
	} catch {
		return "process";
	}
}

export class ProcessRegistry {
	private readonly byPane = new Map<string, ProcessEntry>();

	constructor(snapshot: ProcessRegistrySnapshot = { version: PROCESS_STATE_VERSION, entries: [] }) {
		this.replace(snapshot);
	}

	replace(snapshot: ProcessRegistrySnapshot): void {
		this.byPane.clear();
		for (const entry of snapshot.entries) this.byPane.set(entry.paneId, { ...entry });
	}

	snapshot(): ProcessRegistrySnapshot {
		return {
			version: PROCESS_STATE_VERSION,
			entries: this.entries().map((entry) => ({ ...entry })),
		};
	}

	entries(): ProcessEntry[] {
		return [...this.byPane.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
	}

	add(entry: ProcessEntry): void {
		if (!isProcessEntry(entry)) throw new Error("Refusing invalid process ownership entry");
		if (this.byPane.has(entry.paneId)) throw new Error(`Pane ${entry.paneId} is already registered`);
		if (this.find(entry.label)) throw new Error(`Process label already exists: ${entry.label}`);
		if (entry.paneId === entry.ownerPaneId) throw new Error("Refusing to register the caller pane as a managed process");
		this.byPane.set(entry.paneId, { ...entry });
	}

	find(target: string): ProcessEntry | undefined {
		return this.byPane.get(target) ?? this.entries().find((entry) => entry.label === target);
	}

	latest(): ProcessEntry | undefined {
		return this.entries().at(-1);
	}

	remove(paneId: string): ProcessEntry | undefined {
		const entry = this.byPane.get(paneId);
		if (entry) this.byPane.delete(paneId);
		return entry;
	}

	reconcile(livePaneIds: ReadonlySet<string>): ProcessEntry[] {
		const stale: ProcessEntry[] = [];
		for (const entry of this.byPane.values()) {
			if (!livePaneIds.has(entry.paneId)) {
				stale.push(entry);
				this.byPane.delete(entry.paneId);
			}
		}
		return stale;
	}
}

export type SessionShutdownReason = "quit" | "reload" | "new" | "resume" | "fork";
export type SessionStartReason = "startup" | "reload" | "new" | "resume" | "fork";

export function processEntriesToCloseOnShutdown(entries: readonly ProcessEntry[], reason: SessionShutdownReason): ProcessEntry[] {
	if (reason === "reload") return [];
	return entries.filter((entry) => entry.lifetime === "session");
}

/** New/resume/fork may inherit stored state; copied session-owned panes must not be adopted. */
export function processEntriesToCloseOnStart(entries: readonly ProcessEntry[], reason: SessionStartReason): ProcessEntry[] {
	if (reason === "new" || reason === "resume" || reason === "fork") {
		return entries.filter((entry) => entry.lifetime === "session");
	}
	return [];
}

export function mayCloseOwnedProcess(entry: ProcessEntry, currentCallerPaneId: string | undefined): boolean {
	return entry.owner === PROCESS_OWNER &&
		entry.paneId !== entry.ownerPaneId &&
		entry.paneId !== currentCallerPaneId;
}
