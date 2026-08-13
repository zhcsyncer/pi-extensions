import type {
  ReviewerRoute,
  ReviewerRouteStatus,
} from "../types.ts";
import { truncateRawOutput } from "./raw-output.ts";
import type {
  ReviewAgentStartedEvent,
  ReviewAgentTerminalEvent,
  ReviewerFleetItemProgress,
  ReviewerFleetProgress,
  ReviewRuntimeCapabilities,
  ReviewSubagentRuntime,
  SpawnReviewAgentInput,
} from "./types.ts";

export interface ManagedFleetResult {
  route: ReviewerRoute;
  status: ReviewerRouteStatus;
  agentId?: string;
  rawOutput?: string;
  error?: string;
  turnLimited?: boolean;
  durationMs?: number;
  usage?: { input?: number; output?: number; total?: number };
}

export interface ManagedFleetTask<TResult extends ManagedFleetResult> {
  correlationId: string;
  route: ReviewerRoute;
  initialResult: TResult;
  buildSpawnInput(maxTurns: number): SpawnReviewAgentInput;
  toProgressItem(result: TResult): ReviewerFleetItemProgress;
}

export interface RunManagedFleetOptions<TResult extends ManagedFleetResult> {
  runtime: ReviewSubagentRuntime;
  capabilities?: ReviewRuntimeCapabilities;
  tasks: readonly ManagedFleetTask<TResult>[];
  phase: ReviewerFleetProgress["phase"];
  actorLabel: "Reviewer" | "Refuter";
  signal?: AbortSignal;
  routeTimeoutMs: number;
  overallTimeoutMs: number;
  maxTurns: number;
  cancellationMessage: string;
  overallTimeoutMessage: string;
  onProgress?: (progress: ReviewerFleetProgress) => void;
  parseOutput(rawOutput: string, task: ManagedFleetTask<TResult>): Partial<TResult>;
  sortResults(left: TResult, right: TResult): number;
}

export interface ManagedFleetResultSet<TResult extends ManagedFleetResult> {
  capabilities: ReviewRuntimeCapabilities;
  routeResults: TResult[];
}

