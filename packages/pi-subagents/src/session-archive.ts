import { SessionManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import type { AgentInvocation, AgentRecord } from "./types.js";
import { toLifetimeUsage, type LifetimeUsage } from "./usage.js";

const TERMINAL_STATUSES = new Set<AgentRecord["status"]>([
  "completed",
  "steered",
  "aborted",
  "stopped",
  "error",
]);

/** Durable subset stored on the parent session for `/agents` history. */
export interface ArchivedAgentRecord {
  id: string;
  type: string;
  description: string;
  status: AgentRecord["status"];
  result?: string;
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
    if (entry.type !== "custom" || entry.customType !== "subagents:record") continue;
    const archive = parseArchive(entry.data);
    if (archive) byId.set(archive.id, archive);
  }
  return [...byId.values()].sort(
    (a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt),
  );
}

/** Open a persisted child session as the read-only shape ConversationViewer uses. */
export function openArchivedAgent(archive: ArchivedAgentRecord): AgentRecord {
  const sessionManager = SessionManager.open(archive.sessionFile);
  const context = sessionManager.buildSessionContext();

  // ConversationViewer needs only messages, subscribe, and session stats. A
  // disk archive is immutable while open, so subscribe is intentionally inert.
  const session = {
    messages: context.messages,
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

  return {
    id: archive.id,
    type: archive.type,
    description: archive.description,
    status: archive.status,
    result: archive.result,
    error: archive.error,
    toolUses: archive.toolUses,
    startedAt: archive.startedAt,
    completedAt: archive.completedAt,
    session,
    sessionFile: archive.sessionFile,
    completionDelivery: "followUp",
    lifetimeUsage: { ...archive.lifetimeUsage },
    compactionCount: archive.compactionCount,
    invocation: archive.invocation,
    inlineDisplayName: archive.inlineDisplayName,
    inlinePromptMode: archive.inlinePromptMode,
    isBackground: archive.isBackground,
  };
}
