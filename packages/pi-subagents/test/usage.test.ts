import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
  addUsage,
  createLifetimeUsage,
  getLifetimeTotal,
  getSessionContextPercent,
  getSessionTokens,
  readSessionUsage,
  toLifetimeUsage,
  toReportedUsage,
} from "../src/usage.js";

describe("journal usage identity", () => {
  const spend = (cost: number) => toReportedUsage(toLifetimeUsage({ input: 1, cost }));

  it("counts explicit summary generation and arbitrary usage kinds, not summary snapshots", () => {
    const sm = SessionManager.inMemory();
    sm.appendMessage({ role: "user", content: "start", timestamp: 0 });
    sm.appendUsage("future-kind", "local", "model", spend(0.02));
    const leaf = sm.getLeafId()!;
    sm.appendCompaction("summarized $0.02", null, 100, { cumulativeCost: 0.02 });
    expect(readSessionUsage(sm).cost).toBe(0.02);
    sm.appendCompaction("summary", null, 100, undefined, false, spend(0.01));
    sm.branchWithSummary(leaf, "branch summary", undefined, false, spend(0.03));
    expect(readSessionUsage(sm).cost).toBeCloseTo(0.06);
    expect(readSessionUsage(sm).cost).toBeCloseTo(0.06);
    // The child lifetime records all actual work, not just the model's branch projection.
    sm.branch(leaf);
    expect(readSessionUsage(sm).cost).toBeCloseTo(0.06);
  });

  it("deduplicates imported entry IDs and separates a replacement session", () => {
    const sm = SessionManager.inMemory();
    const entry = sm.appendUsage("independent", "local", "model", spend(0.02));
    const imported = SessionManager.inMemory(sm.getCwd(), undefined,
      structuredClone([sm.getHeader()!, entry, entry]));
    expect(readSessionUsage(imported).cost).toBe(0.02);
    imported.appendUsage("independent", "local", "model", spend(0.01));
    expect(readSessionUsage(imported).cost).toBeCloseTo(0.03);
    imported.newSession();
    expect(readSessionUsage(imported).cost).toBeUndefined();
  });

  it("uses SDK-persisted migration IDs when reopening a legacy file", () => {
    const dir = mkdtempSync(join(tmpdir(), "usage-legacy-"));
    try {
      const file = join(dir, "legacy.jsonl");
      const timestamp = new Date().toISOString();
      writeFileSync(file, [
        { type: "session", version: 1, id: "legacy", cwd: dir, timestamp },
        { type: "message", timestamp, message: {
          role: "assistant", api: "local", provider: "local", model: "test", timestamp: 1,
          content: [{ type: "text", text: "done" }], stopReason: "stop", usage: spend(0.04),
        } },
      ].map((entry) => JSON.stringify(entry)).join("\n"));
      const first = SessionManager.open(file);
      const ids = first.getEntries().map((entry) => entry.id);
      const persisted = readFileSync(file, "utf8");
      expect(readSessionUsage(first).cost).toBe(0.04);
      const reopened = SessionManager.open(file);
      expect(reopened.getEntries().map((entry) => entry.id)).toEqual(ids);
      expect(readSessionUsage(reopened).cost).toBe(0.04);
      expect(readFileSync(file, "utf8")).toBe(persisted);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// Regression for issue #38 — token semantics + context indicator
describe("usage", () => {
  describe("getSessionTokens", () => {
    it("uses billed-token semantics (input + output + cacheWrite), not inflated total", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 100, output: 200, cacheRead: 500_000, cacheWrite: 50, total: 500_350 } as any,
          contextUsage: { tokens: 50_300, contextWindow: 200_000, percent: 25 },
        }),
      };
      expect(getSessionTokens(session)).toBe(350);
    });

    it("returns 0 when session is undefined or stats throw", () => {
      expect(getSessionTokens(undefined)).toBe(0);
      const broken = { getSessionStats: () => { throw new Error("nope"); } } as any;
      expect(getSessionTokens(broken)).toBe(0);
    });
  });

  describe("getSessionContextPercent", () => {
    it("returns null when contextUsage is unavailable", () => {
      const session = {
        getSessionStats: () => ({ tokens: { input: 10, output: 20, cacheWrite: 5 } }),
      };
      expect(getSessionContextPercent(session)).toBeNull();
    });

    it("returns null when percent is null (post-compaction)", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 10, output: 20, cacheWrite: 5 },
          contextUsage: { tokens: null, contextWindow: 200_000, percent: null },
        }),
      };
      expect(getSessionContextPercent(session)).toBeNull();
    });

    it("returns the upstream percent when available", () => {
      const session = {
        getSessionStats: () => ({
          tokens: { input: 10, output: 20, cacheWrite: 5 },
          contextUsage: { tokens: 50_000, contextWindow: 200_000, percent: 25 },
        }),
      };
      expect(getSessionContextPercent(session)).toBe(25);
    });
  });

  describe("toLifetimeUsage / addUsage", () => {
    it("retains every usage component and reliable cost without adding reasoning", () => {
      expect(toLifetimeUsage({
        input: 100,
        output: 200,
        cacheRead: 500_000,
        cacheWrite: 50,
        reasoning: 99,
        cost: { total: 0.25 },
      })).toEqual({
        input: 100,
        output: 200,
        cacheRead: 500_000,
        cacheWrite: 50,
        cost: 0.25,
      });
    });

    it("falls back to finite cost components and omits unavailable cost", () => {
      expect(toLifetimeUsage({
        input: 1,
        cost: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 },
      })).toEqual({
        input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1,
        costBreakdown: { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 },
      });
      expect(toLifetimeUsage({ input: 1 })).toEqual({
        input: 1, output: 0, cacheRead: 0, cacheWrite: 0,
      });
    });

    it("accumulates tokens, cache traffic, and available cost in place", () => {
      const usage = createLifetimeUsage();
      addUsage(usage, toLifetimeUsage({
        input: 100, output: 20, cacheRead: 900, cacheWrite: 5, cost: { total: 0.1 },
      }));
      addUsage(usage, toLifetimeUsage({
        input: 50, output: 10, cacheRead: 1_200, cacheWrite: 3, cost: { total: 0.2 },
      }));

      expect(usage).toEqual({
        input: 150,
        output: 30,
        cacheRead: 2_100,
        cacheWrite: 8,
        cost: 0.30000000000000004,
      });
    });
  });

  describe("native usage", () => {
    it("retains structured costs while trusting the provider total over their sum", () => {
      const usage = createLifetimeUsage();
      const costs = { input: 0.1, output: 0.2, cacheRead: 0.3, cacheWrite: 0.4 };
      addUsage(usage, toLifetimeUsage({ input: 2, output: 3, cacheRead: 50, cacheWrite: 5, cost: { ...costs, total: 2 } }));
      addUsage(usage, toLifetimeUsage({ input: 2, output: 3, cacheRead: 50, cacheWrite: 5, cost: { ...costs, total: 3 } }));
      expect(toReportedUsage(usage)).toEqual({
        input: 4, output: 6, cacheRead: 100, cacheWrite: 10, totalTokens: 120,
        cost: { input: 0.2, output: 0.4, cacheRead: 0.6, cacheWrite: 0.8, total: 5 },
      });
      expect(getLifetimeTotal(usage)).toBe(20);
    });

    it("does not invent components for aggregate-only cost or prices for unknown cost", () => {
      const usage = toLifetimeUsage({ input: 100, cost: { total: 2 } });
      expect(usage).not.toHaveProperty("costBreakdown");
      expect(toReportedUsage(usage).cost).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 2 });
      expect(toReportedUsage(toLifetimeUsage({ input: 100 })).cost).toEqual({
        input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0,
      });
    });

    it("aggregates mixed legacy and structured costs without discarding known components", () => {
      const usage = toLifetimeUsage({ cost: 2 });
      addUsage(usage, toLifetimeUsage({ cost: { input: 0.5, total: 1 } }));
      addUsage(usage, toLifetimeUsage({ cost: 3 }));
      expect(toReportedUsage(usage).cost).toEqual({ input: 0.5, output: 0, cacheRead: 0, cacheWrite: 0, total: 6 });
    });

    it("sanitizes malformed counters and costs and keeps overflowing sums finite", () => {
      expect(toLifetimeUsage({
        input: -1, output: NaN, cacheRead: Infinity, cacheWrite: "5",
        cost: { input: -1, output: Infinity, cacheRead: NaN, total: -1 },
      })).toEqual(createLifetimeUsage());
      for (const value of [null, undefined, [], "bad", 1]) {
        expect(toLifetimeUsage(value)).toEqual(createLifetimeUsage());
      }
      const usage = createLifetimeUsage();
      addUsage(usage, { input: -1, output: NaN, cacheRead: Infinity, cacheWrite: 0, cost: -3 });
      expect(usage).toEqual(createLifetimeUsage());
      addUsage(usage, toLifetimeUsage({ input: Number.MAX_VALUE, output: Number.MAX_VALUE, cost: Number.MAX_VALUE }));
      addUsage(usage, usage);
      const report = toReportedUsage(usage);
      expect(report.totalTokens).toBe(Number.MAX_VALUE);
      expect(report.cost.total).toBe(Number.MAX_VALUE);
    });
  });

  describe("getLifetimeTotal", () => {
    it("preserves the compact issue #38 total and excludes cacheRead/cost", () => {
      expect(getLifetimeTotal(undefined)).toBe(0);
      expect(getLifetimeTotal({
        input: 100,
        output: 200,
        cacheRead: 500_000,
        cacheWrite: 50,
        cost: 12.34,
      })).toBe(350);
    });

    // getSessionTokens reads upstream session stats (resets at compaction);
    // getLifetimeTotal reads our independent accumulator (survives compaction).
    // They agree pre-compaction, diverge after — both legitimate signals.
    it("agrees with getSessionTokens pre-compaction, diverges after", () => {
      let sessionStatsTokens = { input: 100, output: 200, cacheRead: 500_000, cacheWrite: 50 };
      const session = {
        getSessionStats: () => ({ tokens: sessionStatsTokens }),
      };
      const lifetime = createLifetimeUsage();
      addUsage(lifetime, toLifetimeUsage(sessionStatsTokens));

      expect(getSessionTokens(session)).toBe(350);
      expect(getLifetimeTotal(lifetime)).toBe(350);
      expect(lifetime.cacheRead).toBe(500_000);

      // Compaction: upstream replaces session.state.messages, so stats reset.
      // Our accumulator is independent — it keeps growing.
      sessionStatsTokens = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

      expect(getSessionTokens(session)).toBe(0);
      expect(getLifetimeTotal(lifetime)).toBe(350);

      // Subsequent message_end events feed both: session re-fills, accumulator continues.
      sessionStatsTokens = { input: 80, output: 150, cacheRead: 400_000, cacheWrite: 30 };
      addUsage(lifetime, toLifetimeUsage(sessionStatsTokens));

      expect(getSessionTokens(session)).toBe(260);
      expect(getLifetimeTotal(lifetime)).toBe(610);
      expect(lifetime.cacheRead).toBe(900_000);
    });

    // The accumulator survives compaction because it lives on AgentActivity /
    // AgentRecord, not on session.state.messages (which compaction replaces).
    it("stays monotone across simulated compaction while retaining cacheRead separately", () => {
      const usage = createLifetimeUsage();
      const onUsage = (value: unknown) => addUsage(usage, toLifetimeUsage(value));

      for (let i = 0; i < 5; i++) {
        onUsage({ input: 1000, output: 200, cacheRead: 10_000, cacheWrite: 50 });
      }
      expect(getLifetimeTotal(usage)).toBe(5 * 1250);
      expect(usage.cacheRead).toBe(50_000);

      const beforeCompaction = getLifetimeTotal(usage);
      for (let i = 0; i < 3; i++) {
        onUsage({ input: 800, output: 150, cacheRead: 8_000, cacheWrite: 30 });
      }
      expect(getLifetimeTotal(usage)).toBe(beforeCompaction + 3 * 980);
      expect(getLifetimeTotal(usage)).toBeGreaterThan(beforeCompaction);
      expect(usage.cacheRead).toBe(74_000);

      // The compact total deliberately retains its historical formula.
      expect(usage.input + usage.output + usage.cacheWrite).toBe(getLifetimeTotal(usage));
    });
  });
});
