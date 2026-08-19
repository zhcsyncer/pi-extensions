import { afterEach, describe, expect, it, vi } from "vitest";

import {
  CURSOR_QUOTA_ADAPTERS_KEY,
  createCursorQuotaAdapter,
  cursorUsageToQuotaSnapshot,
  registerCursorQuotaAdapter,
} from "../src/extension/quota-adapter.js";

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[CURSOR_QUOTA_ADAPTERS_KEY];
});

describe("cursorUsageToQuotaSnapshot", () => {
  it("maps plan percent and reset time to a primary window", () => {
    const snapshot = cursorUsageToQuotaSnapshot(
      {
        billingCycleEnd: "2026-09-01T00:00:00.000Z",
        membershipType: "Pro",
        individualUsage: { plan: { totalPercentUsed: 42 } },
      },
      1_700_000_000_000,
    );
    expect(snapshot).toMatchObject({
      provider: "cursor",
      title: "Cursor",
      ok: true,
      fetchedAt: 1_700_000_000_000,
      primary: {
        id: "plan",
        label: "Pro plan",
        usedPercent: 42,
        resetsAt: "2026-09-01T00:00:00.000Z",
      },
    });
    expect(snapshot.windows).toEqual([snapshot.primary]);
  });

  it("treats unlimited plans as zero used", () => {
    const snapshot = cursorUsageToQuotaSnapshot({ isUnlimited: true }, 1);
    expect(snapshot.primary).toMatchObject({ usedPercent: 0, note: "unlimited" });
  });
});

describe("registerCursorQuotaAdapter", () => {
  it("writes to the mailbox when meter has not installed a host", () => {
    const adapter = createCursorQuotaAdapter(async () => "token");
    registerCursorQuotaAdapter(adapter);
    const host = (globalThis as Record<symbol, { mailbox?: unknown[] }>)[CURSOR_QUOTA_ADAPTERS_KEY];
    expect(host?.mailbox).toEqual([adapter]);
  });

  it("calls host.register when meter is already loaded", () => {
    const register = vi.fn();
    (globalThis as Record<symbol, { register: typeof register }>)[CURSOR_QUOTA_ADAPTERS_KEY] = {
      register,
    };
    const adapter = createCursorQuotaAdapter(async () => "token");
    registerCursorQuotaAdapter(adapter);
    expect(register).toHaveBeenCalledWith(adapter);
  });
});

describe("createCursorQuotaAdapter", () => {
  it("matches only the cursor provider id", () => {
    const adapter = createCursorQuotaAdapter(async () => "token");
    expect(adapter.matchProvider("cursor")).toBe(true);
    expect(adapter.matchProvider("xai")).toBe(false);
  });

  it("returns ok:false instead of throwing when usage cannot be fetched", async () => {
    const adapter = createCursorQuotaAdapter(async () => {
      throw new Error("Not logged in to Cursor eyJhbGciOiJIUzI1NiJ9.aaa.bbb");
    });
    const snapshot = await adapter.fetch({}, 99);
    expect(snapshot.ok).toBe(false);
    expect(snapshot.windows).toEqual([]);
    expect(snapshot.fetchedAt).toBe(99);
    expect(snapshot.error).toMatch(/Not logged in to Cursor/i);
    expect(snapshot.error).not.toMatch(/eyJhbGciOiJIUzI1NiJ9/);
  });
});
