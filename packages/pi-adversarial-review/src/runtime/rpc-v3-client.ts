import { randomUUID } from "node:crypto";
import { buildReviewInlineAgentConfig } from "./review-agent-config.ts";
import type {
  ReviewAgentStartedEvent,
  ReviewAgentTerminalEvent,
  ReviewRuntimeCapabilities,
  ReviewSubagentRuntime,
  SpawnReviewAgentInput,
} from "./types.ts";

const PROTOCOL_VERSION = 3;
const STOP_REQUEST_TIMEOUT_MS = 30_000;
const LATE_START_REAPER_MS = 20 * 60_000;

export interface PiEventBus {
  emit(event: string, data: unknown): void;
  on(event: string, handler: (data: any) => void): () => void;
}

interface RpcReply<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export type ReviewRuntimeErrorKind = "unavailable" | "incompatible" | "request";

export class ReviewRuntimeError extends Error {
  constructor(
    message: string,
    readonly kind: ReviewRuntimeErrorKind = "request",
  ) {
    super(message);
    this.name = "ReviewRuntimeError";
  }
}

export class PiSubagentRpcV3Client implements ReviewSubagentRuntime {
  private readonly lateStartReapers = new Map<string, () => void>();
  private readonly unsettledStops = new Set<string>();

  constructor(
    private readonly events: PiEventBus,
    private readonly requestTimeoutMs = 5_000,
  ) {}

