import { createHash } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { ProcessLifetime, ProcessShell } from "../config.ts";

export const PROCESS_STATE_CUSTOM_TYPE = "pi-herdr-companion.process-state";
export const PROCESS_TOOL_NAME = "herdr_process";
export const PROCESS_STATE_VERSION = 2 as const;
export const PROCESS_OWNER = "@zhcsyncer/pi-herdr-companion";

export type ProcessRegistryVersion = 1 | typeof PROCESS_STATE_VERSION;

export interface ProcessEntry {
	owner: typeof PROCESS_OWNER;
	paneId: string;
	/** Stable only within the Herdr server identified by serverScope. */
	terminalId?: string;
	/** SHA-256 namespace of the Herdr socket path; terminalId is never compared across scopes. */
	serverScope?: string;
	workspaceId?: string;
	tabId?: string;
	label: string;
	command: string;
	cwd: string;
	lifetime: ProcessLifetime;
	createdAt: string;
	ownerSessionId: string;
	ownerPaneId: string;
	/** Missing only on pre-transport snapshots, whose commands used the pane shell. */
	shell?: ProcessShell;
}

export interface ProcessRegistrySnapshot {
	version: ProcessRegistryVersion;
	entries: ProcessEntry[];
}

export interface ProcessPaneLocation {
	paneId: string;
	terminalId?: string;
	workspaceId?: string;
	tabId?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isOptionalNonEmptyString(value: unknown): boolean {
	return value === undefined || (typeof value === "string" && value.length > 0);
}

export function processServerScope(socketPath: string): string {
	const normalized = socketPath.trim();
	if (!normalized) throw new Error("Cannot scope process ownership without HERDR_SOCKET_PATH");
	return createHash("sha256").update(normalized).digest("hex").slice(0, 16);
}

export function isProcessEntry(value: unknown): value is ProcessEntry {
	if (!isRecord(value)) return false;
	const terminalIdValid = isOptionalNonEmptyString(value.terminalId);
	const serverScopeValid = value.serverScope === undefined ||
		(typeof value.serverScope === "string" && /^[a-f0-9]{16}$/.test(value.serverScope));
	const stableIdentityPaired = (value.terminalId === undefined) === (value.serverScope === undefined);
	return value.owner === PROCESS_OWNER &&
		typeof value.paneId === "string" && value.paneId.length > 0 &&
		terminalIdValid && serverScopeValid && stableIdentityPaired &&
		isOptionalNonEmptyString(value.workspaceId) &&
		isOptionalNonEmptyString(value.tabId) &&
		typeof value.label === "string" && value.label.length > 0 &&
		typeof value.command === "string" && value.command.length > 0 &&
		typeof value.cwd === "string" && value.cwd.length > 0 &&
		(value.lifetime === "session" || value.lifetime === "persistent") &&
		typeof value.createdAt === "string" &&
		typeof value.ownerSessionId === "string" && value.ownerSessionId.length > 0 &&
		typeof value.ownerPaneId === "string" && value.ownerPaneId.length > 0 &&
		(value.shell === undefined || value.shell === "bash" || value.shell === "pane");
}

function terminalIdentity(entry: ProcessEntry): string | undefined {
	return entry.terminalId && entry.serverScope
		? `${entry.serverScope}:${entry.terminalId}`
		: undefined;
}

function hasUniqueEntries(entries: readonly ProcessEntry[]): boolean {
	const seenPanes = new Set<string>();
	const seenLabels = new Set<string>();
	const seenTerminals = new Set<string>();
	for (const entry of entries) {
		const terminal = terminalIdentity(entry);
		if (seenPanes.has(entry.paneId) || seenLabels.has(entry.label) ||
			(terminal !== undefined && seenTerminals.has(terminal))) return false;
		seenPanes.add(entry.paneId);
		seenLabels.add(entry.label);
		if (terminal) seenTerminals.add(terminal);
	}
	return true;
}

export function parseProcessRegistrySnapshot(value: unknown): ProcessRegistrySnapshot | undefined {
	if (!isRecord(value) || (value.version !== 1 && value.version !== PROCESS_STATE_VERSION) ||
		!Array.isArray(value.entries) || !value.entries.every(isProcessEntry)) return undefined;
	if (!hasUniqueEntries(value.entries)) return undefined;
	return {
		version: PROCESS_STATE_VERSION,
		entries: value.entries.map((entry) => ({ ...entry })),
	};
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

export function sameProcessOwnership(left: ProcessEntry, right: ProcessEntry): boolean {
	const leftTerminal = terminalIdentity(left);
	const rightTerminal = terminalIdentity(right);
	if (leftTerminal && rightTerminal) return leftTerminal === rightTerminal;
	return left.paneId === right.paneId &&
		left.ownerSessionId === right.ownerSessionId &&
		left.ownerPaneId === right.ownerPaneId &&
		left.createdAt === right.createdAt;
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
		if (this.entries().some((candidate) => candidate.label === entry.label)) {
			throw new Error(`Process label already exists: ${entry.label}`);
		}
		const stableIdentity = terminalIdentity(entry);
		if (stableIdentity && this.entries().some((candidate) => terminalIdentity(candidate) === stableIdentity)) {
			throw new Error(`Terminal ${entry.terminalId} is already registered`);
		}
		if (entry.paneId === entry.ownerPaneId) throw new Error("Refusing to register the caller pane as a managed process");
		this.byPane.set(entry.paneId, { ...entry });
	}

	find(target: string): ProcessEntry | undefined {
		return this.byPane.get(target) ?? this.entries().find((entry) =>
			entry.label === target || entry.terminalId === target);
	}

	findOwned(reference: ProcessEntry): ProcessEntry | undefined {
		return this.entries().find((entry) => sameProcessOwnership(entry, reference));
	}

	latest(): ProcessEntry | undefined {
		return this.entries().at(-1);
	}

	updateLocation(
		reference: ProcessEntry,
		location: ProcessPaneLocation,
		serverScope: string,
	): { entry: ProcessEntry; changed: boolean } | undefined {
		const current = this.findOwned(reference);
		if (!current) return undefined;
		const next: ProcessEntry = {
			...current,
			paneId: location.paneId,
			...(location.terminalId ? { terminalId: location.terminalId, serverScope } : {}),
			...(location.workspaceId ? { workspaceId: location.workspaceId } : {}),
			...(location.tabId ? { tabId: location.tabId } : {}),
		};
		if (!isProcessEntry(next)) throw new Error("Refusing invalid process pane relocation");
		const occupied = this.byPane.get(next.paneId);
		if (occupied && !sameProcessOwnership(occupied, current)) {
			throw new Error(`Pane ${next.paneId} is already registered`);
		}
		const changed = next.paneId !== current.paneId ||
			next.terminalId !== current.terminalId ||
			next.serverScope !== current.serverScope ||
			next.workspaceId !== current.workspaceId ||
			next.tabId !== current.tabId;
		if (changed) {
			this.byPane.delete(current.paneId);
			this.byPane.set(next.paneId, next);
		}
		return { entry: changed ? { ...next } : { ...current }, changed };
	}

	remove(target: string): ProcessEntry | undefined {
		const entry = this.find(target);
		if (entry) this.byPane.delete(entry.paneId);
		return entry;
	}

	removeOwned(reference: ProcessEntry): ProcessEntry | undefined {
		const entry = this.findOwned(reference);
		if (entry) this.byPane.delete(entry.paneId);
		return entry;
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
