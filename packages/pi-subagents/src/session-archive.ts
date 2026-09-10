import { readFileSync } from "node:fs";
import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentInvocation, AgentRecord, AgentResumeSnapshot } from "./types.js";
import { toLifetimeUsage, type LifetimeUsage } from "./usage.js";

const TERMINAL_STATUSES = new Set<AgentRecord["status"]>([
  "completed",
  "steered",
  "aborted",
  "stopped",
  "error",
]);

/** Durable subset stored on the parent session for `/agents` history. */
export interface ArchivedAgentRecord extends Pick<AgentRecord,
  "correlationId" | "requestedModel" | "requestedThinkingLevel" | "effectiveModel" | "effectiveThinkingLevel"
> {
  id: string;
  type: string;
  description: string;
  status: AgentRecord["status"];
  result?: string;
  previousResult?: string;
  error?: string;
  toolUses: number;
  startedAt: number;
  completedAt?: number;
  sessionFile: string;
  lifetimeUsage: LifetimeUsage;
  compactionCount: number;
  invocation?: AgentInvocation;
  inlineDisplayName?: string;
  inlinePromptMode?: "replace" | "append";
  isBackground?: boolean;
  resumeSnapshot?: AgentResumeSnapshot;
  runGeneration?: number;
  completionOwner?: AgentRecord["completionOwner"];
  completionDelivery?: AgentRecord["completionDelivery"];
}

/** Serialize the fields needed to reopen a finished conversation later. */
export function archiveAgentRecord(record: AgentRecord): ArchivedAgentRecord | undefined {
  if (!record.sessionFile || !TERMINAL_STATUSES.has(record.status)) return undefined;
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    status: record.status,
    result: record.result,
    previousResult: record.previousResult,
    error: record.error,
    toolUses: record.toolUses,
    startedAt: record.startedAt,
    completedAt: record.completedAt,
    sessionFile: record.sessionFile,
    lifetimeUsage: { ...record.lifetimeUsage },
    compactionCount: record.compactionCount,
    invocation: record.invocation ? { ...record.invocation } : undefined,
    inlineDisplayName: record.inlineDisplayName,
    inlinePromptMode: record.inlinePromptMode,
    isBackground: record.isBackground,
    resumeSnapshot: record.resumeSnapshot,
    runGeneration: record.runGeneration,
    completionOwner: record.completionOwner,
    completionDelivery: record.completionDelivery,
    correlationId: record.correlationId,
    requestedModel: record.requestedModel,
    requestedThinkingLevel: record.requestedThinkingLevel,
    effectiveModel: record.effectiveModel,
    effectiveThinkingLevel: record.effectiveThinkingLevel,
  };
}

function parseArchive(value: unknown): ArchivedAgentRecord | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const data = value as Record<string, unknown>;
  if (
    typeof data.id !== "string"
    || typeof data.type !== "string"
    || typeof data.description !== "string"
    || typeof data.status !== "string"
    || !TERMINAL_STATUSES.has(data.status as AgentRecord["status"])
    || typeof data.sessionFile !== "string"
    || data.sessionFile.length === 0
  ) {
    return undefined;
  }

  return {
    id: data.id,
    type: data.type,
    description: data.description,
    status: data.status as AgentRecord["status"],
    result: typeof data.result === "string" ? data.result : undefined,
    previousResult: typeof data.previousResult === "string" ? data.previousResult : undefined,
    error: typeof data.error === "string" ? data.error : undefined,
    toolUses: typeof data.toolUses === "number" ? data.toolUses : 0,
    startedAt: typeof data.startedAt === "number" ? data.startedAt : 0,
    completedAt: typeof data.completedAt === "number" ? data.completedAt : undefined,
    sessionFile: data.sessionFile,
    lifetimeUsage: toLifetimeUsage(data.lifetimeUsage),
    compactionCount: typeof data.compactionCount === "number" ? data.compactionCount : 0,
    invocation: data.invocation && typeof data.invocation === "object"
      ? data.invocation as AgentInvocation
      : undefined,
    inlineDisplayName: typeof data.inlineDisplayName === "string" ? data.inlineDisplayName : undefined,
    inlinePromptMode: data.inlinePromptMode === "replace" || data.inlinePromptMode === "append"
      ? data.inlinePromptMode
      : undefined,
    isBackground: typeof data.isBackground === "boolean" ? data.isBackground : undefined,
    resumeSnapshot: data.resumeSnapshot as AgentResumeSnapshot | undefined,
    runGeneration: typeof data.runGeneration === "number" ? data.runGeneration : undefined,
    completionOwner: data.completionOwner === "caller" ? "caller" : "runtime",
    completionDelivery: data.completionDelivery === "steer" ? "steer" : "followUp",
    correlationId: typeof data.correlationId === "string" ? data.correlationId : undefined,
    requestedModel: data.requestedModel as AgentRecord["requestedModel"],
    requestedThinkingLevel: data.requestedThinkingLevel as AgentRecord["requestedThinkingLevel"],
    effectiveModel: data.effectiveModel as AgentRecord["effectiveModel"],
    effectiveThinkingLevel: data.effectiveThinkingLevel as AgentRecord["effectiveThinkingLevel"],
  };
}

