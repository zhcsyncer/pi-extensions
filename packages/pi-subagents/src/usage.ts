/** usage.ts — Token usage: shapes, accumulator operators, session-stats readers. */

import type { Usage } from "@earendil-works/pi-ai";

type CostBreakdown = Pick<Usage["cost"], "input" | "output" | "cacheRead" | "cacheWrite">;
const components = ["input", "output", "cacheRead", "cacheWrite"] as const;

/**
 * Lifetime usage components, accumulated via assistant `message_end` events.
 * Survives compaction (which replaces session.state.messages and would reset
 * any stats-derived sum). `cacheRead` is retained for an honest breakdown, but
 * remains excluded from the legacy compact total returned by
 * `getLifetimeTotal()` — summing each call's cumulative cached prefix into that
 * total would reintroduce issue #38's inflated semantics.
 */
export type LifetimeUsage = {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** Accumulated provider-reported USD cost when a reliable value was present. */
  cost?: number;
  /** Provider-reported components only; absent for legacy aggregate-only cost. */
  costBreakdown?: CostBreakdown;
};

/** Fresh zeroed accumulator. Cost stays unavailable until a message reports it. */
export function createLifetimeUsage(): LifetimeUsage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function nonNegativeFinite(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : undefined;
}

function finiteSum(a: number, b: number): number {
  return Math.min(Number.MAX_VALUE, a + b);
}

function readCostBreakdown(value: unknown): CostBreakdown | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const cost = value as Record<string, unknown>;
  if (!components.some((key) => nonNegativeFinite(cost[key]) !== undefined)) return undefined;
  return {
    input: nonNegativeFinite(cost.input) ?? 0,
    output: nonNegativeFinite(cost.output) ?? 0,
    cacheRead: nonNegativeFinite(cost.cacheRead) ?? 0,
    cacheWrite: nonNegativeFinite(cost.cacheWrite) ?? 0,
  };
}

/** Read a reliable cost total, preferring `cost.total` over component sums. */
function readUsageCost(value: unknown): number | undefined {
  const direct = nonNegativeFinite(value);
  if (direct !== undefined) return direct;
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;

  const cost = value as Record<string, unknown>;
  const total = nonNegativeFinite(cost.total);
  if (total !== undefined) return total;

  const breakdown = readCostBreakdown(cost);
  return breakdown ? components.reduce((sum, key) => finiteSum(sum, breakdown[key]), 0) : undefined;
}

/** Normalize a Pi assistant-message usage object into one lifetime delta. */
export function toLifetimeUsage(value: unknown): LifetimeUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return createLifetimeUsage();
  }
  const usage = value as Record<string, unknown>;
  const cost = readUsageCost(usage.cost);
  const costBreakdown = readCostBreakdown(usage.cost) ?? readCostBreakdown(usage.costBreakdown);
  return {
    input: nonNegativeFinite(usage.input) ?? 0,
    output: nonNegativeFinite(usage.output) ?? 0,
    cacheRead: nonNegativeFinite(usage.cacheRead) ?? 0,
    cacheWrite: nonNegativeFinite(usage.cacheWrite) ?? 0,
    ...(cost !== undefined ? { cost } : {}),
    ...(costBreakdown !== undefined ? { costBreakdown } : {}),
  };
}

/** Native Pi usage includes cache reads in totalTokens, unlike the compact UI total. */
export function toReportedUsage(value: LifetimeUsage): Usage {
  const usage = toLifetimeUsage(value);
  return {
    input: usage.input,
    output: usage.output,
    cacheRead: usage.cacheRead,
    cacheWrite: usage.cacheWrite,
    totalTokens: components.reduce((sum, key) => finiteSum(sum, usage[key]), 0),
    cost: {
      input: usage.costBreakdown?.input ?? 0,
      output: usage.costBreakdown?.output ?? 0,
      cacheRead: usage.costBreakdown?.cacheRead ?? 0,
      cacheWrite: usage.costBreakdown?.cacheWrite ?? 0,
      total: usage.cost ?? 0,
    },
  };
}

/**
 * Legacy compact lifetime total used by existing terse surfaces.
 * Deliberately remains input + output + cacheWrite; cacheRead is available on
 * the breakdown but must not silently change this metric's issue #38 semantics.
 */
export function getLifetimeTotal(u?: LifetimeUsage): number {
  return u ? (u.input ?? 0) + (u.output ?? 0) + (u.cacheWrite ?? 0) : 0;
}

/** Add a usage delta into a target accumulator (mutates target). */
export function addUsage(into: LifetimeUsage, delta: LifetimeUsage): void {
  const normalized = toLifetimeUsage(delta);
  for (const key of components) {
    into[key] = finiteSum(nonNegativeFinite(into[key]) ?? 0, normalized[key]);
  }
  if (normalized.cost !== undefined) {
    into.cost = finiteSum(nonNegativeFinite(into.cost) ?? 0, normalized.cost);
  }
  if (normalized.costBreakdown) {
    const previous = readCostBreakdown(into.costBreakdown);
    into.costBreakdown = { ...normalized.costBreakdown };
    for (const key of components) {
      into.costBreakdown[key] = finiteSum(previous?.[key] ?? 0, normalized.costBreakdown[key]);
    }
  }
}

/** Minimal shape we read from upstream `getSessionStats()`. */
export type SessionStatsLike = {
  tokens: { input: number; output: number; cacheRead?: number; cacheWrite: number };
  contextUsage?: { percent: number | null };
};
export type SessionLike = { getSessionStats(): SessionStatsLike };

/**
 * Session-scoped token count: input + output + cacheWrite as reported by
 * upstream `getSessionStats().tokens` for the *current* session window.
 *
 * RESETS at compaction — upstream replaces `session.state.messages` and the
 * stats are derived from that array. For a lifetime total that survives
 * compaction, use `getLifetimeTotal(lifetimeUsage)` instead, which reads
 * from an independent accumulator fed by `message_end` events.
 *
 * Avoids upstream's `tokens.total` field, which sums per-turn `cacheRead`
 * and so counts the cumulative cached prefix N times across N turns
 * (issue #38).
 */
export function getSessionTokens(session: SessionLike | undefined): number {
  if (!session) return 0;
  try {
    const t = session.getSessionStats().tokens;
    return t.input + t.output + t.cacheWrite;
  } catch { return 0; }
}

/**
 * Context-window utilization (0–100), or null when unavailable
 * (no model contextWindow, or post-compaction before the next response).
 */
export function getSessionContextPercent(session: SessionLike | undefined): number | null {
  if (!session) return null;
  try { return session.getSessionStats().contextUsage?.percent ?? null; }
  catch { return null; }
}
