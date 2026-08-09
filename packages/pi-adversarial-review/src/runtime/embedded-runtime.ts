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
  loadRuntime?: () => Promise<{
    CallerOwnedAgentRuntime: new (options: {
      pi: ExtensionAPI;
      ctx: ExtensionContext;
      maxConcurrent?: number;
    }) => CallerOwnedRuntimeLike;
  }>;
}

export class EmbeddedReviewRuntime implements ReviewSubagentRuntime {
  constructor(private readonly runtime: CallerOwnedRuntimeLike) {}

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
      cwd: input.cwd,
      isolated: true,
      inheritContext: false,
      inlineAgentConfig: definition.inlineAgentConfig,
      correlationId: input.correlationId,
    });
    return { agentId: id };
  }

  async stop(agentId: string): Promise<void> {
    await this.runtime.abort(agentId);
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

  dispose(): Promise<void> {
    return this.runtime.dispose();
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
  return new EmbeddedReviewRuntime(runtime);
}
