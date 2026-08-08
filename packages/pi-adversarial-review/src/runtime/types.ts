import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export interface ReviewRuntimeCapabilities {
  protocolVersion: 3;
  maxConcurrent: number;
}

export interface SpawnReviewAgentInput {
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
