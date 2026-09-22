/**
 * Optional pi-meter guest quota sources.
 *
 * Cursor has two included pools: Include (Composer and Grok; usage API `autoPercentUsed`)
 * and Other (Claude and remaining rows; `apiPercentUsed`). Registration ids are the
 * meter mailbox keys and also appear as footer brands, so they follow the same names.
 * Registration uses the process-global mailbox so this package does not import pi-meter.
 */

import { CURSOR_ASK_IDENTITY } from "../identity.js";
import { redactSecrets } from "../utils/security.js";
import { getCursorUsageSummary, type CursorUsageSummary } from "../usage.js";

export const CURSOR_QUOTA_ADAPTERS_KEY = Symbol.for("@zhcsyncer/pi-meter/quota-adapters");

export type CursorQuotaPool = "auto" | "api";

export const CURSOR_QUOTA_INCLUDE_ID = "cursor-include";
export const CURSOR_QUOTA_OTHER_ID = "cursor-other";

export interface CursorQuotaModelRef {
  provider?: string;
  id?: string;
}

export interface CursorQuotaWindow {
  id: string;
  label: string;
  usedPercent: number;
  resetsAt?: string;
  note?: string;
}

export interface CursorQuotaSnapshot {
  provider: string;
  title: string;
  primary?: CursorQuotaWindow;
  windows: CursorQuotaWindow[];
  fetchedAt: number;
  ok: boolean;
  error?: string;
}

export interface CursorQuotaAdapter {
  id: string;
  title: string;
  matchProvider(model: CursorQuotaModelRef): boolean;
  fetch(ctx: { modelRegistry?: unknown }, fetchedAt?: number): Promise<CursorQuotaSnapshot>;
}

interface QuotaAdapterHost {
  register?(adapter: CursorQuotaAdapter): void;
  list?(): unknown[];
  mailbox?: unknown[];
}

const POOL_META: Record<
  CursorQuotaPool,
  { id: string; title: string; windowId: string; label: string }
> = {
  auto: {
    id: CURSOR_QUOTA_INCLUDE_ID,
    title: "Cursor Include",
    windowId: "include",
    label: "Include",
  },
  api: { id: CURSOR_QUOTA_OTHER_ID, title: "Cursor Other", windowId: "other", label: "Other" },
};

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function usesCursorModelsPool(id: string | undefined): boolean {
  return typeof id === "string" && (/composer/i.test(id) || /^(?:cursor-)?grok(?:-|$)/i.test(id));
}

function poolPercent(summary: CursorUsageSummary, pool: CursorQuotaPool): number {
  if (summary.isUnlimited) return 0;
  const plan = summary.individualUsage?.plan;
  const value = pool === "auto" ? plan?.autoPercentUsed : plan?.apiPercentUsed;
  return clampPercent(value ?? 0);
}

export function cursorUsageToQuotaSnapshot(
  summary: CursorUsageSummary,
  fetchedAt: number,
  pool: CursorQuotaPool,
): CursorQuotaSnapshot {
  const meta = POOL_META[pool];
  const window: CursorQuotaWindow = {
    id: meta.windowId,
    label: meta.label,
    usedPercent: poolPercent(summary, pool),
    ...(summary.billingCycleEnd ? { resetsAt: summary.billingCycleEnd } : {}),
    ...(summary.isUnlimited ? { note: "unlimited" } : {}),
  };
  return {
    provider: meta.id,
    title: meta.title,
    primary: window,
    windows: [window],
    fetchedAt,
    ok: true,
  };
}

function failedSnapshot(
  pool: CursorQuotaPool,
  fetchedAt: number,
  error: unknown,
): CursorQuotaSnapshot {
  const meta = POOL_META[pool];
  return {
    provider: meta.id,
    title: meta.title,
    windows: [],
    fetchedAt,
    ok: false,
    error: redactSecrets(error instanceof Error ? error.message : String(error)),
  };
}

export function createCursorQuotaAdapters(
  getAccessToken: () => Promise<string>,
): CursorQuotaAdapter[] {
  const fetchPool = async (
    pool: CursorQuotaPool,
    fetchedAt: number,
  ): Promise<CursorQuotaSnapshot> => {
    try {
      return cursorUsageToQuotaSnapshot(
        await getCursorUsageSummary(getAccessToken),
        fetchedAt,
        pool,
      );
    } catch (error) {
      return failedSnapshot(pool, fetchedAt, error);
    }
  };

  return [
    {
      id: CURSOR_QUOTA_INCLUDE_ID,
      title: POOL_META.auto.title,
      matchProvider: (model) =>
        model.provider === CURSOR_ASK_IDENTITY.providerId && usesCursorModelsPool(model.id),
      fetch: async (_ctx, fetchedAt = Date.now()) => fetchPool("auto", fetchedAt),
    },
    {
      id: CURSOR_QUOTA_OTHER_ID,
      title: POOL_META.api.title,
      matchProvider: (model) =>
        model.provider === CURSOR_ASK_IDENTITY.providerId && !usesCursorModelsPool(model.id),
      fetch: async (_ctx, fetchedAt = Date.now()) => fetchPool("api", fetchedAt),
    },
  ];
}

export function registerCursorQuotaAdapter(adapter: CursorQuotaAdapter): void {
  const host = (globalThis as Record<symbol, QuotaAdapterHost | undefined>)[
    CURSOR_QUOTA_ADAPTERS_KEY
  ];
  if (typeof host?.register === "function") {
    host.register(adapter);
    return;
  }
  const mailbox = Array.isArray(host?.mailbox) ? host.mailbox : [];
  mailbox.push(adapter);
  (globalThis as Record<symbol, QuotaAdapterHost>)[CURSOR_QUOTA_ADAPTERS_KEY] = {
    ...host,
    mailbox,
  };
}

export function registerCursorQuotaAdapters(getAccessToken: () => Promise<string>): void {
  for (const adapter of createCursorQuotaAdapters(getAccessToken)) {
    registerCursorQuotaAdapter(adapter);
  }
}
