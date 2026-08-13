import { randomUUID } from "node:crypto";
import { resolve } from "node:path";
import {
	DEFAULT_MAX_BYTES,
	DEFAULT_MAX_LINES,
	formatSize,
	truncateTail,
} from "@earendil-works/pi-coding-agent";
import type {
	CompanionConfig,
	ProcessLifetime,
	ProcessShell,
	SplitDirection,
} from "../config.ts";
import {
	isMissingPaneError,
	type HerdrClient,
	type HerdrPane,
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
	processServerScope,
	sameProcessOwnership,
	type ProcessEntry,
	type ProcessRegistrySnapshot,
	type SessionShutdownReason,
	type SessionStartReason,
} from "./registry.ts";
import {
	ProcessCommandTransport,
	type ProcessCommandPreparer,
} from "./transport.ts";

export type ProcessClient = Pick<
	HerdrClient,
	| "splitPane"
	| "listPanes"
	| "getPaneProcessInfo"
	| "renamePane"
	| "runPane"
	| "waitOutput"
	| "readPane"
	| "focusPane"
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
	shell?: ProcessShell;
}

export type ProcessRuntimeState = "running" | "starting" | "exited" | "unknown";

export interface ProcessPaneState {
	paneId: string;
	terminalId?: string;
	workspaceId?: string;
	tabId?: string;
	agent?: string;
	agentStatus?: string;
	hasAgentSession: boolean;
}

export interface ProcessListResult {
	entries: ProcessEntry[];
	stale: ProcessEntry[];
	states: Record<string, ProcessRuntimeState>;
	panes: Record<string, ProcessPaneState>;
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
	commandTransport?: ProcessCommandPreparer;
	now?: () => Date;
	startGraceMs?: number;
}

interface ReconcileResult {
	stale: ProcessEntry[];
	states: Record<string, ProcessRuntimeState>;
	panes: Record<string, ProcessPaneState>;
}

interface PendingStart {
	token: string;
	entry: ProcessEntry;
	controller: AbortController;
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
	private readonly pendingStarts = new Map<string, PendingStart>();
	private readonly startControllers = new Set<AbortController>();
	private readonly now: () => Date;
	private readonly startGraceMs: number;
	private readonly commandTransport: ProcessCommandPreparer;
	private readonly serverScope: string;
	private readonly changeListeners = new Set<() => void>();

	constructor(private readonly options: ProcessManagerOptions) {
		this.now = options.now ?? (() => new Date());
		this.startGraceMs = options.startGraceMs ?? 2_000;
		this.commandTransport = options.commandTransport ?? new ProcessCommandTransport();
		this.serverScope = processServerScope(options.runtime.socketPath ?? "");
	}

	private exclusive<T>(operation: () => Promise<T>): Promise<T> {
		const next = this.operation.then(operation, operation);
		this.operation = next.catch(() => undefined);
		return next;
	}

	onChange(listener: () => void): () => void {
		this.changeListeners.add(listener);
		return () => this.changeListeners.delete(listener);
	}

	private notifyChange(): void {
		for (const listener of this.changeListeners) {
			try {
				listener();
			} catch {
				// Presentation subscribers must never break ownership transitions.
			}
		}
	}

	private persist(): void {
		this.options.persist(this.registry.snapshot());
	}

	private pendingFor(entry: ProcessEntry): [string, PendingStart] | undefined {
		return [...this.pendingStarts.entries()].find(([, pending]) =>
			sameProcessOwnership(pending.entry, entry));
	}

	private async reconcileNow(signal?: AbortSignal): Promise<ReconcileResult> {
		return this.reconcileAgainstLivePanes(await this.options.client.listPanes(signal), signal);
	}

