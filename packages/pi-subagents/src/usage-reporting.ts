import type { Usage } from "@earendil-works/pi-ai";
import type { MessageEndEvent, ToolResultEvent } from "@earendil-works/pi-coding-agent";
import type { AgentRecord } from "./types.js";
import { createLifetimeUsage, toLifetimeUsage, toReportedUsage, usageWatermark, type LifetimeUsage } from "./usage.js";

/** Persist inside the actual parent toolResult.details alongside native usage. */
export type SubagentUsageRollup = {
  version: 1;
  agentId: string;
  cumulative: LifetimeUsage;
  /** Native usage returned by this claim, not the lifetime watermark. */
  reportedUsage?: Pick<Usage, keyof Usage>;
};

type ParentSession = {
  getBranch(): readonly unknown[];
  getSessionId?(): string;
  getLeafId?(): string | null;
  getEntries?(): readonly unknown[];
};

const components = ["input", "output", "cacheRead", "cacheWrite"] as const;

function object(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown> : undefined;
}

function receipts(message: Record<string, unknown> | undefined): SubagentUsageRollup[] {
  if (message?.role !== "toolResult" || !object(message.usage)) return [];
  const details = object(message.details);
  const candidates = message.toolName === "Agent" || message.toolName === "get_subagent_result"
    ? [details?.subagentUsageRollup]
    : Array.isArray(details?.subagentUsageRollups) ? details.subagentUsageRollups : [];
  return candidates.filter((value): value is SubagentUsageRollup => {
    const marker = object(value);
    return marker?.version === 1 && typeof marker.agentId === "string" && !!object(marker.cumulative);
  });
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
  private entryCount = 0;
  private nested = new Map<string, SubagentUsageRollup[]>();

  /** Nested results are not transcript entries. Carry receipts, never their usage. */
  observeToolResult(event: ToolResultEvent): void {
    const children = this.nested.get(event.toolCallId) ?? [];
    if (!event.parentToolCallId) return;
    this.nested.delete(event.toolCallId);
    const own = receipts({ ...event, role: "toolResult" });
    if (children.length || own.length) {
      const parent = this.nested.get(event.parentToolCallId) ?? [];
      this.nested.set(event.parentToolCallId, [...parent, ...children, ...own]);
    }
  }

  /** SDK has now aggregated nested usage; persist receipts in that same message. */
  finalizeMessage(event: MessageEndEvent): { message: MessageEndEvent["message"] } | undefined {
    const message = event.message;
    if (message.role !== "toolResult") return;
    const markers = this.nested.get(message.toolCallId);
    this.nested.delete(message.toolCallId);
    if (!markers?.length || !message.usage) return;
    return { message: { ...message, details: { ...object(message.details), subagentUsageRollups: markers } } };
  }

  clearPending(): void { this.nested.clear(); }

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
    const entries = sessionManager.getEntries?.();
    if (entries && !replaced && !switchedBranch) {
      // A claim may have been persisted and then branched away BEFORE the next
      // query. Its original leaf is still an ancestor, so leaf-only detection
      // cannot see that navigation. Retire reservations whose receipts landed
      // off-branch; only active-branch receipts rebuild confirmed watermarks.
      const branchIds = new Set(branch.map((entry) => object(entry)?.id));
      for (const entry of entries.slice(this.entryCount)) {
        const node = object(entry);
        if (node?.type !== "message" || branchIds.has(node.id)) continue;
        for (const marker of receipts(object(node.message))) this.claimed.delete(marker.agentId);
      }
    }
    this.entryCount = entries?.length ?? 0;
    this.parent = sessionManager;
    this.sessionId = sessionId;
    this.leafId = leafId;

    let previous = this.claimed.get(record.id) ?? createLifetimeUsage();
    for (const entry of branch) {
      const node = object(entry);
      if (node?.type !== "message") continue;
      for (const marker of receipts(object(node.message))) {
        if (marker.agentId === record.id) previous = usageWatermark(previous, toLifetimeUsage(marker.cumulative));
      }
    }

    const cumulative = usageWatermark(previous, toLifetimeUsage(record.lifetimeUsage));
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
    return { usage, subagentUsageRollup: { version: 1, agentId: record.id, cumulative, reportedUsage: structuredClone(usage) } };
  }
}
