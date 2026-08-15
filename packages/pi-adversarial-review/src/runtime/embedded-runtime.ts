import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import type {
  CallerOwnedAgentRuntime,
  CallerOwnedStartedEvent,
  CallerOwnedTerminalEvent,
} from "@zhcsyncer/pi-subagents/runtime";
import { buildReviewInlineAgentConfig } from "./review-agent-config.ts";
import type {
  ReviewAgentStartedEvent,
  ReviewAgentTerminalEvent,
  ReviewRuntimeCapabilities,
  ReviewSubagentRuntime,
  SpawnReviewAgentInput,
} from "./types.ts";

export const DEFAULT_EMBEDDED_TERMINAL_DEADLINE_MS = 30_000;

interface CallerOwnedRuntimeLike {
  getCapabilities(): { maxConcurrent: number };
  spawn(input: Parameters<CallerOwnedAgentRuntime["spawn"]>[0]): { id: string };
  abort(id: string): Promise<void>;
  onStarted(handler: (event: CallerOwnedStartedEvent) => void): () => void;
  onTerminal(handler: (event: CallerOwnedTerminalEvent) => void): () => void;
  dispose(): Promise<void>;
}

export interface EmbeddedReviewRuntimeOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  maxConcurrent?: number;
  terminalDeadlineMs?: number;
  loadRuntime?: () => Promise<{
    CallerOwnedAgentRuntime: new (options: {
      pi: ExtensionAPI;
      ctx: ExtensionContext;
      maxConcurrent?: number;
    }) => CallerOwnedRuntimeLike;
  }>;
}

export class EmbeddedReviewRuntime implements ReviewSubagentRuntime {
  private readonly terminalDeadlineMs: number;
  private readonly activeAgentIds = new Set<string>();
  private readonly unsettledStopIds = new Set<string>();
  private readonly pendingStops = new Map<string, Promise<void>>();
  private readonly terminalBeforeSpawn = new Set<string>();
  private readonly removeTrackingTerminalListener: () => void;
  private disposalPromise?: Promise<void>;

  constructor(
    private readonly runtime: CallerOwnedRuntimeLike,
    options: { terminalDeadlineMs?: number } = {},
  ) {
    this.terminalDeadlineMs = options.terminalDeadlineMs ??
      DEFAULT_EMBEDDED_TERMINAL_DEADLINE_MS;
    if (!Number.isFinite(this.terminalDeadlineMs) || this.terminalDeadlineMs <= 0) {
      throw new Error("Embedded review terminal deadline must be positive.");
    }
    this.removeTrackingTerminalListener = this.runtime.onTerminal((event) => {
      if (!this.activeAgentIds.delete(event.id)) this.terminalBeforeSpawn.add(event.id);
      this.unsettledStopIds.delete(event.id);
    });
  }