interface ManagedFleetState<TResult extends ManagedFleetResult> {
  task: ManagedFleetTask<TResult>;
  result: TResult;
  terminal: boolean;
  agentId?: string;
  spawnAgentId?: string;
  pendingTerminal?: ReviewAgentTerminalEvent;
  routeTimer?: ReturnType<typeof setTimeout>;
  resolveDone: () => void;
  done: Promise<void>;
  stopNeeded: boolean;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function validateTimeout(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
}

function identityMatches(
  actual: { provider: string; modelId: string } | undefined,
  route: ReviewerRoute,
): boolean {
  return actual?.provider === route.provider && actual.modelId === route.modelId;
}

function routeMismatch(
  event: ReviewAgentTerminalEvent,
  route: ReviewerRoute,
): string | undefined {
  if (!identityMatches(event.requestedModel, route) || event.requestedThinking !== route.thinking) {
    return `Runtime requested route does not match ${route.key}.`;
  }
  if (!identityMatches(event.effectiveModel, route) || event.effectiveThinking !== route.thinking) {
    return `Runtime effective route does not match ${route.key}.`;
  }
  return undefined;
}

/** Shared caller-owned lifecycle. Role adapters own prompts, parsing, metadata, and sorting. */
export async function runManagedFleet<TResult extends ManagedFleetResult>(
  options: RunManagedFleetOptions<TResult>,
): Promise<ManagedFleetResultSet<TResult>> {
  validateTimeout(options.routeTimeoutMs, "routeTimeoutMs");
  validateTimeout(options.overallTimeoutMs, "overallTimeoutMs");
  if (!Number.isInteger(options.maxTurns) || options.maxTurns < 1) {
    throw new Error("maxTurns must be a positive integer.");
  }

  const capabilities = options.capabilities ?? await options.runtime.getCapabilities();
  const states = new Map<string, ManagedFleetState<TResult>>();
  const stopPromises: Promise<void>[] = [];
  const stoppedAgentIds = new Set<string>();

  for (const task of options.tasks) {
    if (states.has(task.correlationId)) {
      throw new Error(`Duplicate fleet correlation id: ${task.correlationId}.`);
    }
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    states.set(task.correlationId, {
      task,
      result: task.initialResult,
      terminal: false,
      resolveDone,
      done,
      stopNeeded: false,
    });
  }

  const emitProgress = () => {
    let queued = 0;
    let running = 0;
    for (const state of states.values()) {
      if (state.result.status === "queued") queued++;
      else if (state.result.status === "running") running++;
    }
    try {
      options.onProgress?.({
        phase: options.phase,
        total: states.size,
        queued,
        running,
        finished: states.size - queued - running,
        items: [...states.values()].map((state) => state.task.toProgressItem(state.result)),
      });
    } catch {
      // UI observers must never change fleet lifecycle or review semantics.
    }
  };

  const settle = (
    state: ManagedFleetState<TResult>,
    status: ReviewerRouteStatus,
    fields: Partial<TResult> = {},
  ) => {
    if (state.terminal) return false;
    state.terminal = true;
    if (state.routeTimer) clearTimeout(state.routeTimer);
    state.result = { ...state.result, ...fields, status };
    emitProgress();
    state.resolveDone();
    return true;
  };

  emitProgress();

  const requestStopAgent = (state: ManagedFleetState<TResult>, agentId: string) => {
    if (stoppedAgentIds.has(agentId)) return;
    stoppedAgentIds.add(agentId);
    const promise = options.runtime.stop(agentId).catch((error) => {
      const suffix = `stop failed for ${agentId}: ${errorText(error)}`;
      state.result.error = state.result.error ? `${state.result.error}; ${suffix}` : suffix;
    });
    stopPromises.push(promise);
  };

  const requestStop = (state: ManagedFleetState<TResult>) => {
    state.stopNeeded = true;
    if (state.agentId) requestStopAgent(state, state.agentId);
  };

  const settleAgentMismatch = (
    state: ManagedFleetState<TResult>,
    lifecycleAgentId: string,
    spawnAgentId: string,
  ) => {
    const message =
      `Lifecycle agent ${lifecycleAgentId} does not match spawn reply agent ${spawnAgentId}.`;
    settle(state, "errored", { error: message, agentId: spawnAgentId } as Partial<TResult>);
    requestStopAgent(state, lifecycleAgentId);
    requestStopAgent(state, spawnAgentId);
  };

  const onStarted = (event: ReviewAgentStartedEvent) => {
    const state = states.get(event.correlationId);
    if (!state) return;
    if (state.terminal) {
      const canonicalAgentId = state.spawnAgentId ?? state.agentId;
      if (canonicalAgentId && canonicalAgentId !== event.agentId) {
        // A late or duplicate lifecycle event must never rewrite terminal truth.
        // Stop only the unexpected agent when the canonical identity is known.
        requestStopAgent(state, event.agentId);
      } else {
        state.agentId = event.agentId;
        state.result.agentId ??= event.agentId;
        if (state.stopNeeded) requestStop(state);
      }
      return;
    }
    if (state.spawnAgentId && state.spawnAgentId !== event.agentId) {
      settleAgentMismatch(state, event.agentId, state.spawnAgentId);
      return;
    }
    if (state.agentId && state.agentId !== event.agentId) {
      settleAgentMismatch(state, event.agentId, state.agentId);
      return;
    }
    state.agentId = event.agentId;
    state.result.agentId = event.agentId;
    if (state.terminal) {
      if (state.stopNeeded) requestStop(state);
      return;
    }
    state.result.status = "running";
    emitProgress();
    if (!state.routeTimer) {
      state.routeTimer = setTimeout(() => {
        if (settle(state, "timed-out", {
          error: `${options.actorLabel} exceeded ${options.routeTimeoutMs}ms.`,
        } as Partial<TResult>)) {
          requestStop(state);
        }
      }, options.routeTimeoutMs);
    }
  };

  const processTerminal = (
    state: ManagedFleetState<TResult>,
    event: ReviewAgentTerminalEvent,
  ) => {
    if (state.terminal) return;
    const common = {
      durationMs: event.durationMs,
      usage: event.usage,
      ...(event.status === "steered" ? { turnLimited: true } : {}),
      ...(event.result !== undefined ? { rawOutput: truncateRawOutput(event.result) } : {}),
    } as Partial<TResult>;
    if (event.status !== "completed" && event.status !== "steered") {
      settle(state, "errored", {
        ...common,
        error: event.error || `${options.actorLabel} terminated with status ${event.status}.`,
      });
      return;
    }

    const mismatch = routeMismatch(event, state.task.route);
    if (mismatch) {
      settle(state, "errored", { ...common, error: mismatch });
      return;
    }
    if (event.result === undefined) {
      settle(state, "invalid-output", {
        ...common,
        error: `${options.actorLabel} returned no final output.`,
      });
      return;
    }
    try {
      settle(state, "completed", {
        ...common,
        ...options.parseOutput(event.result, state.task),
      });
    } catch (error) {
      settle(state, "invalid-output", { ...common, error: errorText(error) });
    }
  };

  const onTerminal = (event: ReviewAgentTerminalEvent) => {
    const state = states.get(event.correlationId);
    if (!state || state.terminal) return;
    if (state.spawnAgentId && state.spawnAgentId !== event.agentId) {
      settleAgentMismatch(state, event.agentId, state.spawnAgentId);
      return;
    }
    if (state.agentId && state.agentId !== event.agentId) {
      settleAgentMismatch(state, event.agentId, state.agentId);
      return;
    }
    state.agentId = event.agentId;
    state.result.agentId = event.agentId;
    if (!state.spawnAgentId) {
      state.pendingTerminal ??= event;
      return;
    }
    processTerminal(state, event);
  };

  const offStarted = options.runtime.onStarted(onStarted);
  const offTerminal = options.runtime.onTerminal(onTerminal);
  const cancelAll = (status: "cancelled" | "timed-out", message: string) => {
    for (const state of states.values()) {
      if (settle(state, status, { error: message } as Partial<TResult>)) requestStop(state);
    }
  };
  const onAbort = () => cancelAll("cancelled", options.cancellationMessage);
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const overallTimer = setTimeout(() => {
    cancelAll("timed-out", options.overallTimeoutMessage);
  }, options.overallTimeoutMs);

  const dispatch = async (state: ManagedFleetState<TResult>) => {
    if (state.terminal) return;
    try {
      const { agentId } = await options.runtime.spawn(
        state.task.buildSpawnInput(options.maxTurns),
      );
      state.spawnAgentId = agentId;
      if (state.terminal) {
        state.pendingTerminal = undefined;
        if (state.agentId && state.agentId !== agentId) {
          // Cancellation/timeout can win before a malformed spawn reply. Keep
          // the terminal result and stop both possible agents without rewriting it.
          requestStopAgent(state, state.agentId);
          requestStopAgent(state, agentId);
        } else {
          state.agentId = agentId;
          state.result.agentId ??= agentId;
          if (state.stopNeeded) requestStop(state);
        }
        return;
      }
      if (state.agentId && state.agentId !== agentId) {
        settleAgentMismatch(state, state.agentId, agentId);
        return;
      }
      state.agentId = agentId;
      state.result.agentId = agentId;
      const pendingTerminal = state.pendingTerminal;
      state.pendingTerminal = undefined;
      if (pendingTerminal && !state.terminal) processTerminal(state, pendingTerminal);
      if (state.stopNeeded) requestStop(state);
    } catch (error) {
      const pendingTerminal = state.pendingTerminal;
      state.pendingTerminal = undefined;
      if (pendingTerminal && !state.terminal) {
        // A terminal event proves the correlated agent existed even when its
        // spawn reply was lost or malformed.
        processTerminal(state, pendingTerminal);
        return;
      }
      if (settle(state, "errored", {
        error: `Spawn failed: ${errorText(error)}`,
      } as Partial<TResult>)) {
        // A started event can race ahead of a failed/malformed spawn reply.
        requestStop(state);
      }
    }
  };

  try {
    await Promise.all([...states.values()].map(dispatch));
    await Promise.all([...states.values()].map((state) => state.done));
    await Promise.allSettled(stopPromises);
    return {
      capabilities,
      routeResults: [...states.values()]
        .map((state) => state.result)
        .sort(options.sortResults),
    };
  } finally {
    clearTimeout(overallTimer);
    for (const state of states.values()) {
      if (state.routeTimer) clearTimeout(state.routeTimer);
    }
    options.signal?.removeEventListener("abort", onAbort);
    offStarted();
    offTerminal();
  }
}
