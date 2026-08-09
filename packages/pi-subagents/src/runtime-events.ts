import type { AgentRecord } from "./types.js";
import { getLifetimeTotal } from "./usage.js";

/** Serializable lifecycle fields shared by the extension RPC and embedded callers. */
export function buildCorrelatedEventData(record: AgentRecord) {
  if (!record.correlationId) return {};
  return {
    correlationId: record.correlationId,
    requestedModel: record.requestedModel,
    requestedThinkingLevel: record.requestedThinkingLevel,
    effectiveModel: record.effectiveModel,
    effectiveThinkingLevel: record.effectiveThinkingLevel,
  };
}

/** Build one terminal lifecycle payload from the manager's canonical record. */
export function buildAgentEventData(record: AgentRecord) {
  const durationMs = record.completedAt
    ? record.completedAt - record.startedAt
    : Date.now() - record.startedAt;
  const usage = record.lifetimeUsage;
  const total = getLifetimeTotal(usage);
  const tokens = total > 0
    ? { input: usage.input, output: usage.output, total }
    : undefined;
  return {
    id: record.id,
    type: record.type,
    description: record.description,
    result: record.result,
    error: record.error,
    status: record.status,
    toolUses: record.toolUses,
    durationMs,
    tokens,
    ...buildCorrelatedEventData(record),
  };
}

export function isAgentFailureStatus(status: AgentRecord["status"]): boolean {
  return status === "error" || status === "stopped" || status === "aborted";
}