	private async reconcileAgainstLivePanes(
		livePanes: readonly HerdrPane[],
		signal?: AbortSignal,
	): Promise<ReconcileResult> {
		const byTerminalId = new Map<string, HerdrPane>();
		for (const pane of livePanes) {
			if (!pane.terminalId) continue;
			if (byTerminalId.has(pane.terminalId)) {
				throw new Error(`Herdr pane list returned duplicate terminal_id ${pane.terminalId}`);
			}
			byTerminalId.set(pane.terminalId, pane);
		}

		const stale: ProcessEntry[] = [];
		const panes: Record<string, ProcessPaneState> = {};
		const resolved: Array<{ original: ProcessEntry; live: HerdrPane }> = [];
		let registryChanged = false;
		for (const original of this.registry.entries()) {
			const live = original.terminalId && original.serverScope === this.serverScope
				? byTerminalId.get(original.terminalId)
				: undefined;
			if (live) {
				resolved.push({ original, live });
				continue;
			}
			stale.push(original);
			this.registry.removeOwned(original);
			const pending = this.pendingFor(original);
			if (pending) {
				pending[1].controller.abort(new Error("Managed process pane disappeared during startup"));
				this.pendingStarts.delete(pending[0]);
			}
			registryChanged = true;
		}

		// Remove every stale address before relocating live terminals. This keeps a
		// stale registry row from temporarily occupying a live terminal's new pane ID.
		for (const { original, live } of resolved) {
			const relocated = this.registry.updateLocation(original, live, this.serverScope);
			if (!relocated) continue;
			registryChanged ||= relocated.changed;
			const entry = relocated.entry;
			panes[entry.paneId] = {
				paneId: entry.paneId,
				...(entry.terminalId ? { terminalId: entry.terminalId } : {}),
				...(entry.workspaceId ? { workspaceId: entry.workspaceId } : {}),
				...(entry.tabId ? { tabId: entry.tabId } : {}),
				...(live.agent ? { agent: live.agent } : {}),
				...(live.agentStatus ? { agentStatus: live.agentStatus } : {}),
				hasAgentSession: live.agentSession !== undefined,
			};
		}

		const states: Record<string, ProcessRuntimeState> = {};
		for (const entry of this.registry.entries()) {
			if (this.pendingFor(entry)) {
				states[entry.paneId] = "starting";
				continue;
			}
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
				// The live pane listing just confirmed this pane. A transient/protocol
				// process-info failure alone never authorizes ownership removal.
				states[entry.paneId] = "unknown";
			}
		}
		if (registryChanged) {
			this.persist();
			this.notifyChange();
		}
		return { stale, states, panes };
	}

	rehydrate(snapshot: ProcessRegistrySnapshot, reason: SessionStartReason): Promise<ProcessListResult> {
		return this.exclusive(async () => {
			this.registry.replace(snapshot);
			const replacement = reason === "new" || reason === "resume" || reason === "fork";
			if (replacement) {
				// Persisted pane addresses may be stale after a move or Herdr restart.
				// Lifecycle cleanup verifies terminal_id against a fresh pane list first.
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
			const merged = new ProcessRegistry(this.registry.snapshot());
			for (const candidate of snapshot.entries) {
				if (merged.findOwned(candidate)) continue;
				if (candidate.ownerSessionId !== currentSessionId ||
					candidate.ownerPaneId !== this.options.runtime.paneId ||
					!mayCloseOwnedProcess(candidate, this.options.runtime.paneId) ||
					merged.find(candidate.label)) continue;
				merged.add(candidate);
			}
			// Commit the conservative union only after every add succeeds, so an
			// invalid branch collision cannot leave a half-merged in-memory registry.
			this.registry.replace(merged.snapshot());
			// Persist the merged evidence before pane-list/process-info. If either
			// probe fails transiently, neither current nor valid branch ownership is lost.
			this.persist();
			const reconciled = await this.reconcileAgainstLivePanes(await this.options.client.listPanes());
			this.persist();
			this.notifyChange();
			return { entries: this.registry.entries(), ...reconciled };
		});
	}

	start(input: StartProcessInput, context: { cwd: string; sessionId: string }, signal?: AbortSignal): Promise<ProcessEntry> {
		const controller = new AbortController();
		const operationSignal = signal ? AbortSignal.any([signal, controller.signal]) : controller.signal;
		const token = randomUUID();
		this.startControllers.add(controller);

		return (async () => {
			let entry: ProcessEntry | undefined;
			let ownershipPublished = false;
			let cleanupLaunchArtifact: (() => Promise<void>) | undefined;
			try {
				const prepared = await this.exclusive(async () => {
					operationSignal.throwIfAborted();
					const command = validateCommand(input.command);
					if ((input.readyMatch !== undefined ? 1 : 0) + (input.readyRegex !== undefined ? 1 : 0) > 1) {
						throw new Error("readyMatch and readyRegex are mutually exclusive");
					}
					if (input.readyMatch !== undefined && !input.readyMatch) throw new Error("readyMatch must not be empty");
					if (input.readyRegex !== undefined && !input.readyRegex) throw new Error("readyRegex must not be empty");
					const config = this.options.getConfig().process;
					const shell = input.shell ?? config.defaultShell;
					if (shell !== "bash" && shell !== "pane") throw new Error("shell must be bash or pane");
					if (shell === "pane" && input.readyMatch !== undefined && command.includes(input.readyMatch)) {
						throw new Error("readyMatch appears in the launch command and could match pane shell echo; use a marker absent from the command or an anchored readyRegex");
					}
					await this.reconcileNow(operationSignal);
					const label = normalizeProcessLabel(input.label?.trim() || deriveProcessLabel(command));
					if (this.registry.find(label)) throw new Error(`Process label already exists: ${label}`);
					const cwd = resolve(context.cwd, input.cwd?.trim() || ".");
					const ratio = validateRatio(input.ratio ?? config.defaultRatio);
					const direction = input.direction ?? config.defaultDirection;
					const lifetime = input.lifetime ?? config.defaultLifetime;
					const readyTimeoutMs = validateTimeout(input.readyTimeoutMs ?? config.readyTimeoutMs);
					const preparedCommand = await this.commandTransport.prepare(command, shell);
					cleanupLaunchArtifact = preparedCommand.cleanup;
					if (input.readyMatch !== undefined && preparedCommand.paneCommand.includes(input.readyMatch)) {
						throw new Error("readyMatch appears in the pane launch command and could match shell echo; use a marker absent from the launch wrapper or an anchored readyRegex");
					}

					let paneId: string | undefined;
					let createdPane: HerdrPane | undefined;
					try {
						createdPane = await this.options.client.splitPane({
							target: "current",
							direction,
							ratio,
							cwd,
							focus: false,
						}, operationSignal);
						paneId = createdPane.paneId;
						if (!paneId || paneId === this.options.runtime.paneId) {
							throw new Error("Herdr returned the caller pane instead of a new process pane");
						}
						if (!createdPane.terminalId) {
							throw new Error("Herdr pane split did not return terminal_id; update Herdr before starting managed processes");
						}
						await this.options.client.renamePane(paneId, label, operationSignal);
						await this.options.client.runPane(paneId, preparedCommand.paneCommand, operationSignal);
					} catch (error) {
						if (paneId && paneId !== this.options.runtime.paneId) {
							await this.options.client.closePane(paneId).catch(() => undefined);
						}
						await preparedCommand.cleanup().catch(() => undefined);
						throw error;
					}

					const ownerPaneId = this.options.runtime.paneId;
					if (!ownerPaneId) {
						await this.options.client.closePane(paneId).catch(() => undefined);
						throw new Error("Cannot establish process ownership without HERDR_PANE_ID");
					}
					const provisional: ProcessEntry = {
						owner: PROCESS_OWNER,
						paneId,
						terminalId: createdPane.terminalId as string,
						serverScope: this.serverScope,
						...(createdPane.workspaceId ? { workspaceId: createdPane.workspaceId } : {}),
						...(createdPane.tabId ? { tabId: createdPane.tabId } : {}),
						label,
						command,
						cwd,
						lifetime,
						createdAt: this.now().toISOString(),
						ownerSessionId: context.sessionId,
						ownerPaneId,
						shell,
					};
					// Publish the local rollback identity before registry persistence. If
					// appendEntry throws, the outer failure path can still close this exact pane.
					entry = provisional;
					this.registry.add(provisional);
					this.pendingStarts.set(token, { token, entry: provisional, controller });
					ownershipPublished = true;
					// Persist provisional ownership before a potentially long readiness wait,
					// so stop/shutdown/reload and crash recovery can still find the pane.
					this.persist();
					this.notifyChange();
					return { entry: provisional, readyTimeoutMs };
				});
				entry = prepared.entry;

				if (input.readyMatch || input.readyRegex) {
					await this.options.client.waitOutput(entry.paneId, {
						...(input.readyMatch ? { match: input.readyMatch } : { regex: input.readyRegex }),
						timeoutMs: prepared.readyTimeoutMs,
						lines: DEFAULT_MAX_LINES,
					}, operationSignal);
				}
				operationSignal.throwIfAborted();
				return await this.exclusive(async () => {
					const pending = this.pendingStarts.get(token);
					const owned = entry ? this.registry.findOwned(entry) : undefined;
					if (!entry || !pending || !owned) {
						throw new Error("Managed process start was cancelled before readiness completed");
					}
					this.pendingStarts.delete(token);
					this.notifyChange();
					return owned;
				});
			} catch (error) {
				let closeFailure: unknown;
				let persistenceCleanupFailure: unknown;
				if (entry) {
					await this.exclusive(async () => {
						if (!entry) return;
						const pending = this.pendingStarts.get(token);
						let owned = this.registry.findOwned(entry);
						// stop/shutdown may already have closed and forgotten a published start.
						if (ownershipPublished && !pending && !owned) return;
						this.pendingStarts.delete(token);

						let cleanupEntry = owned ?? entry;
						let closed = false;
						let verified = !cleanupEntry.terminalId;
						if (cleanupEntry.terminalId) {
							try {
								// A readiness wait leaves time for the Pane to move or its old public
								// address to be reused. Never let this fallback bypass the same live
								// terminal verification required by lifecycle cleanup.
								await this.reconcileNow();
								owned = this.registry.findOwned(entry);
								if (!owned) closed = true;
								else {
									cleanupEntry = owned;
									verified = true;
								}
							} catch (verificationError) {
								closeFailure = new Error(
									`live terminal verification failed: ${verificationError instanceof Error ? verificationError.message : String(verificationError)}`,
									{ cause: verificationError },
								);
							}
						}

						const registryEntryBelongsToStart = owned !== undefined &&
							owned.ownerSessionId === entry.ownerSessionId &&
							owned.ownerPaneId === entry.ownerPaneId &&
							owned.createdAt === entry.createdAt;
						if (owned && !registryEntryBelongsToStart) return;

						if (!closed && verified && mayCloseOwnedProcess(cleanupEntry, this.options.runtime.paneId)) {
							try {
								await this.options.client.closePane(cleanupEntry.paneId);
								closed = true;
							} catch (closeError) {
								// A missing public pane ID does not prove a stable terminal is gone;
								// it may have moved and acquired a new address.
								closed = isMissingPaneError(closeError) && !cleanupEntry.terminalId;
								if (!closed) closeFailure = closeError;
							}
						}

						if (closed && registryEntryBelongsToStart) this.registry.removeOwned(entry);
						if (!closed && !owned) {
							// A split/run may have succeeded before registry persistence failed.
							// Retain in-memory ownership when close cannot prove the pane gone.
							try {
								this.registry.add(entry);
							} catch {
								// Another valid owner or duplicate label remains the safer authority.
							}
						}
						try {
							this.persist();
							this.notifyChange();
						} catch (persistError) {
							persistenceCleanupFailure = persistError;
						}
					});
				}
				await cleanupLaunchArtifact?.().catch(() => undefined);
				if (entry && (closeFailure || persistenceCleanupFailure)) {
					const original = error instanceof Error ? error.message : String(error);
					const cleanup = [
						closeFailure ? `pane close failed: ${closeFailure instanceof Error ? closeFailure.message : String(closeFailure)}` : undefined,
						persistenceCleanupFailure ? `ownership cleanup persistence failed: ${persistenceCleanupFailure instanceof Error ? persistenceCleanupFailure.message : String(persistenceCleanupFailure)}` : undefined,
					].filter(Boolean).join("; ");
					const recoveryEntry = this.registry.findOwned(entry) ?? entry;
					throw new Error(`${original}. Managed pane ${recoveryEntry.paneId} cleanup was incomplete (${cleanup}); ownership was retained when possible. Use herdr_process list/stop to retry.`, { cause: error });
				}
				throw error;
			} finally {
				this.startControllers.delete(controller);
			}
		})();
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
			const normalizedTarget = target?.trim();
			if (target !== undefined && !normalizedTarget) throw new Error("target must not be empty");
			const beforeReconcile = normalizedTarget ? this.registry.find(normalizedTarget) : this.registry.latest();
			await this.reconcileNow(signal);
			const entry = beforeReconcile
				? this.registry.findOwned(beforeReconcile)
				: normalizedTarget ? this.registry.find(normalizedTarget) : this.registry.latest();
			if (!entry) throw new Error(normalizedTarget ? `No owned process matches ${normalizedTarget}` : "No owned process is registered");
			let output: string;
			try {
				output = await this.options.client.readPane(entry.paneId, lines, signal);
			} catch (error) {
				if (isMissingPaneError(error) && !entry.terminalId) {
					this.registry.removeOwned(entry);
					this.persist();
					this.notifyChange();
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
			const normalizedTarget = target?.trim();
			if (target !== undefined && !normalizedTarget) throw new Error("target must not be empty");
			const beforeReconcile = normalizedTarget ? this.registry.find(normalizedTarget) : this.registry.latest();
			await this.reconcileNow(signal);
			const entry = beforeReconcile
				? this.registry.findOwned(beforeReconcile)
				: normalizedTarget ? this.registry.find(normalizedTarget) : this.registry.latest();
			if (!entry) throw new Error(normalizedTarget ? `No owned process matches ${normalizedTarget}` : "No owned process is registered");
			if (!mayCloseOwnedProcess(entry, this.options.runtime.paneId)) {
				throw new Error(`Refusing to close unowned or caller pane ${entry.paneId}`);
			}
			const pending = this.pendingFor(entry);
			pending?.[1].controller.abort(new Error("Managed process start was stopped"));
			try {
				await this.options.client.closePane(entry.paneId, signal);
			} catch (error) {
				if (!isMissingPaneError(error) || entry.terminalId) throw error;
			}
			if (pending) this.pendingStarts.delete(pending[0]);
			this.registry.removeOwned(entry);
			this.persist();
			this.notifyChange();
			return entry;
		});
	}

	focus(target: string, signal?: AbortSignal): Promise<ProcessEntry> {
		return this.exclusive(async () => {
			const normalizedTarget = target.trim();
			if (!normalizedTarget) throw new Error("focus target must not be empty");
			const beforeReconcile = this.registry.find(normalizedTarget);
			await this.reconcileNow(signal);
			const entry = beforeReconcile
				? this.registry.findOwned(beforeReconcile)
				: this.registry.find(normalizedTarget);
			if (!entry) throw new Error(`No owned process matches ${normalizedTarget}`);
			await this.options.client.focusPane(entry.paneId, signal);
			return entry;
		});
	}

	shutdown(reason: SessionShutdownReason): Promise<void> {
		// Cancellation must happen before joining the queue: readiness waits run
		// outside it, while split/run calls inside it receive the same signal.
		for (const controller of this.startControllers) {
			controller.abort(new Error(`Managed process start cancelled by session ${reason}`));
		}
		return this.exclusive(async () => {
			const pending = [...this.pendingStarts.entries()];
			const pendingEntries = pending.map(([, item]) => item.entry);
			const lifecycleEntries = processEntriesToCloseOnShutdown(this.registry.entries(), reason)
				.filter((entry) => !pendingEntries.some((pendingEntry) =>
					sameProcessOwnership(entry, pendingEntry)));
			await this.closeLifecycleEntries([...pendingEntries, ...lifecycleEntries]);
			for (const [token, item] of pending) {
				if (!this.registry.findOwned(item.entry)) this.pendingStarts.delete(token);
			}
		});
	}

	private async closeLifecycleEntries(entries: readonly ProcessEntry[]): Promise<void> {
		if (entries.length === 0) return;
		// Never authorize a close from persisted paneId alone. A successful fresh
		// reconciliation either relocates the same terminal or removes stale ownership;
		// a list failure or duplicate terminal_id throws before any pane is touched.
		await this.reconcileNow();
		let changed = false;
		const failures: Array<{ entry: ProcessEntry; error: unknown }> = [];
		for (const reference of entries) {
			const entry = this.registry.findOwned(reference);
			if (!entry) continue;
			if (!entry.terminalId || entry.serverScope !== this.serverScope) {
				// Reconciliation normally removed this already. Keep this guard so a
				// legacy or foreign-scope row can never authorize a pane close.
				this.registry.removeOwned(entry);
				changed = true;
				continue;
			}
			if (!mayCloseOwnedProcess(entry, this.options.runtime.paneId)) continue;
			try {
				await this.options.client.closePane(entry.paneId);
				this.registry.removeOwned(entry);
				changed = true;
			} catch (error) {
				// Preserve verified ownership on any close failure so a later list/stop
				// can reconcile again. Missing by paneId may only mean it moved again.
				failures.push({ entry, error });
			}
		}
		let persistenceFailure: unknown;
		if (changed) {
			try {
				this.persist();
				this.notifyChange();
			} catch (error) {
				persistenceFailure = error;
			}
		}
		if (failures.length > 0 || persistenceFailure) {
			const closeSummary = failures.length > 0
				? `Could not close verified managed Pane(s): ${failures.map(({ entry, error }) =>
					`${entry.paneId}: ${error instanceof Error ? error.message : String(error)}`).join("; ")}. Ownership was retained for herdr_process list/stop retry.`
				: undefined;
			const persistenceSummary = persistenceFailure
				? `Lifecycle ownership persistence failed: ${persistenceFailure instanceof Error ? persistenceFailure.message : String(persistenceFailure)}.`
				: undefined;
			throw new Error(
				[closeSummary, persistenceSummary].filter(Boolean).join(" "),
				{ cause: new AggregateError([
					...failures.map(({ error }) => error),
					...(persistenceFailure ? [persistenceFailure] : []),
				]) },
			);
		}
	}
}
