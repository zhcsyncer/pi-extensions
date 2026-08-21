import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "./agent-manager.js";
import {
  buildAgentEventData,
  buildCorrelatedEventData,
} from "./runtime-events.js";
import { archiveAgentRecord } from "./session-archive.js";
import type { AgentRecord, InlineAgentConfig, ThinkingLevel } from "./types.js";

export interface CallerOwnedRuntimeCapabilities {
  maxConcurrent: number;
}

export interface CallerOwnedSpawnInput {
  type: string;
  prompt: string;
  description: string;
  model: Model<any>;
  thinkingLevel: ThinkingLevel;
  maxTurns: number;
  graceTurns?: number;
  cwd: string;
  isolated: boolean;
  inheritContext: boolean;
  inlineAgentConfig: InlineAgentConfig;
  correlationId: string;
}

export interface CallerOwnedStartedEvent {
  id: string;
  type: string;
  description: string;
  correlationId: string;
  requestedModel?: { provider: string; modelId: string };
  requestedThinkingLevel?: ThinkingLevel;
  effectiveModel?: { provider: string; modelId: string };
  effectiveThinkingLevel?: ThinkingLevel;
}

export interface CallerOwnedTerminalEvent extends CallerOwnedStartedEvent {
  status: AgentRecord["status"];
  result?: string;
  error?: string;
  durationMs: number;
  tokens?: { input: number; output: number; total: number };
  /** Persisted Pi child session path when inlineAgentConfig.persistSession is true. */
  sessionFile?: string;
}

export interface CallerOwnedAgentRuntimeOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  maxConcurrent?: number;
}

type StartedHandler = (event: CallerOwnedStartedEvent) => void;
type TerminalHandler = (event: CallerOwnedTerminalEvent) => void;

/**
 * Runtime-only facade over the canonical AgentManager/runAgent execution path.
 *
 * Importing this module does not invoke the Subagents extension factory and does
 * not register Agent tools, commands, schedulers, widgets, or FleetView. A
 * caller must explicitly construct the runtime, and must dispose it when its
 * orchestration run ends.
 */
export class CallerOwnedAgentRuntime {
  private readonly manager: AgentManager;
  private readonly startedHandlers = new Set<StartedHandler>();
  private readonly terminalHandlers = new Set<TerminalHandler>();
  private disposed = false;

  constructor(private readonly options: CallerOwnedAgentRuntimeOptions) {
    this.manager = new AgentManager(
      (record) => {
        const event = buildAgentEventData(record);
        if (!event.correlationId) return;
        const archive = archiveAgentRecord(record);
        if (archive) {
          try {
            this.options.pi.appendEntry("subagents:record", {
              ...archive,
              ...buildCorrelatedEventData(record),
            });
          } catch {
            // The caller still receives terminal truth and the child session
            // remains directly openable from its runtime-owned session path.
          }
        }
        this.emit(this.terminalHandlers, event as CallerOwnedTerminalEvent);
      },
      options.maxConcurrent,
      (record) => {
        const correlated = buildCorrelatedEventData(record);
        if (!correlated.correlationId) return;
        this.emit(this.startedHandlers, {
          id: record.id,
          type: record.type,
          description: record.description,
          ...correlated,
        } as CallerOwnedStartedEvent);
      },
      undefined,
      { pruneWorktreesOnDispose: false },
    );
  }

  private emit<T>(handlers: ReadonlySet<(event: T) => void>, event: T): void {
    for (const handler of handlers) {
      try {
        handler(event);
      } catch {
        // Observers must never change manager lifecycle or queue draining.
      }
    }
  }

  getCapabilities(): CallerOwnedRuntimeCapabilities {
    return { maxConcurrent: this.manager.getMaxConcurrent() };
  }

  spawn(input: CallerOwnedSpawnInput): { id: string } {
    if (this.disposed) throw new Error("Caller-owned subagent runtime is disposed.");
    if (!input.correlationId.trim()) throw new Error("correlationId must be a non-empty string");
    const id = this.manager.spawn(
      this.options.pi,
      this.options.ctx,
      input.type,
      input.prompt,
      {
        description: input.description,
        model: input.model,
        thinkingLevel: input.thinkingLevel,
        maxTurns: input.maxTurns,
        ...(input.graceTurns !== undefined ? { graceTurns: input.graceTurns } : {}),
        cwd: input.cwd,
        isolated: input.isolated,
        inheritContext: input.inheritContext,
        inlineAgentConfig: input.inlineAgentConfig,
        correlationId: input.correlationId,
        completionOwner: "caller",
        isBackground: true,
      },
    );
    return { id };
  }

  async abort(id: string): Promise<void> {
    if (!await this.manager.abortAndWait(id)) throw new Error("Agent not found");
  }

  onStarted(handler: StartedHandler): () => void {
    this.startedHandlers.add(handler);
    return () => this.startedHandlers.delete(handler);
  }

  onTerminal(handler: TerminalHandler): () => void {
    this.terminalHandlers.add(handler);
    return () => this.terminalHandlers.delete(handler);
  }

  async dispose(): Promise<void> {
    if (this.disposed) return;
    this.disposed = true;
    const active = this.manager.listAgents().filter((record) => (
      record.status === "queued" || record.status === "running"
    ));
    for (const record of active) this.manager.abort(record.id);
    await this.manager.waitForAll();
    this.manager.dispose();
    this.startedHandlers.clear();
    this.terminalHandlers.clear();
  }
}
