import type { Usage } from "@earendil-works/pi-ai";
import type { AgentRecord } from "./types.js";
import { createLifetimeUsage, toLifetimeUsage, toReportedUsage, type LifetimeUsage } from "./usage.js";

/** Persist inside the actual parent toolResult.details alongside native usage. */
export interface SubagentUsageRollup {
  version: 1;
  agentId: string;
  cumulative: LifetimeUsage;
}

type ParentSession = {
  getBranch(): readonly unknown[];
  getSessionId?(): string;
  getLeafId?(): string | null;
};

const components = ["input", "output", "cacheRead", "cacheWrite"] as const;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

/** Component-wise maxima fence stale archive snapshots and regressing counters. */
function watermark(a: LifetimeUsage, b: LifetimeUsage): LifetimeUsage {
  const result = createLifetimeUsage();
  for (const key of components) result[key] = Math.max(a[key], b[key]);
  if (a.cost !== undefined || b.cost !== undefined) result.cost = Math.max(a.cost ?? 0, b.cost ?? 0);
  if (a.costBreakdown || b.costBreakdown) {
    result.costBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    for (const key of components) {
      result.costBreakdown[key] = Math.max(a.costBreakdown?.[key] ?? 0, b.costBreakdown?.[key] ?? 0);
    }
  }
  return result;
}

/**
 * Claims settled foreground Agent/get_subagent_result usage, never background
 * acknowledgments, running queries or steering. The caller owns that boundary.
 * Claims are synchronous: parallel getters reserve spend before either returns.
 * Persist the returned marker ONLY with the returned native tool-result usage.
 */
export class UsageReporter {
  private claimed = new Map<string, LifetimeUsage>();
  private parent: ParentSession | undefined;
  private sessionId: string | undefined;
  private leafId: string | null | undefined;

  claim(record: AgentRecord, sessionManager: ParentSession): {
    usage: Usage;
    subagentUsageRollup: SubagentUsageRollup;
  } | undefined {
    const branch = sessionManager.getBranch();
    const sessionId = sessionManager.getSessionId?.();
    const leafId = sessionManager.getLeafId?.()
      ?? (object(branch.at(-1))?.id as string | undefined);
    const replaced = sessionId !== undefined
      ? sessionId !== this.sessionId
      : sessionManager !== this.parent;
    // A moving leaf is normal. Losing the previous leaf from the ancestry is
    // tree navigation: memory claims from that abandoned path must not leak.
    const switchedBranch = this.leafId != null && this.leafId !== leafId
      && !branch.some((entry) => object(entry)?.id === this.leafId);
    if (replaced || switchedBranch) this.claimed.clear();
    this.parent = sessionManager;
    this.sessionId = sessionId;
    this.leafId = leafId;

    let previous = this.claimed.get(record.id) ?? createLifetimeUsage();
    for (const entry of branch) {
      const node = object(entry);
      if (node?.type !== "message") continue;
      const message = object(node.message);
      if (message?.role !== "toolResult" || !object(message.usage)
        || (message.toolName !== "Agent" && message.toolName !== "get_subagent_result")) continue;
      const marker = object(object(message.details)?.subagentUsageRollup);
      if (marker?.version !== 1 || marker.agentId !== record.id || !object(marker.cumulative)) continue;
      previous = watermark(previous, toLifetimeUsage(marker.cumulative));
    }

    const cumulative = watermark(previous, toLifetimeUsage(record.lifetimeUsage));
    const delta = createLifetimeUsage();
    for (const key of components) delta[key] = cumulative[key] - previous[key];
    if (cumulative.cost !== undefined) delta.cost = cumulative.cost - (previous.cost ?? 0);
    if (cumulative.costBreakdown) {
      delta.costBreakdown = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
      for (const key of components) {
        delta.costBreakdown[key] = cumulative.costBreakdown[key] - (previous.costBreakdown?.[key] ?? 0);
      }
    }
    // Store a separate snapshot so callers cannot mutate the reservation through details.
    this.claimed.set(record.id, toLifetimeUsage(cumulative));
    const usage = toReportedUsage(delta);
    if (usage.totalTokens === 0 && Object.values(usage.cost).every((part) => part === 0)) return undefined;
    return { usage, subagentUsageRollup: { version: 1, agentId: record.id, cumulative } };
  }
}
