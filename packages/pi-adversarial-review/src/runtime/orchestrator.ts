import type { FrozenReviewInput, ReviewerRoute, ReviewerRouteResult } from "../types.ts";
import { InvalidReviewOutputError, parseReviewReport } from "../reports/parse-review-report.ts";
import { truncateRawOutput } from "./raw-output.ts";
import type {
  ReviewAgentStartedEvent,
  ReviewAgentTerminalEvent,
  ReviewerFleetProgress,
  ReviewRuntimeCapabilities,
  ReviewSubagentRuntime,
} from "./types.ts";

export const DEFAULT_REVIEWER_ROUTE_TIMEOUT_MS = 10 * 60_000;
export const DEFAULT_REVIEWER_OVERALL_TIMEOUT_MS = 20 * 60_000;
export const LARGE_REVIEWER_ROUTE_TIMEOUT_MS = 20 * 60_000;
export const LARGE_REVIEWER_OVERALL_TIMEOUT_MS = 30 * 60_000;
export const DEFAULT_REVIEWER_MAX_TURNS = 25;
export const LARGE_REVIEWER_MAX_TURNS = 40;

export interface RunReviewerFleetOptions {
  runtime: ReviewSubagentRuntime;
  routes: ReviewerRoute[];
  frozenInput: FrozenReviewInput;
  reviewerSystemPrompt: string;
  signal?: AbortSignal;
  routeTimeoutMs?: number;
  overallTimeoutMs?: number;
  maxTurns?: number;
  capabilities?: ReviewRuntimeCapabilities;
  onProgress?: (progress: ReviewerFleetProgress) => void;
}

export interface ReviewerFleetResult {
  capabilities: ReviewRuntimeCapabilities;
  routeResults: ReviewerRouteResult[];
}

