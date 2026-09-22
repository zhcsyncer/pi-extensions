import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CURSOR_QUOTA_ADAPTERS_KEY,
  createCursorQuotaAdapters,
  cursorUsageToQuotaSnapshot,
  registerCursorQuotaAdapter,
  registerCursorQuotaAdapters,
} from "../src/extension/quota-adapter.js";

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[CURSOR_QUOTA_ADAPTERS_KEY];
});

const summary = {
  billingCycleEnd: "2026-09-01T00:00:00.000Z",
  membershipType: "Pro",
  individualUsage: {
    plan: { totalPercentUsed: 40, autoPercentUsed: 12, apiPercentUsed: 55 },
  },
};

describe("cursorUsageToQuotaSnapshot", () => {
  it("maps Include and Other percents to separate primary windows", () => {
    const auto = cursorUsageToQuotaSnapshot(summary, 1, "auto");
    const api = cursorUsageToQuotaSnapshot(summary, 1, "api");
    expect(auto).toMatchObject({
      provider: "cursor-include",
      title: "Cursor Include",
      primary: {
        id: "include",
        label: "Include",
        usedPercent: 12,
        resetsAt: summary.billingCycleEnd,
      },
    });
    expect(api).toMatchObject({
      provider: "cursor-other",
      title: "Cursor Other",
      primary: { id: "other", label: "Other", usedPercent: 55, resetsAt: summary.billingCycleEnd },
    });
  });

  it("treats unlimited plans as zero used", () => {
    const snapshot = cursorUsageToQuotaSnapshot({ isUnlimited: true }, 1, "api");
    expect(snapshot.primary).toMatchObject({ usedPercent: 0, note: "unlimited" });
  });
});

describe("createCursorQuotaAdapters", () => {
  it.each([
    "composer-2.5",
    "composer-2.5-fast",
    "grok-4.6",
    "grok-4.6-fast",
    "cursor-grok-4.6-low",
    "cursor-grok-4.6-fast-xhigh",
  ])("routes %s exclusively to the Include pool", (id) => {
    const adapters = createCursorQuotaAdapters(async () => "token");
    expect(
      adapters
        .filter((adapter) => adapter.matchProvider({ provider: "cursor", id }))
        .map((adapter) => adapter.id),
    ).toEqual(["cursor-include"]);
  });

  it.each(["fable-5.1", "fable-5", "opus-5", "opus-4.6", "sonnet-5", "unknown-model"])(
    "routes %s exclusively to the Other pool",
    (id) => {
      const adapters = createCursorQuotaAdapters(async () => "token");
      expect(
        adapters
          .filter((adapter) => adapter.matchProvider({ provider: "cursor", id }))
          .map((adapter) => adapter.id),
      ).toEqual(["cursor-other"]);
    },
  );

  it.each(["grok-4.6", "composer-2.5", "opus-5"])(
    "does not claim %s from another provider",
    (id) => {
      const adapters = createCursorQuotaAdapters(async () => "token");
      expect(adapters.some((adapter) => adapter.matchProvider({ provider: "xai", id }))).toBe(
        false,
      );
    },
  );

  it("returns ok:false instead of throwing when usage cannot be fetched", async () => {
    const [auto] = createCursorQuotaAdapters(async () => {
      throw new Error("Not logged in to Cursor eyJhbGciOiJIUzI1NiJ9.aaa.bbb");
    });
    const snapshot = await auto!.fetch({}, 99);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.fetchedAt).toBe(99);
    expect(snapshot.error).toMatch(/Not logged in to Cursor/i);
    expect(snapshot.error).not.toMatch(/eyJhbGciOiJIUzI1NiJ9/);
  });
});

describe("registerCursorQuotaAdapters", () => {
  it("writes both sources to the mailbox when meter has not installed a host", () => {
    registerCursorQuotaAdapters(async () => "token");
    const host = (globalThis as Record<symbol, { mailbox?: { id: string }[] }>)[
      CURSOR_QUOTA_ADAPTERS_KEY
    ];
    expect(host?.mailbox?.map((item) => item.id)).toEqual(["cursor-include", "cursor-other"]);
  });

  it("calls host.register for each source when meter is already loaded", () => {
    const register = vi.fn();
    (globalThis as Record<symbol, { register: typeof register }>)[CURSOR_QUOTA_ADAPTERS_KEY] = {
      register,
    };
    registerCursorQuotaAdapters(async () => "token");
    expect(register).toHaveBeenCalledTimes(2);
    expect(register.mock.calls.map((call) => call[0]?.id)).toEqual([
      "cursor-include",
      "cursor-other",
    ]);
  });

  it("still registers a single adapter through the mailbox helper", () => {
    const [auto] = createCursorQuotaAdapters(async () => "token");
    registerCursorQuotaAdapter(auto!);
    const host = (globalThis as Record<symbol, { mailbox?: unknown[] }>)[CURSOR_QUOTA_ADAPTERS_KEY];
    expect(host?.mailbox).toEqual([auto]);
  });
});
