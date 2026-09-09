/**
 * agent-manager.ts — Tracks agents, background execution, resume support.
 *
 * Background agents are subject to a configurable concurrency limit (default: 4).
 * Excess agents are queued and auto-started as running agents complete.
 * Foreground agents bypass the queue (they block the parent anyway).
 */

import { randomUUID } from "node:crypto";
import { statSync } from "node:fs";
import { isAbsolute } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { AgentSession, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { restoreAgentSession, resumeAgent, runAgent, type ToolActivity } from "./agent-runner.js";
import type {
  AgentInvocation,
  AgentRecord,
  CompletionDelivery,
  CompletionOwner,
  InlineAgentConfig,
  IsolationMode,
  SubagentType,
  ThinkingLevel,
} from "./types.js";
import { listArchivedAgents, recordFromArchive } from "./session-archive.js";
import { shortModelLabel } from "./ui/agent-widget.js";
import { addUsage, createLifetimeUsage, type LifetimeUsage } from "./usage.js";
import {
  cleanupWorktree,
  createWorktree,
  isWorktreeIsolationEnabled,
  pruneWorktrees,
} from "./worktree.js";

export type OnAgentComplete = (record: AgentRecord) => void;
export type OnAgentStart = (record: AgentRecord) => void;
export type OnAgentCompact = (record: AgentRecord, info: CompactionInfo) => void;
export type CompactionInfo = { reason: "manual" | "threshold" | "overflow"; tokensBefore: number };

export interface AgentManagerOptions {
  /** Normal extension shutdown prunes worktree registrations; embedded callers can opt out. */
  pruneWorktreesOnDispose?: boolean;
  /** Persist admission before a new generation becomes visible or enters the queue. */
  onAccepted?: (record: AgentRecord) => void;
}

/** Default max concurrent background agents. */
const DEFAULT_MAX_CONCURRENT = 4;

/**
 * Validate a caller-supplied SpawnOptions.cwd. `undefined`/`null` mean "unset"
 * (parent cwd). Anything else must be an absolute path to an existing
 * directory — curated errors instead of TypeErrors from path/fs internals
 * (RPC callers send arbitrary JSON: null, numbers, file paths).
 */
function assertValidSpawnCwd(cwd: unknown): asserts cwd is string | undefined | null {
  if (cwd == null) return;
  if (typeof cwd !== "string" || !isAbsolute(cwd)) {
    throw new Error(`SpawnOptions.cwd must be an absolute path: "${String(cwd)}"`);
  }
  let isDirectory = false;
  try {
    isDirectory = statSync(cwd).isDirectory();
  } catch {
    throw new Error(`SpawnOptions.cwd does not exist: "${cwd}"`);
  }
  if (!isDirectory) {
    throw new Error(`SpawnOptions.cwd is not a directory: "${cwd}"`);
  }
}

interface SpawnArgs {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  type: SubagentType;
  prompt: string;
  options: SpawnOptions;
}

export interface SpawnOptions {
  description: string;
  model?: Model<any>;
  maxTurns?: number;
  /** Extra wrap-up turns after the soft maxTurns steer. Defaults to the global setting. */
  graceTurns?: number;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /** Optional role definition supplied directly by another extension. */
  inlineAgentConfig?: InlineAgentConfig;
  /** Defaults to runtime when omitted, preserving ordinary completion nudges. */
  completionOwner?: CompletionOwner;
  /** Opaque caller correlation key echoed through lifecycle events. */
  correlationId?: string;
  isBackground?: boolean;
  /** How completion is delivered to the parent. Defaults to detached follow-up delivery. */
  completionDelivery?: CompletionDelivery;
  /**
   * Skip the maxConcurrent queue check for this spawn — start immediately even
   * if the configured concurrency limit would otherwise queue it. Used by the
   * scheduler so a fired job can't be deferred past its trigger window.
   */
  bypassQueue?: boolean;
  /** Isolation mode — "worktree" creates a temp git worktree for the agent. */
  isolation?: IsolationMode;
  /**
   * Working directory for the agent (absolute path). Default: parent session
   * cwd. The agent's tools operate here, but .pi config (extensions, skills,
   * settings, memory) still loads from the parent session's project — the
   * target directory's `.pi` extensions never execute. With isolation:
   * "worktree", the worktree is created FROM this directory and the result
   * branch lands in that repo.
   */
  cwd?: string;
  /** Resolved invocation snapshot captured for UI display. */
  invocation?: AgentInvocation;
  /** Parent abort signal — when aborted, the subagent is also stopped. */
  signal?: AbortSignal;
  /** Called on tool start/end with activity info (for streaming progress to UI). */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Called when the agent session is created (for accessing session stats). */
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /** Called once per assistant message_end with that message's usage delta. */
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  /** Called when the session successfully compacts. */
  onCompaction?: (info: CompactionInfo) => void;
}

export class AgentManager {
  private agents = new Map<string, AgentRecord>();
  private cleanupInterval: ReturnType<typeof setInterval>;
  private onComplete?: OnAgentComplete;
  private onStart?: OnAgentStart;
  private onCompact?: OnAgentCompact;
  private maxConcurrent: number;
  /** Base repos worktrees were created from — so dispose() can prune them all,
   *  not just the parent repo (caller-supplied cwd can target other repos). */
  private worktreeRepos = new Set<string>();

  /** Queue of background agents waiting to start. */
  private queue: { id: string; start: () => void }[] = [];
  private steering = new Map<string, Set<Promise<void>>>();
  private steeringErrors = new Map<string, string>();
  /** Number of currently running background agents. */
  private runningBackground = 0;
  /** Independent of display status: resolves only after the execution promise settles. */
  private settlements = new Map<string, {
    promise: Promise<void>;
    resolve: () => void;
    settled: boolean;
  }>();

  constructor(
    onComplete?: OnAgentComplete,
    maxConcurrent = DEFAULT_MAX_CONCURRENT,
    onStart?: OnAgentStart,
    onCompact?: OnAgentCompact,
    private readonly options: AgentManagerOptions = {},
  ) {
    this.onComplete = onComplete;
    this.onStart = onStart;
    this.onCompact = onCompact;
    this.maxConcurrent = maxConcurrent;
    // Cleanup completed agents after 10 minutes (but keep sessions for resume)
    this.cleanupInterval = setInterval(() => this.cleanup(), 60_000);
    this.cleanupInterval.unref();
  }

  private createSettlement(id: string): void {
    let resolve!: () => void;
    const promise = new Promise<void>((done) => { resolve = done; });
    this.settlements.set(id, { promise, resolve, settled: false });
  }

  private settleExecution(id: string): void {
    const settlement = this.settlements.get(id);
    if (!settlement || settlement.settled) return;
    settlement.settled = true;
    settlement.resolve();
  }

  private isExecutionSettled(id: string): boolean {
    return this.settlements.get(id)?.settled ?? true;
  }

  /** Update the max concurrent background agents limit. */
  setMaxConcurrent(n: number) {
    this.maxConcurrent = Math.max(1, n);
    // Start queued agents if the new limit allows
    this.drainQueue();
  }

  getMaxConcurrent(): number {
    return this.maxConcurrent;
  }

  /**
   * Spawn an agent and return its ID immediately (for background use).
   * If the concurrency limit is reached, the agent is queued.
   */
  spawn(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: SpawnOptions,
  ): string {
    // Validate before the queue branch — a queued spawn should fail at the
    // call, not minutes later at drain. Throw (not warn): programmatic callers
    // can fix and retry; the RPC layer converts throws into error envelopes.
    assertValidSpawnCwd(options.cwd);

    // Enforce the repository capability below every caller boundary. Tool calls
    // are schema-gated too, but agent files, schedules, and RPC can bypass that
    // schema. `off` and disabled worktrees both become ordinary real-tree runs.
    const isolation = options.isolation === "worktree" && isWorktreeIsolationEnabled()
      ? "worktree"
      : undefined;
    options = {
      ...options,
      isolation,
      ...(options.invocation
        ? { invocation: { ...options.invocation, isolation } }
        : {}),
    };

    const id = randomUUID().slice(0, 17);
    const abortController = new AbortController();
    const record: AgentRecord = {
      id,
      type,
      description: options.description,
      status: options.isBackground ? "queued" : "running",
      toolUses: 0,
      startedAt: Date.now(),
      abortController,
      runGeneration: 1,
      lifetimeUsage: createLifetimeUsage(),
      compactionCount: 0,
      completionDelivery: options.completionDelivery ?? "followUp",
      // Raw tri-state (not coerced to a boolean): true = background, false =
      // foreground (has an inline tool-result surface), undefined = caller never
      // declared it (e.g. a cross-extension RPC spawn). The widget's background-
      // only filter excludes only explicit `false`, so undefined agents — which
      // have no inline surface — stay visible instead of vanishing.
      isBackground: options.isBackground,
      invocation: options.invocation ?? {
        modelName: shortModelLabel(options.model),
        thinking: options.thinkingLevel,
        maxTurns: options.maxTurns,
        isolated: options.isolated,
        inheritContext: options.inheritContext,
        runInBackground: options.isBackground,
        isolation: options.isolation,
      },
      ...(options.inlineAgentConfig ? {
        inlineDisplayName: options.inlineAgentConfig.displayName ?? options.inlineAgentConfig.name,
        inlinePromptMode: options.inlineAgentConfig.promptMode,
      } : {}),
      ...(options.correlationId ? { correlationId: options.correlationId } : {}),
      ...(options.completionOwner ? { completionOwner: options.completionOwner } : {}),
      ...(options.correlationId && options.model ? {
        requestedModel: { provider: options.model.provider, modelId: options.model.id },
      } : {}),
      ...(options.correlationId && options.thinkingLevel ? {
        requestedThinkingLevel: options.thinkingLevel,
      } : {}),
    };
    this.createSettlement(id);
    this.agents.set(id, record);

    const args: SpawnArgs = { pi, ctx, type, prompt, options };
    try {
      this.options.onAccepted?.(record);
    } catch (err) {
      this.settleExecution(id);
      this.agents.delete(id);
      this.settlements.delete(id);
      throw err;
    }

    if (options.isBackground && !options.bypassQueue && this.runningBackground >= this.maxConcurrent) {
      // Queue it — will be started when a running agent completes
      this.queue.push({ id, start: () => this.startAgent(id, record, args) });
      return id;
    }

    // startAgent can throw (e.g. strict worktree-isolation failure) — clean
    // up the record so callers don't see an orphan in `listAgents()`.
    try {
      this.startAgent(id, record, args);
    } catch (err) {
      this.settleExecution(id);
      this.agents.delete(id);
      this.settlements.delete(id);
      throw err;
    }
    return id;
  }

  /** Actually start an agent (called immediately or from queue drain). */
  private startAgent(id: string, record: AgentRecord, { pi, ctx, type, prompt, options }: SpawnArgs) {
    // Re-validate a caller-supplied cwd: queued spawns can start minutes after
    // spawn()'s check, and the directory may be gone by then (TOCTOU). Same
    // curated errors; drainQueue parks a throw on the record as an error.
    assertValidSpawnCwd(options.cwd);
    // Single resolution point for the caller-supplied cwd — the worktree base
    // repo and both cleanup calls below MUST agree on this value forever.
    const customCwd = options.cwd ?? undefined; // null (RPC "unset") → undefined
    const baseCwd = customCwd ?? ctx.cwd;

    // Worktree isolation: try to create a temporary git worktree. Strict —
    // fail loud if not possible (no silent fallback to main tree). Done
    // BEFORE state mutation so a throw doesn't leave the record half-running.
    let worktreeCwd: string | undefined;
    const useWorktree = options.isolation === "worktree" && isWorktreeIsolationEnabled();
    // The setting can turn off while a background spawn is queued. Keep the UI
    // snapshot honest if that accepted request is downgraded at queue drain.
    if (!useWorktree && record.invocation?.isolation) {
      record.invocation = { ...record.invocation, isolation: undefined };
    }
    if (useWorktree) {
      const wt = createWorktree(baseCwd, id);
      if (!wt) {
        throw new Error(
          'Cannot run with isolation: "worktree" — not a git repo, no commits yet, or `git worktree add` failed. ' +
          'Initialize git and commit at least once, or omit `isolation`.',
        );
      }
      record.worktree = wt;
      // workPath preserves subdirectory scoping for caller-supplied cwds: a
      // cwd deep in a monorepo maps to the same subdir inside the copy, not
      // the copied repo's root. Plain worktree spawns keep the historical
      // behavior (agent at the copy's root) — moving them to workPath would
      // also move .pi config discovery when the parent session sits in a repo
      // subdirectory, silently dropping extensions/skills.
      worktreeCwd = customCwd !== undefined ? wt.workPath : wt.path;
      this.worktreeRepos.add(baseCwd);
    }

    this.execute(record, options, () => runAgent(ctx, type, prompt, {
      pi,
      agentId: id,
      model: options.model,
      maxTurns: options.maxTurns,
      ...(options.graceTurns !== undefined ? { graceTurns: options.graceTurns } : {}),
      isolated: options.isolated,
      inheritContext: options.inheritContext,
      thinkingLevel: options.thinkingLevel,
      ...(options.inlineAgentConfig ? { inlineAgentConfig: options.inlineAgentConfig } : {}),
      // Worktree wins for the working dir (the agent must run in the copy —
      // which, with a custom cwd, was created from that target). Config stays
      // with the parent project when a caller-supplied cwd is in play; it must
      // stay undefined otherwise so plain worktree runs keep resolving config
      // (incl. relative extension paths and memory) inside the worktree copy.
      cwd: worktreeCwd ?? customCwd,
      configCwd: customCwd !== undefined ? ctx.cwd : undefined,
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onResumeSnapshot: (snapshot) => { record.resumeSnapshot = snapshot; },
      onTurnEnd: options.onTurnEnd,
      onTextDelta: options.onTextDelta,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
      onSessionCreated: (session) => {
        record.session = session;
        record.sessionFile = session.sessionManager?.getSessionFile?.();
        this.readEffectiveInvocation(record, session, ctx.model);
        // Flush any steers that arrived before the session was ready
        if (record.pendingSteers?.length) {
          const messages = record.pendingSteers;
          record.pendingSteers = undefined;
          for (const msg of messages) void this.queueSteer(record, msg).catch(() => {});
        }
        options.onSessionCreated?.(session);
      },
    }), () => {
      if (!record.worktree) return;
      const wtResult = cleanupWorktree(baseCwd, record.worktree, options.description);
      record.worktreeResult = wtResult;
      if (wtResult.hasChanges && wtResult.branch) {
        const repoNote = customCwd !== undefined ? ` in \`${baseCwd}\`` : "";
        record.result = (record.result ?? "") +
          `\n\n---\nChanges saved to branch \`${wtResult.branch}\`${repoNote}. Merge with: \`git merge ${wtResult.branch}\`${customCwd !== undefined ? ` (run in \`${baseCwd}\`)` : ""}`;
      }
    });

    // Notify caller that spawn is complete (record is in the map, promise is set).
    // Called synchronously — onSessionCreated fires asynchronously inside runAgent.
    // Used by spawnAndWait to let the caller set up output files before streaming starts.
    this.onSpawned?.(id);
  }

  /** Session creation may choose another model or clamp unsupported thinking. */
  private readEffectiveInvocation(record: AgentRecord, session: AgentSession, parentModel?: Model<any>): void {
    const model = session.model;
    const previousIdentity = record.invocation?.modelIdentity;
    const modelIdentity = model ? { provider: model.provider, modelId: model.id } : undefined;
    const samePreviousModel = !!(model && previousIdentity &&
      model.provider === previousIdentity.provider && model.id === previousIdentity.modelId);
    const modelInherited = parentModel
      ? !!(model && model.provider === parentModel.provider && model.id === parentModel.id)
      : samePreviousModel && record.invocation?.modelInherited;
    record.effectiveModel = modelIdentity;
    record.effectiveThinkingLevel = session.thinkingLevel;
    record.invocation = {
      ...record.invocation,
      modelIdentity,
      modelName: shortModelLabel(model),
      modelInherited: modelInherited || undefined,
      thinking: session.thinkingLevel,
    };
  }

  /** One execution/settlement owner for first runs, continuations and disk restores. */
  private execute(
    record: AgentRecord,
    options: Partial<SpawnOptions>,
    run: () => ReturnType<typeof runAgent>,
    cleanup?: () => void,
  ): void {
    const id = record.id;
    record.status = "running";
    record.startedAt = Date.now();
    if (options.isBackground) this.runningBackground++;
    this.onStart?.(record);
    const onAbort = () => this.abort(id);
    if (options.signal?.aborted) onAbort();
    else options.signal?.addEventListener("abort", onAbort, { once: true });

    record.promise = (async () => {
      let finalResult = "";
      try {
        let outcome = await run();
        while (true) {
          record.session = outcome.session;
          record.result = outcome.responseText;
          // Steer acceptance and completion share this barrier. SDK steer queues
          // synchronously but may finish after the model loop's final idle check.
          await this.awaitSteering(id);
          const deliveryError = this.steeringErrors.get(id);
          this.steeringErrors.delete(id);
          if (deliveryError) throw new Error(`Follow-up delivery failed: ${deliveryError}`);
          if (record.status === "stopped") break;
          if (outcome.aborted || outcome.failure) {
            record.status = outcome.aborted ? "aborted" : "error";
            record.error = outcome.failure;
            break;
          }
          const session = record.session;
          const queued = session.getSteeringMessages?.() ?? [];
          const followUps = session.getFollowUpMessages?.() ?? [];
          const pending = record.pendingSteers ?? [];
          if (queued.length + followUps.length + pending.length === 0) {
            record.status = outcome.steered ? "steered" : "completed";
            break;
          }
          // Only successful runs may automatically continue. Drain the SDK's
          // stranded queue once, including its expanded text, without replaying
          // messages already consumed by the model.
          session.clearQueue?.();
          record.pendingSteers = undefined;
          const next = await this.runContinuation(record, [...queued, ...followUps, ...pending].join("\n\n"), options);
          outcome = { ...next, session };
        }
      } catch (err) {
        if (record.status !== "stopped") record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
      } finally {
        // Rejection may bypass the normal completion barrier. Stop can also
        // race asynchronous steer preflight, which may enqueue after abort's
        // first clearQueue. Fence all deliveries before allowing any retry.
        if (record.status === "stopped" || record.status === "error" || record.status === "aborted") {
          await this.awaitSteering(id);
          record.pendingSteers = undefined;
          record.session?.clearQueue?.();
          this.steeringErrors.delete(id);
        }
        options.signal?.removeEventListener("abort", onAbort);
        record.completedAt ??= Date.now();
        try { record.outputCleanup?.(); } catch { /* best effort transcript flush */ }
        record.outputCleanup = undefined;
        try { cleanup?.(); } catch (err) {
          if (record.status !== "stopped") record.status = "error";
          record.error = err instanceof Error ? err.message : String(err);
        }
        if (!options.isBackground) record.resultConsumed = true;
        if (options.isBackground) this.runningBackground--;
        // Settle before callbacks: callbacks may submit a new execution for this
        // same id. No old finalizer is allowed to settle the new generation.
        finalResult = record.result ?? "";
        this.settleExecution(id);
        try { this.onComplete?.(record); } catch { /* completion side effect */ }
        this.drainQueue();
      }
      return finalResult;
    })();
  }

  private async runContinuation(record: AgentRecord, prompt: string, options: Partial<SpawnOptions> = {}) {
    const { text, failure, aborted, steered } = await resumeAgent(record.session!, prompt, {
      maxTurns: record.resumeSnapshot?.maxTurns ?? record.invocation?.maxTurns,
      graceTurns: record.resumeSnapshot?.graceTurns,
      signal: record.abortController!.signal,
      onToolActivity: (activity) => {
        if (activity.type === "end") record.toolUses++;
        options.onToolActivity?.(activity);
      },
      onTextDelta: options.onTextDelta,
      onTurnEnd: options.onTurnEnd,
      onAssistantUsage: (usage) => {
        addUsage(record.lifetimeUsage, usage);
        options.onAssistantUsage?.(usage);
      },
      onCompaction: (info) => {
        record.compactionCount++;
        this.onCompact?.(record, info);
        options.onCompaction?.(info);
      },
    });
    return { responseText: text, failure, aborted: aborted ?? false, steered: steered ?? false };
  }

  private async awaitSteering(id: string): Promise<void> {
    while (this.steering.get(id)?.size) {
      await Promise.allSettled([...this.steering.get(id)!]);
    }
  }

  private queueSteer(record: AgentRecord, message: string): Promise<void> {
    const pending = this.steering.get(record.id) ?? new Set<Promise<void>>();
    this.steering.set(record.id, pending);
    const delivery = record.session!.steer(message);
    pending.add(delivery);
    void delivery.then(() => pending.delete(delivery), (err) => {
      pending.delete(delivery);
      this.steeringErrors.set(record.id, err instanceof Error ? err.message : String(err));
    });
    return delivery;
  }

  /** Start queued agents up to the concurrency limit. */
  private drainQueue() {
    while (this.queue.length > 0 && this.runningBackground < this.maxConcurrent) {
      const next = this.queue.shift()!;
      const record = this.agents.get(next.id);
      if (!record || record.status !== "queued") continue;
      try {
        next.start();
      } catch (err) {
        // Late failure (e.g. strict worktree-isolation) — surface on the record
        // so the user/agent can see it via /agents, then keep draining.
        record.status = "error";
        record.error = err instanceof Error ? err.message : String(err);
        record.completedAt = Date.now();
        try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
        this.settleExecution(next.id);
      }
    }
  }

  /**
   * Called synchronously right after spawn, before onSessionCreated fires.
   * Lets the caller set up the output file path on the record.
   * The record is guaranteed to be in this.agents at this point.
   */
  private onSpawned?: (id: string) => void;

  /**
   * Spawn an agent and wait for completion (foreground use).
   * Foreground agents bypass the concurrency queue.
   * Returns { id, record } so callers can access the agent ID.
   *
   * @param onSpawned - Called synchronously after spawn(), before onSessionCreated fires.
   *   Use this to set record.outputFile so streamToOutputFile can pick it up.
   */
  async spawnAndWait(
    pi: ExtensionAPI,
    ctx: ExtensionContext,
    type: SubagentType,
    prompt: string,
    options: Omit<SpawnOptions, "isBackground">,
    onSpawned?: (id: string) => void,
  ): Promise<{ id: string; record: AgentRecord }> {
    // Temporarily register the onSpawned hook so startAgent can call it.
    const prevOnSpawned = this.onSpawned;
    this.onSpawned = onSpawned;
    try {
      const id = this.spawn(pi, ctx, type, prompt, { ...options, isBackground: false });
      const record = this.agents.get(id)!;
      await record.promise;
      return { id, record };
    } finally {
      this.onSpawned = prevOnSpawned;
    }
  }

  /** Restore only metadata here. Runnable reconstruction is owned by execute(). */
  getRecordOrArchive(id: string, ctx: ExtensionContext): AgentRecord | undefined {
    const live = this.agents.get(id);
    if (live) return live;
    const archive = listArchivedAgents(ctx.sessionManager).find((item) => item.id === id);
    if (!archive) return undefined;
    const record = recordFromArchive(archive);
    this.agents.set(id, record);
    return record;
  }

  /** Explicit resume authorizes retry of failed, aborted and explicitly stopped runs. */
  async resume(
    id: string,
    prompt: string,
    signal?: AbortSignal,
    options: Pick<SpawnOptions, "isBackground" | "onSessionCreated" | "onToolActivity" | "onTextDelta" | "onTurnEnd" | "onAssistantUsage" | "onCompaction"> & { pi?: ExtensionAPI; ctx?: ExtensionContext } = {},
  ): Promise<AgentRecord | undefined> {
    const record = options.ctx ? this.getRecordOrArchive(id, options.ctx) : this.agents.get(id);
    if (!record) return undefined;
    if (record.status === "running" || record.status === "queued" || !this.isExecutionSettled(id)) {
      throw new Error(`Agent "${id}" is still active. Use steer_subagent to send a follow-up.`);
    }
    if (!record.session && (!record.sessionFile || !record.resumeSnapshot || !options.pi || !options.ctx)) {
      throw new Error(`Cannot restore agent "${id}": runnable session or saved recovery configuration is unavailable. No new session was created.`);
    }
    if (record.resumeSnapshot) assertValidSpawnCwd(record.resumeSnapshot.cwd);
    signal?.throwIfAborted();
    const generation = (record.runGeneration ?? 1) + 1;
    this.options.onAccepted?.({ ...record, status: "queued", runGeneration: generation });
    if ((record.status === "completed" || record.status === "steered") && record.result?.trim()) {
      record.previousResult = record.result;
    }
    record.runGeneration = generation;
    this.steeringErrors.delete(id);
    record.isBackground = options.isBackground ?? false;
    record.invocation = record.invocation ? { ...record.invocation, runInBackground: record.isBackground } : undefined;
    record.resultConsumed = false;
    record.completedAt = undefined;
    record.result = undefined;
    record.error = undefined;
    record.abortController = new AbortController();
    record.groupId = undefined;
    record.joinMode = "async";
    record.status = "queued";
    record.promise = undefined;
    this.createSettlement(id);
    const start = () => this.execute(record, { ...options, isBackground: record.isBackground, signal }, async () => {
      // Queue admission and resource construction are separate cancellation points.
      if (record.resumeSnapshot) assertValidSpawnCwd(record.resumeSnapshot.cwd);
      if (!record.session) {
        record.session = await restoreAgentSession(options.ctx!, record.sessionFile!, record.resumeSnapshot!, { pi: options.pi! });
      }
      this.readEffectiveInvocation(record, record.session);
      options.onSessionCreated?.(record.session);
      return { ...await this.runContinuation(record, prompt, options), session: record.session };
    });
    if (record.isBackground && this.runningBackground >= this.maxConcurrent) this.queue.push({ id, start });
    else start();
    if (!record.isBackground) await this.settlements.get(id)!.promise;
    return record;
  }

  /** Single state-aware follow-up entrance for tools and UI. */
  async sendMessage(
    id: string,
    message: string,
    options: { pi?: ExtensionAPI; ctx?: ExtensionContext } = {},
  ): Promise<"steered" | "queued" | "resumed"> {
    const record = options.ctx ? this.getRecordOrArchive(id, options.ctx) : this.agents.get(id);
    if (!record) throw new Error(`Agent not found: "${id}".`);
    if (record.status === "completed" || record.status === "steered") {
      await this.resume(id, message, undefined, { ...options, isBackground: true });
      return "resumed";
    }
    if (record.status !== "running" && record.status !== "queued") {
      throw new Error(`Agent "${id}" is ${record.status}. Use Agent with resume to explicitly retry; follow-ups do not restart failed or stopped work.`);
    }
    if (!record.session || record.status === "queued" || record.session.isStreaming === false) {
      (record.pendingSteers ??= []).push(message);
      return "queued";
    }
    await this.queueSteer(record, message);
    return "steered";
  }

  /** Compatibility adapter for synchronous UI composers; all routing stays above. */
  steer(id: string, message: string): boolean {
    const record = this.agents.get(id);
    if (!record || !["running", "queued", "completed", "steered"].includes(record.status)) return false;
    void this.sendMessage(id, message).catch((err) => {
      this.steeringErrors.set(id, err instanceof Error ? err.message : String(err));
    });
    return true;
  }

  /** Wait for a stable terminal result, including reentrant completion follow-ups. */
  async waitForResult(id: string): Promise<AgentRecord | undefined> {
    while (true) {
      const record = this.agents.get(id);
      if (!record) return undefined;
      const settlement = this.settlements.get(id);
      if (!settlement || settlement.settled) return record;
      await settlement.promise;
      // The completion callback may have synchronously admitted another run.
      // Inspect the current settlement, not the promise captured before await.
    }
  }

  isResultReady(id: string): boolean {
    const record = this.agents.get(id);
    return !!record && record.status !== "running" && record.status !== "queued" && this.isExecutionSettled(id);
  }

  getRecord(id: string): AgentRecord | undefined {
    return this.agents.get(id);
  }

  listAgents(): AgentRecord[] {
    return [...this.agents.values()].sort(
      (a, b) => b.startedAt - a.startedAt,
    );
  }

  abort(id: string): boolean {
    const record = this.agents.get(id);
    if (!record) return false;

    // Explicit stop discards pending follow-ups; a later explicit retry gets
    // only its newly supplied instructions, never a pre-stop queue.
    if (record.status === "queued" || record.status === "running") {
      record.pendingSteers = undefined;
      record.session?.clearQueue?.();
      this.steeringErrors.delete(id);
    }
    // Remove from queue if queued
    if (record.status === "queued") {
      this.queue = this.queue.filter(q => q.id !== id);
      record.status = "stopped";
      record.completedAt = Date.now();
      // Caller-owned orchestration waits on terminal lifecycle events even for
      // work that was cancelled before it started. Preserve the historical
      // no-completion-callback behavior for ordinary queued agents.
      this.settleExecution(id);
      if (record.completionOwner === "caller" || (record.runGeneration ?? 1) > 1) {
        try { this.onComplete?.(record); } catch { /* ignore completion side-effect errors */ }
      }
      return true;
    }

    if (record.status !== "running") return false;
    record.abortController?.abort();
    record.status = "stopped";
    record.completedAt = Date.now();
    return true;
  }

  /** Abort an agent and wait until its execution promise has actually settled. */
  async abortAndWait(id: string): Promise<boolean> {
    const settlement = this.settlements.get(id);
    if (!settlement || !this.abort(id)) return false;
    await settlement.promise;
    return true;
  }

  /** Dispose a record's session and remove it from the map. */
  private removeRecord(id: string, record: AgentRecord): void {
    record.session?.dispose?.();
    record.session = undefined;
    this.agents.delete(id);
    this.settlements.delete(id);
    this.steering.delete(id);
    this.steeringErrors.delete(id);
  }

  private cleanup() {
    const cutoff = Date.now() - 10 * 60_000;
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (!this.isExecutionSettled(id)) continue;
      if ((record.completedAt ?? 0) >= cutoff) continue;
      this.removeRecord(id, record);
    }
  }

  /**
   * Remove all completed/stopped/errored records immediately.
   * Called on session start/switch so tasks from a prior session don't persist.
   * Pass skipUnconsumed=true to preserve records the LLM hasn't read yet
   * (resultConsumed=false) — they will be evicted by the 10-minute cleanup timer instead.
   */
  clearCompleted(skipUnconsumed = false): void {
    for (const [id, record] of this.agents) {
      if (record.status === "running" || record.status === "queued") continue;
      if (!this.isExecutionSettled(id)) continue;
      if (skipUnconsumed && !record.resultConsumed) continue;
      this.removeRecord(id, record);
    }
  }

  /** Whether any agents are still running or queued. */
  hasRunning(): boolean {
    return [...this.agents.values()].some(
      r => r.status === "running" || r.status === "queued",
    );
  }

  /** Abort all running and queued agents immediately. */
  abortAll(): number {
    // Snapshot ids: callbacks may mutate records; queued work must stop first.
    const ids = [...this.queue.map((item) => item.id),
      ...[...this.agents.values()].filter((record) => record.status === "running").map((record) => record.id)];
    let count = 0;
    for (const id of ids) if (this.abort(id)) count++;
    return count;
  }

  /** Wait for every execution to settle, including records already marked stopped. */
  async waitForAll(): Promise<void> {
    while (true) {
      this.drainQueue();
      const pending = [...this.settlements.values()]
        .filter((settlement) => !settlement.settled)
        .map((settlement) => settlement.promise);
      if (pending.length === 0) return;
      await Promise.allSettled(pending);
    }
  }

  dispose() {
    clearInterval(this.cleanupInterval);
    // Clear queue
    this.queue = [];
    for (const record of this.agents.values()) {
      record.session?.dispose();
      // A queued record has no execution promise; a running/stopped record is
      // settled only by its real promise callbacks, even after the map clears.
      if (record.status === "queued") this.settleExecution(record.id);
    }
    this.agents.clear();
    if (this.options.pruneWorktreesOnDispose !== false) {
      // Prune any orphaned git worktrees (crash recovery).
      try { pruneWorktrees(process.cwd()); } catch { /* ignore */ }
      // Also prune repos that caller-supplied cwds created worktrees in — a clean
      // exit with in-flight agents would otherwise leave stale registrations there.
      for (const repo of this.worktreeRepos) {
        try { pruneWorktrees(repo); } catch { /* ignore */ }
      }
    }
  }
}
