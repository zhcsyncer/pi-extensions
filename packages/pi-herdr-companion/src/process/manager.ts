import { resolve } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import type { CompanionConfig, ProcessLifetime, SplitDirection } from "../config.ts";
import {
	isMissingPaneError,
	type HerdrClient,
	type HerdrPaneProcessInfo,
} from "../herdr-client.ts";
import type { RuntimeSnapshot } from "../runtime.ts";
import {
	deriveProcessLabel,
	mayCloseOwnedProcess,
	normalizeProcessLabel,
	PROCESS_OWNER,
	ProcessRegistry,
	processEntriesToCloseOnShutdown,
	processEntriesToCloseOnStart,
	type ProcessEntry,
	type ProcessRegistrySnapshot,
	type SessionShutdownReason,
	type SessionStartReason,
} from "./registry.ts";

export type ProcessClient = Pick<
	HerdrClient,
	| "splitPane"
	| "listPanes"
	| "getPaneProcessInfo"
	| "renamePane"
	| "runPane"
	| "waitOutput"
	| "readPane"
	| "closePane"
>;

export interface StartProcessInput {
	command: string;
	cwd?: string;
	label?: string;
	direction?: SplitDirection;
	ratio?: number;
	readyMatch?: string;
	readyRegex?: string;
	readyTimeoutMs?: number;
	lifetime?: ProcessLifetime;
}

export type ProcessRuntimeState = "running" | "starting" | "exited" | "unknown";

export interface ProcessListResult {
	entries: ProcessEntry[];
	stale: ProcessEntry[];
	states: Record<string, ProcessRuntimeState>;
}

export interface ProcessLogsResult {
	entry: ProcessEntry;
	text: string;
	truncated: boolean;
}

export interface ProcessManagerOptions {
	client: ProcessClient;
	runtime: RuntimeSnapshot;
	getConfig(): CompanionConfig;
	persist(snapshot: ProcessRegistrySnapshot): void;
	now?: () => Date;
	startGraceMs?: number;
}

interface ReconcileResult {
	stale: ProcessEntry[];
	states: Record<string, ProcessRuntimeState>;
}

type ForegroundState = "command" | "shell" | "unknown";

function validateRatio(value: number): number {
	if (!Number.isFinite(value) || value < 0.1 || value > 0.9) throw new Error("ratio must be between 0.1 and 0.9");
	return value;
}

function validateTimeout(value: number): number {
	if (!Number.isFinite(value) || value < 100 || value > 600_000) {
		throw new Error("readyTimeoutMs must be between 100 and 600000");
	}
	return Math.floor(value);
}

function validateCommand(value: string): string {
	const command = value.trim();
	if (!command) throw new Error("start requires a non-empty command");
	if (command.includes("\0")) throw new Error("command must not contain NUL bytes");
	if (Buffer.byteLength(command, "utf8") > 64 * 1024) throw new Error("command must not exceed 64 KiB");
	return command;
}

/** Distinguish an actual foreground job from the pane's returned interactive shell. */
export function classifyForegroundProcess(info: HerdrPaneProcessInfo): ForegroundState {
	if (!info.shellPid || !info.foregroundProcessGroupId || info.foregroundProcesses.length === 0) return "unknown";
	const shellOnly = info.foregroundProcessGroupId === info.shellPid &&
		info.foregroundProcesses.every((process) => process.pid === info.shellPid);
	if (shellOnly) return "shell";
	if (info.foregroundProcessGroupId !== info.shellPid ||
		info.foregroundProcesses.some((process) => process.pid !== info.shellPid)) return "command";
	return "unknown";
}

export class ProcessManager {
	readonly registry = new ProcessRegistry();
	private operation: Promise<unknown> = Promise.resolve();
	private readonly now: () => Date;
	private readonly startGraceMs: number;

	constructor(private readonly options: ProcessManagerOptions) {
		this.now = options.now ?? (() => new Date());
		this.startGraceMs = options.startGraceMs ?? 2_000;
	}