/**
 * Finished persisted agents attached to the current parent-session branch.
 * Repeated completions from resume replace the earlier snapshot for that id.
 */
export function listArchivedAgents(
  sessionManager: { getBranch(): readonly unknown[] },
): ArchivedAgentRecord[] {
  const byId = new Map<string, ArchivedAgentRecord>();
  for (const value of sessionManager.getBranch()) {
    if (!value || typeof value !== "object") continue;
    const entry = value as { type?: unknown; customType?: unknown; data?: unknown };
    if (entry.type !== "custom") continue;
    if (entry.customType === "subagents:active") {
      const id = (entry.data as { id?: unknown } | undefined)?.id;
      if (typeof id === "string") byId.delete(id);
      continue;
    }
    if (entry.customType !== "subagents:record") continue;
    const archive = parseArchive(entry.data);
    if (archive) byId.set(archive.id, archive);
  }
  return [...byId.values()].sort(
    (a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt),
  );
}

/** Open a persisted child session as the read-only shape ConversationViewer uses. */
export function openArchivedAgent(archive: ArchivedAgentRecord, reportOnly = false): AgentRecord {
  let sessionManager: SessionManager | undefined;
  if (!reportOnly) {
    // SessionManager.open may create an empty session for missing/broken files.
    // Viewing history must be read-only and report damage, not fabricate history.
    const lines = readFileSync(archive.sessionFile, "utf8").trim().split("\n");
    const entries = lines.map((line) => JSON.parse(line));
    if (entries[0]?.type !== "session" || typeof entries[0]?.id !== "string") {
      throw new Error(`Invalid archived session: ${archive.sessionFile}`);
    }
    sessionManager = SessionManager.open(archive.sessionFile);
  }

  // ConversationViewer needs only messages, subscribe, and session stats. A
  // disk archive is immutable while open, so subscribe is intentionally inert.
  const session = {
    // Explicit report-only viewing never constructs a runnable/new Pi session.
    messages: sessionManager?.buildSessionContext().messages ?? [],
    sessionManager,
    subscribe: () => () => {},
    getSessionStats: () => ({
      tokens: {
        input: archive.lifetimeUsage.input,
        output: archive.lifetimeUsage.output,
        cacheRead: archive.lifetimeUsage.cacheRead,
        cacheWrite: archive.lifetimeUsage.cacheWrite,
      },
      contextUsage: { percent: null },
    }),
    dispose: () => {},
  } as unknown as AgentSession;

  return { ...recordFromArchive(archive), session };
}

/** Hydrate metadata only; a viewer facade must never enter the runnable manager. */
export function recordFromArchive(archive: ArchivedAgentRecord): AgentRecord {
  return {
    id: archive.id,
    type: archive.type,
    description: archive.description,
    status: archive.status,
    result: archive.result,
    previousResult: archive.previousResult,
    error: archive.error,
    toolUses: archive.toolUses,
    startedAt: archive.startedAt,
    completedAt: archive.completedAt,
    sessionFile: archive.sessionFile,
    completionDelivery: archive.completionDelivery ?? "followUp",
    completionOwner: archive.completionOwner,
    runGeneration: archive.runGeneration,
    resumeSnapshot: archive.resumeSnapshot,
    correlationId: archive.correlationId,
    requestedModel: archive.requestedModel,
    requestedThinkingLevel: archive.requestedThinkingLevel,
    effectiveModel: archive.effectiveModel,
    effectiveThinkingLevel: archive.effectiveThinkingLevel,
    lifetimeUsage: { ...archive.lifetimeUsage },
    compactionCount: archive.compactionCount,
    invocation: archive.invocation,
    inlineDisplayName: archive.inlineDisplayName,
    inlinePromptMode: archive.inlinePromptMode,
    isBackground: archive.isBackground,
  };
}