  private request<T>(
    channel: string,
    payload: Record<string, unknown>,
    timeoutMs = this.requestTimeoutMs,
  ): Promise<T> {
    const requestId = randomUUID();
    return new Promise((resolve, reject) => {
      let settled = false;
      const finish = (action: () => void) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        unsubscribe();
        action();
      };
      const unsubscribe = this.events.on(`${channel}:reply:${requestId}`, (reply: RpcReply<T>) => {
        if (!reply || typeof reply !== "object") {
          finish(() => reject(new ReviewRuntimeError(`${channel} returned a malformed reply.`)));
        } else if (!reply.success) {
          finish(() => reject(new ReviewRuntimeError(reply.error || `${channel} failed.`)));
        } else {
          finish(() => resolve(reply.data as T));
        }
      });
      const timer = setTimeout(() => {
        finish(() => reject(new ReviewRuntimeError(`${channel} timed out.`)));
      }, timeoutMs);
      this.events.emit(channel, { ...payload, requestId });
    });
  }

  async getCapabilities(probeTimeoutMs?: number): Promise<ReviewRuntimeCapabilities> {
    let data: { version?: unknown; maxConcurrent?: unknown };
    try {
      data = await this.request<{ version?: unknown; maxConcurrent?: unknown }>(
        "subagents:rpc:ping",
        {},
        probeTimeoutMs,
      );
    } catch (error) {
      if (error instanceof ReviewRuntimeError && error.message === "subagents:rpc:ping timed out.") {
        throw new ReviewRuntimeError(error.message, "unavailable");
      }
      throw error;
    }
    if (
      data?.version !== PROTOCOL_VERSION ||
      !Number.isInteger(data.maxConcurrent) ||
      (data.maxConcurrent as number) < 1
    ) {
      throw new ReviewRuntimeError(
        `Incompatible subagent runtime. Expected protocol ${PROTOCOL_VERSION} with maxConcurrent >= 1.`,
        "incompatible",
      );
    }
    return {
      protocolVersion: PROTOCOL_VERSION,
      maxConcurrent: data.maxConcurrent as number,
      backend: "external-v3",
    };
  }

  private armLateStartReaper(correlationId: string): void {
    this.lateStartReapers.get(correlationId)?.();
    let timer: ReturnType<typeof setTimeout>;
    let offStarted = () => {};
    let offCompleted = () => {};
    let offFailed = () => {};
    const cleanup = () => {
      clearTimeout(timer);
      offStarted();
      offCompleted();
      offFailed();
      if (this.lateStartReapers.get(correlationId) === cleanup) {
        this.lateStartReapers.delete(correlationId);
      }
    };
    offStarted = this.events.on("subagents:started", (event: any) => {
      if (event?.correlationId !== correlationId || typeof event?.id !== "string") return;
      cleanup();
      void this.stop(event.id).catch(() => {
        // The original spawn already failed; best-effort reaping must not create
        // a second unhandled failure path.
      });
    });
    const onTerminal = (event: any) => {
      if (event?.correlationId === correlationId) cleanup();
    };
    offCompleted = this.events.on("subagents:completed", onTerminal);
    offFailed = this.events.on("subagents:failed", onTerminal);
    timer = setTimeout(cleanup, LATE_START_REAPER_MS);
    timer.unref?.();
    this.lateStartReapers.set(correlationId, cleanup);
  }

  async spawn(input: SpawnReviewAgentInput): Promise<{ agentId: string }> {
    const definition = buildReviewInlineAgentConfig(input);
    let data: { id?: unknown };
    try {
      data = await this.request<{ id?: unknown }>("subagents:rpc:spawn", {
        type: definition.type,
        prompt: input.prompt,
        options: {
          description: input.description,
          model: input.model,
          thinkingLevel: input.thinking,
          maxTurns: input.maxTurns,
          cwd: input.cwd,
          isolated: true,
          inheritContext: false,
          isBackground: true,
          inlineAgentConfig: definition.inlineAgentConfig,
          completionOwner: "caller",
          correlationId: input.correlationId,
        },
      });
    } catch (error) {
      // A lost/malformed reply may still have created a queued agent. Keep a
      // bounded correlation watcher so a later started event is stopped.
      this.armLateStartReaper(input.correlationId);
      throw error;
    }
    if (!data || typeof data.id !== "string" || !data.id) {
      this.armLateStartReaper(input.correlationId);
      throw new ReviewRuntimeError("subagents:rpc:spawn returned no agent id.");
    }
    return { agentId: data.id };
  }

  async stop(agentId: string): Promise<void> {
    this.unsettledStops.add(agentId);
    type StopOutcome =
      | { kind: "terminal" }
      | { kind: "reply" }
      | { kind: "request-error"; error: unknown }
      | { kind: "timeout" };

    let resolveTerminal!: (outcome: StopOutcome) => void;
    const terminal = new Promise<StopOutcome>((resolve) => { resolveTerminal = resolve; });
    const onTerminal = (event: any) => {
      if (event?.id === agentId) resolveTerminal({ kind: "terminal" });
    };
    const offCompleted = this.events.on("subagents:completed", onTerminal);
    const offFailed = this.events.on("subagents:failed", onTerminal);
    const request = this.request<void>(
      "subagents:rpc:stop",
      { agentId },
      STOP_REQUEST_TIMEOUT_MS,
    ).then<StopOutcome, StopOutcome>(
      () => ({ kind: "reply" }),
      (error) => ({ kind: "request-error", error }),
    );
    let timer!: ReturnType<typeof setTimeout>;
    const deadline = new Promise<StopOutcome>((resolve) => {
      timer = setTimeout(() => resolve({ kind: "timeout" }), STOP_REQUEST_TIMEOUT_MS);
      timer.unref?.();
    });

    try {
      const first = await Promise.race([terminal, request, deadline]);
      if (first.kind === "terminal") {
        this.unsettledStops.delete(agentId);
        return;
      }
      if (first.kind === "timeout") {
        throw new ReviewRuntimeError(`Agent ${agentId} did not reach terminal after stop.`);
      }

      // Protocol-v3 runtimes predating terminal-aware stop may ACK immediately.
      // Also tolerate shutdown removing the stop handler if abortAll still emits
      // this agent's terminal lifecycle event. In both cases terminal is truth.
      const final = await Promise.race([terminal, deadline]);
      if (final.kind === "terminal") {
        this.unsettledStops.delete(agentId);
        return;
      }
      if (first.kind === "request-error") throw first.error;
      throw new ReviewRuntimeError(`Agent ${agentId} did not reach terminal after stop.`);
    } finally {
      clearTimeout(timer);
      offCompleted();
      offFailed();
    }
  }

  assertNoUnsettledStops(): void {
    if (this.unsettledStops.size === 0 && this.lateStartReapers.size === 0) return;
    const details = [
      ...(this.unsettledStops.size > 0
        ? [`unconfirmed agents: ${[...this.unsettledStops].join(", ")}`]
        : []),
      ...(this.lateStartReapers.size > 0
        ? [`pending spawn correlations: ${[...this.lateStartReapers.keys()].join(", ")}`]
        : []),
    ];
    throw new ReviewRuntimeError(
      `Subagent termination was not confirmed (${details.join("; ")}).`,
    );
  }

  onStarted(handler: (event: ReviewAgentStartedEvent) => void): () => void {
    return this.events.on("subagents:started", (event: any) => {
      if (
        typeof event?.id !== "string" ||
        typeof event?.correlationId !== "string"
      ) return;
      handler({ agentId: event.id, correlationId: event.correlationId });
    });
  }

  onTerminal(handler: (event: ReviewAgentTerminalEvent) => void): () => void {
    const forward = (event: any) => {
      if (
        typeof event?.id !== "string" ||
        typeof event?.correlationId !== "string" ||
        typeof event?.status !== "string"
      ) return;
      handler({
        agentId: event.id,
        correlationId: event.correlationId,
        status: event.status,
        ...(typeof event.result === "string" ? { result: event.result } : {}),
        ...(typeof event.error === "string" ? { error: event.error } : {}),
        ...(typeof event.durationMs === "number" ? { durationMs: event.durationMs } : {}),
        ...(event.tokens && typeof event.tokens === "object" ? { usage: event.tokens } : {}),
        ...(event.requestedModel ? { requestedModel: event.requestedModel } : {}),
        ...(event.requestedThinkingLevel ? { requestedThinking: event.requestedThinkingLevel } : {}),
        ...(event.effectiveModel ? { effectiveModel: event.effectiveModel } : {}),
        ...(event.effectiveThinkingLevel ? { effectiveThinking: event.effectiveThinkingLevel } : {}),
      });
    };
    const offCompleted = this.events.on("subagents:completed", forward);
    const offFailed = this.events.on("subagents:failed", forward);
    return () => {
      offCompleted();
      offFailed();
    };
  }
}