interface RouteState {
  correlationId: string;
  result: ReviewerRouteResult;
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

function identityMatches(
  actual: { provider: string; modelId: string } | undefined,
  route: ReviewerRoute,
): boolean {
  return actual?.provider === route.provider && actual.modelId === route.modelId;
}

function routeMismatch(event: ReviewAgentTerminalEvent, route: ReviewerRoute): string | undefined {
  if (!identityMatches(event.requestedModel, route) || event.requestedThinking !== route.thinking) {
    return `Runtime requested route does not match ${route.key}.`;
  }
  if (!identityMatches(event.effectiveModel, route) || event.effectiveThinking !== route.thinking) {
    return `Runtime effective route does not match ${route.key}.`;
  }
  return undefined;
}

function reviewerPrompt(frozenInput: FrozenReviewInput, route: ReviewerRoute): string {
  return [
    `Frozen input file: ${frozenInput.inputPath}`,
    `Review working directory: ${frozenInput.reviewerCwd}`,
    `Route: ${route.key}`,
    "Read the frozen input completely before reaching a verdict.",
    "Inspect repository files only when needed to verify concrete evidence.",
    "Return exactly one ReviewReport JSON object as your final response.",
  ].join("\n");
}

function validateTimeout(value: number, name: string): void {
  if (!Number.isFinite(value) || value <= 0) throw new Error(`${name} must be positive.`);
}

export async function runReviewerFleet(options: RunReviewerFleetOptions): Promise<ReviewerFleetResult> {
  const routeTimeoutMs = options.routeTimeoutMs ?? DEFAULT_REVIEWER_ROUTE_TIMEOUT_MS;
  const overallTimeoutMs = options.overallTimeoutMs ?? DEFAULT_REVIEWER_OVERALL_TIMEOUT_MS;
  const maxTurns = options.maxTurns ?? DEFAULT_REVIEWER_MAX_TURNS;
  validateTimeout(routeTimeoutMs, "routeTimeoutMs");
  validateTimeout(overallTimeoutMs, "overallTimeoutMs");
  if (!Number.isInteger(maxTurns) || maxTurns < 1) throw new Error("maxTurns must be a positive integer.");

  const capabilities = options.capabilities ?? await options.runtime.getCapabilities();
  const states = new Map<string, RouteState>();
  const stopPromises: Promise<void>[] = [];
  const stoppedAgentIds = new Set<string>();

  for (const route of options.routes) {
    let resolveDone!: () => void;
    const done = new Promise<void>((resolve) => { resolveDone = resolve; });
    const correlationId = `${options.frozenInput.runId}:reviewer:${route.ordinal}`;
    states.set(correlationId, {
      correlationId,
      result: { route, status: "queued" },
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
    const progress: ReviewerFleetProgress = {
      phase: "review",
      total: states.size,
      queued,
      running,
      finished: states.size - queued - running,
    };
    try {
      options.onProgress?.(progress);
    } catch {
      // UI observers must never change review lifecycle or gating.
    }
  };

  const settle = (
    state: RouteState,
    status: ReviewerRouteResult["status"],
    fields: Partial<ReviewerRouteResult> = {},
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

  const requestStopAgent = (state: RouteState, agentId: string) => {
    if (stoppedAgentIds.has(agentId)) return;
    stoppedAgentIds.add(agentId);
    const promise = options.runtime.stop(agentId).catch((error) => {
      const suffix = `stop failed for ${agentId}: ${errorText(error)}`;
      state.result.error = state.result.error ? `${state.result.error}; ${suffix}` : suffix;
    });
    stopPromises.push(promise);
  };

  const requestStop = (state: RouteState) => {
    state.stopNeeded = true;
    if (state.agentId) requestStopAgent(state, state.agentId);
  };

  const settleAgentMismatch = (
    state: RouteState,
    lifecycleAgentId: string,
    spawnAgentId: string,
  ) => {
    const message =
      `Lifecycle agent ${lifecycleAgentId} does not match spawn reply agent ${spawnAgentId}.`;
    if (!settle(state, "errored", { error: message, agentId: spawnAgentId })) {
      state.result = { ...state.result, status: "errored", error: message, agentId: spawnAgentId };
    }
    requestStopAgent(state, lifecycleAgentId);
    requestStopAgent(state, spawnAgentId);
  };

  const onStarted = (event: ReviewAgentStartedEvent) => {
    const state = states.get(event.correlationId);
    if (!state) return;
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
        if (settle(state, "timed-out", { error: `Reviewer exceeded ${routeTimeoutMs}ms.` })) {
          requestStop(state);
        }
      }, routeTimeoutMs);
    }
  };

  const processTerminal = (state: RouteState, event: ReviewAgentTerminalEvent) => {
    if (state.terminal) return;
    const common = {
      durationMs: event.durationMs,
      usage: event.usage,
      ...(event.status === "steered" ? { turnLimited: true } : {}),
      ...(event.result !== undefined ? { rawOutput: truncateRawOutput(event.result) } : {}),
    };
    if (event.status !== "completed" && event.status !== "steered") {
      settle(state, "errored", {
        ...common,
        error: event.error || `Reviewer terminated with status ${event.status}.`,
      });
      return;
    }

    const mismatch = routeMismatch(event, state.result.route);
    if (mismatch) {
      settle(state, "errored", { ...common, error: mismatch });
      return;
    }
    if (event.result === undefined) {
      settle(state, "invalid-output", { ...common, error: "Reviewer returned no final output." });
      return;
    }
    try {
      const report = parseReviewReport(event.result);
      settle(state, "completed", { ...common, report });
    } catch (error) {
      settle(state, "invalid-output", {
        ...common,
        error: error instanceof InvalidReviewOutputError ? error.message : errorText(error),
      });
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
      if (settle(state, status, { error: message })) {
        requestStop(state);
      }
    }
  };
  const onAbort = () => cancelAll("cancelled", "Adversarial review was cancelled.");
  options.signal?.addEventListener("abort", onAbort, { once: true });
  if (options.signal?.aborted) onAbort();

  const overallTimer = setTimeout(() => {
    cancelAll("timed-out", `Overall review exceeded ${overallTimeoutMs}ms.`);
  }, overallTimeoutMs);

  const dispatch = async (state: RouteState) => {
    if (state.terminal) return;
    const route = state.result.route;
    try {
      const { agentId } = await options.runtime.spawn({
        role: "reviewer",
        prompt: reviewerPrompt(options.frozenInput, route),
        systemPrompt: options.reviewerSystemPrompt,
        cwd: options.frozenInput.reviewerCwd,
        model: route.model,
        thinking: route.thinking,
        maxTurns,
        correlationId: state.correlationId,
        description: `Review ${route.key}`,
      });
      state.spawnAgentId = agentId;
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
        processTerminal(state, pendingTerminal);
        return;
      }
      if (settle(state, "errored", { error: `Spawn failed: ${errorText(error)}` })) {
        // A started event can race ahead of a failed/malformed spawn reply.
        // Stop the already-created agent instead of losing it with the listener cleanup.
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
        .sort((left, right) => left.route.ordinal - right.route.ordinal),
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
