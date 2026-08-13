import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ReviewerRouteStatus } from "../types.ts";

export type ReviewRuntimeBackend = "external-v3" | "embedded";

export interface ReviewRuntimeCapabilities {
  protocolVersion: 3;
  maxConcurrent: number;
  backend: ReviewRuntimeBackend;
  fallbackReason?: "unavailable" | "incompatible";
}

export type ReviewerFleetItemProgress =
  | {
      kind: "reviewer";
      routeKey: string;
      status: ReviewerRouteStatus;
      verdict?: "needs-attention" | "approve";
      findingCount?: number;
    }
  | {
      kind: "refuter";
      routeKey: string;
      status: ReviewerRouteStatus;
      findingIndex: number;
      refuted?: boolean;
    };

export interface ReviewerFleetProgress {
  phase: "review" | "refute";
  total: number;
  queued: number;
  running: number;
  finished: number;
  /** Deterministic display snapshot; never includes raw model output or errors. */
  items: ReviewerFleetItemProgress[];
}

export interface SpawnReviewAgentInput {
  role: "reviewer" | "refuter";
  prompt: string;
  systemPrompt: string;
  cwd: string;
  model: Model<any>;
  thinking: ModelThinkingLevel;
  maxTurns: number;
  correlationId: string;
  description: string;
}

export interface ReviewAgentStartedEvent {
  agentId: string;
  correlationId: string;
}

export interface ReviewAgentTerminalEvent {
  agentId: string;
  correlationId: string;
  status: string;
  result?: string;
  error?: string;
  durationMs?: number;
  usage?: { input?: number; output?: number; total?: number };
  requestedModel?: { provider: string; modelId: string };
  requestedThinking?: ModelThinkingLevel;
  effectiveModel?: { provider: string; modelId: string };
  effectiveThinking?: ModelThinkingLevel;
}

export interface ReviewSubagentRuntime {
  getCapabilities(): Promise<ReviewRuntimeCapabilities>;
  spawn(input: SpawnReviewAgentInput): Promise<{ agentId: string }>;
  stop(agentId: string): Promise<void>;
  onStarted(handler: (event: ReviewAgentStartedEvent) => void): () => void;
  onTerminal(handler: (event: ReviewAgentTerminalEvent) => void): () => void;
}