	private exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.operation.then(operation, operation);
		this.operation = next.catch(() => undefined);
		return next;
	}

	private persist(): void {
		this.options.persist(this.registry.snapshot());
	}

	private async reconcileNow(signal?: AbortSignal): Promise<ReconcileResult> {
		const live = new Set((await this.options.client.listPanes(signal)).map((pane) => pane.paneId));
		return this.reconcileAgainstLivePanes(live, signal);
	}

	private async reconcileAgainstLivePanes(
		livePaneIds: ReadonlySet<string>,
		signal?: AbortSignal,
	): Promise<ReconcileResult> {
		const stale = this.registry.reconcile(livePaneIds);
		const states: Record<string, ProcessRuntimeState> = {};
		for (const entry of this.registry.entries()) {
			try {
				const info = await this.options.client.getPaneProcessInfo(entry.paneId, signal);
				if (info.paneId !== entry.paneId) {
					states[entry.paneId] = "unknown";
					continue;
				}
				const foreground = classifyForegroundProcess(info);
				if (foreground === "command") {
					states[entry.paneId] = "running";
					continue;
				}
				if (foreground === "unknown") {
					states[entry.paneId] = "unknown";
					continue;
				}
				const createdAt = Date.parse(entry.createdAt);
				if (Number.isFinite(createdAt) && this.now().getTime() - createdAt < this.startGraceMs) {
					states[entry.paneId] = "starting";
					continue;
				}
				// A returned shell is still an owned, observable pane. Keep it so logs,
				// stop, duplicate-label protection, and lifecycle cleanup remain available.
				states[entry.paneId] = "exited";
			} catch {
				// The live pane listing just confirmed this pane. Herdr 0.7.5 or a
				// transient/protocol failure may not provide reliable process data, so
				// process-info alone never authorizes ownership removal.
				states[entry.paneId] = "unknown";
			}
		}
		if (stale.length > 0) this.persist();
		return { stale, states };
	}

	rehydrate(snapshot: ProcessRegistrySnapshot, reason: SessionStartReason): Promise<ProcessListResult> {
		return this.exclusive(async () => {
			this.registry.replace(snapshot);
			// Replacement sessions must attempt persisted cleanup before any pane-list
			// probe: a transient list failure must not skip all expected closes.
			if (reason === "new" || reason === "resume" || reason === "fork") {
				await this.closeLifecycleEntries(processEntriesToCloseOnStart(this.registry.entries(), reason));
			}
			const reconciled = await this.reconcileNow();
			return { entries: this.registry.entries(), ...reconciled };
		});
	}

	/**
	 * `/tree` changes the branch, not the live runtime owner. Merge current
	 * ownership with branch records bound to this exact session/caller before
	 * any fallible Herdr probe, persist that conservative union on the selected
	 * branch, then reconcile it against live pane/process state.
	 */
	rebindTree(snapshot: ProcessRegistrySnapshot, currentSessionId: string): Promise<ProcessListResult> {
		return this.exclusive(async () => {
			for (const candidate of snapshot.entries) {
				if (this.registry.find(candidate.paneId)) continue;
				if (candidate.ownerSessionId !== currentSessionId ||
					candidate.ownerPaneId !== this.options.runtime.paneId ||
					!mayCloseOwnedProcess(candidate, this.options.runtime.paneId) ||
					this.registry.find(candidate.label)) continue;
				this.registry.add(candidate);
			}
			// Persist the merged evidence before pane-list/process-info. If either
			// probe fails transiently, neither current nor valid branch ownership is lost.
			this.persist();
			const livePaneIds = new Set((await this.options.client.listPanes()).map((pane) => pane.paneId));
			const reconciled = await this.reconcileAgainstLivePanes(livePaneIds);
			this.persist();
			return { entries: this.registry.entries(), ...reconciled };
		});
	}

	start(input: StartProcessInput, context: { cwd: string; sessionId: string }, signal?: AbortSignal): Promise<ProcessEntry> {
		return this.exclusive(async () => {
			const command = validateCommand(input.command);
			if ((input.readyMatch !== undefined ? 1 : 0) + (input.readyRegex !== undefined ? 1 : 0) > 1) {
				throw new Error("readyMatch and readyRegex are mutually exclusive");
			}
			if (input.readyMatch !== undefined && !input.readyMatch) throw new Error("readyMatch must not be empty");
			if (input.readyRegex !== undefined && !input.readyRegex) throw new Error("readyRegex must not be empty");
			if (input.readyMatch !== undefined && command.includes(input.readyMatch)) {
				throw new Error("readyMatch appears in the launch command and could match shell echo; use a marker absent from the command or an anchored readyRegex");
			}
			await this.reconcileNow(signal);
			const config = this.options.getConfig().process;
			const label = normalizeProcessLabel(input.label?.trim() || deriveProcessLabel(command));
			if (this.registry.find(label)) throw new Error(`Process label already exists: ${label}`);
			const cwd = resolve(context.cwd, input.cwd?.trim() || ".");
			const ratio = validateRatio(input.ratio ?? config.defaultRatio);
			const direction = input.direction ?? config.defaultDirection;
			const lifetime = input.lifetime ?? config.defaultLifetime;
			const readyTimeoutMs = validateTimeout(input.readyTimeoutMs ?? config.readyTimeoutMs);

			let paneId: string | undefined;
			try {
				const pane = await this.options.client.splitPane({
					target: "current",
					direction,
					ratio,
					cwd,
					focus: false,
				}, signal);
				paneId = pane.paneId;
				if (!paneId || paneId === this.options.runtime.paneId) {
					throw new Error("Herdr returned the caller pane instead of a new process pane");
				}
				await this.options.client.renamePane(paneId, label, signal);
				await this.options.client.runPane(paneId, command, signal);
				if (input.readyMatch || input.readyRegex) {
					await this.options.client.waitOutput(paneId, {
						...(input.readyMatch ? { match: input.readyMatch } : { regex: input.readyRegex }),
						timeoutMs: readyTimeoutMs,
						lines: DEFAULT_MAX_LINES,
					}, signal);
				}
			} catch (error) {
				if (paneId && paneId !== this.options.runtime.paneId) {
					await this.options.client.closePane(paneId).catch(() => undefined);
				}
				throw error;
			}

			const ownerPaneId = this.options.runtime.paneId;
			if (!ownerPaneId) {
				await this.options.client.closePane(paneId).catch(() => undefined);
				throw new Error("Cannot establish process ownership without HERDR_PANE_ID");
			}
			const entry: ProcessEntry = {
				owner: PROCESS_OWNER,
				paneId,
				label,
				command,
				cwd,
				lifetime,
				createdAt: this.now().toISOString(),
				ownerSessionId: context.sessionId,
				ownerPaneId,
			};
			this.registry.add(entry);
			this.persist();
			return entry;
		});
	}

	list(signal?: AbortSignal): Promise<ProcessListResult> {
		return this.exclusive(async () => {
			const reconciled = await this.reconcileNow(signal);
			return { entries: this.registry.entries(), ...reconciled };
		});
	}

	logs(target: string | undefined, lines = 200, signal?: AbortSignal): Promise<ProcessLogsResult> {
		return this.exclusive(async () => {
			if (!Number.isInteger(lines) || lines < 1 || lines > DEFAULT_MAX_LINES) {
				throw new Error(`lines must be an integer between 1 and ${DEFAULT_MAX_LINES}`);
			}
			await this.reconcileNow(signal);
			const normalizedTarget = target?.trim();
			if (target !== undefined && !normalizedTarget) throw new Error("target must not be empty");
			const entry = normalizedTarget ? this.registry.find(normalizedTarget) : this.registry.latest();
			if (!entry) throw new Error(normalizedTarget ? `No owned process matches ${normalizedTarget}` : "No owned process is registered");
			let output: string;
			try {
				output = await this.options.client.readPane(entry.paneId, lines, signal);
			} catch (error) {
				if (isMissingPaneError(error)) {
					this.registry.remove(entry.paneId);
					this.persist();
				}
				throw error;
			}
			const truncated = truncateTail(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
			const note = truncated.truncated
				? `\n\n[Output truncated to the last ${truncated.outputLines} of ${truncated.totalLines} lines (${formatSize(truncated.outputBytes)} of ${formatSize(truncated.totalBytes)}). The full output remains in Herdr pane ${entry.paneId}.]`
				: "";
			return { entry, text: `${truncated.content}${note}`, truncated: truncated.truncated };
		});
	}

	stop(target: string | undefined, signal?: AbortSignal): Promise<ProcessEntry> {
		return this.exclusive(async () => {
			await this.reconcileNow(signal);
			const normalizedTarget = target?.trim();
			if (target !== undefined && !normalizedTarget) throw new Error("target must not be empty");
			const entry = normalizedTarget ? this.registry.find(normalizedTarget) : this.registry.latest();
			if (!entry) throw new Error(normalizedTarget ? `No owned process matches ${normalizedTarget}` : "No owned process is registered");
			if (!mayCloseOwnedProcess(entry, this.options.runtime.paneId)) {
				throw new Error(`Refusing to close unowned or caller pane ${entry.paneId}`);
			}
			try {
				await this.options.client.closePane(entry.paneId, signal);
			} catch (error) {
				if (!isMissingPaneError(error)) throw error;
			}
			this.registry.remove(entry.paneId);
			this.persist();
			return entry;
		});
	}

	shutdown(reason: SessionShutdownReason): Promise<void> {
		return this.exclusive(async () => {
			await this.closeLifecycleEntries(processEntriesToCloseOnShutdown(this.registry.entries(), reason));
		});
	}

	private async closeLifecycleEntries(entries: readonly ProcessEntry[]): Promise<void> {
		let changed = false;
		for (const entry of entries) {
			if (!mayCloseOwnedProcess(entry, this.options.runtime.paneId)) continue;
			try {
				await this.options.client.closePane(entry.paneId);
				this.registry.remove(entry.paneId);
				changed = true;
			} catch (error) {
				if (isMissingPaneError(error)) {
					this.registry.remove(entry.paneId);
					changed = true;
				}
				// Preserve ownership state on transient failures so a later operation can retry.
			}
		}
		if (changed) this.persist();
	}
}
