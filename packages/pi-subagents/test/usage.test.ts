import { describe, expect, it } from "vitest";
import {
  addUsage,
  createLifetimeUsage,
  getLifetimeTotal,
  getSessionContextPercent,
  getSessionTokens,
  toLifetimeUsage,
} from "../src/usage.js";

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
      })).toEqual({ input: 1, output: 0, cacheRead: 0, cacheWrite: 0, cost: 1 });
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