  private async beforeDeadline<T>(promise: Promise<T>, timeoutMessage: () => string): Promise<T> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const deadline = new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error(timeoutMessage())), this.terminalDeadlineMs);
      timer.unref?.();
    });
    try {
      return await Promise.race([promise, deadline]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }

  getUnsettledAgentIds(): string[] {
    return [...new Set([...this.activeAgentIds, ...this.unsettledStopIds])]
      .sort((left, right) => left.localeCompare(right, "en"));
  }

  async getCapabilities(): Promise<ReviewRuntimeCapabilities> {
    const capabilities = this.runtime.getCapabilities();
    if (!Number.isInteger(capabilities.maxConcurrent) || capabilities.maxConcurrent < 1) {
      throw new Error("Embedded subagent runtime returned an invalid concurrency limit.");
    }
    return {
      protocolVersion: 3,
      maxConcurrent: capabilities.maxConcurrent,
      backend: "embedded",
    };
  }

  async spawn(input: SpawnReviewAgentInput): Promise<{ agentId: string }> {
    const definition = buildReviewInlineAgentConfig(input);
    const { id } = this.runtime.spawn({
      type: definition.type,
      prompt: input.prompt,
      description: input.description,
      model: input.model,
      thinkingLevel: input.thinking,
      maxTurns: input.maxTurns,
      ...(input.graceTurns !== undefined ? { graceTurns: input.graceTurns } : {}),
      cwd: input.cwd,
      isolated: true,
      inheritContext: false,
      inlineAgentConfig: definition.inlineAgentConfig,
      correlationId: input.correlationId,
    });
    if (this.terminalBeforeSpawn.delete(id)) {
      this.activeAgentIds.delete(id);
    } else {
      this.activeAgentIds.add(id);
    }
    return { agentId: id };
  }

  async stop(agentId: string): Promise<void> {
    let pending = this.pendingStops.get(agentId);
    if (!pending) {
      this.unsettledStopIds.add(agentId);
      pending = Promise.resolve().then(() => this.runtime.abort(agentId)).then(() => {
        this.activeAgentIds.delete(agentId);
        this.unsettledStopIds.delete(agentId);
      });
      this.pendingStops.set(agentId, pending);
      void pending.then(
        () => { this.pendingStops.delete(agentId); },
        () => { this.pendingStops.delete(agentId); },
      );
      // The deadline may reject first. Keep a rejection handler attached until
      // the caller-owned terminal-truth promise eventually settles.
      void pending.catch(() => {});
    }
    await this.beforeDeadline(
      pending,
      () => `Embedded review agent ${agentId} did not reach terminal state within ` +
        `${this.terminalDeadlineMs}ms after stop.`,
    );
  }

  onStarted(handler: (event: ReviewAgentStartedEvent) => void): () => void {
    return this.runtime.onStarted((event) => {
      handler({ agentId: event.id, correlationId: event.correlationId });
    });
  }

  onTerminal(handler: (event: ReviewAgentTerminalEvent) => void): () => void {
    return this.runtime.onTerminal((event) => {
      handler({
        agentId: event.id,
        correlationId: event.correlationId,
        status: event.status,
        ...(event.result !== undefined ? { result: event.result } : {}),
        ...(event.error !== undefined ? { error: event.error } : {}),
        durationMs: event.durationMs,
        ...(event.tokens ? { usage: event.tokens } : {}),
        ...(event.requestedModel ? { requestedModel: event.requestedModel } : {}),
        ...(event.requestedThinkingLevel
          ? { requestedThinking: event.requestedThinkingLevel }
          : {}),
        ...(event.effectiveModel ? { effectiveModel: event.effectiveModel } : {}),
        ...(event.effectiveThinkingLevel
          ? { effectiveThinking: event.effectiveThinkingLevel }
          : {}),
      });
    });
  }

  async dispose(): Promise<void> {
    if (!this.disposalPromise) {
      this.disposalPromise = Promise.resolve().then(() => this.runtime.dispose()).then(() => {
        this.activeAgentIds.clear();
        this.unsettledStopIds.clear();
        this.removeTrackingTerminalListener();
      });
      // A deadline must not leave a later underlying rejection unhandled.
      void this.disposalPromise.catch(() => {});
    }
    await this.beforeDeadline(this.disposalPromise, () => {
      const ids = this.getUnsettledAgentIds();
      return `Embedded review runtime did not reach terminal state within ` +
        `${this.terminalDeadlineMs}ms during dispose` +
        `${ids.length > 0 ? `; unsettled agents: ${ids.join(", ")}` : ""}.`;
    });
  }
}

export async function createEmbeddedReviewRuntime(
  options: EmbeddedReviewRuntimeOptions,
): Promise<EmbeddedReviewRuntime> {
  const module = await (options.loadRuntime?.() ?? import("@zhcsyncer/pi-subagents/runtime"));
  const runtime = new module.CallerOwnedAgentRuntime({
    pi: options.pi,
    ctx: options.ctx,
    ...(options.maxConcurrent !== undefined ? { maxConcurrent: options.maxConcurrent } : {}),
  });
  return new EmbeddedReviewRuntime(runtime, {
    ...(options.terminalDeadlineMs !== undefined
      ? { terminalDeadlineMs: options.terminalDeadlineMs }
      : {}),
  });
}
