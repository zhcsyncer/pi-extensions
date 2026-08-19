/**
 * Optional pi-meter guest quota source.
 *
 * Uses the process-global mailbox so this package does not import pi-meter.
 * If meter is absent, registration is a no-op mailbox write.
 */

import { CURSOR_ASK_IDENTITY } from "../identity.js";
import { redactSecrets } from "../utils/security.js";
import { getCursorUsageSummary, type CursorUsageSummary } from "../usage.js";

export const CURSOR_QUOTA_ADAPTERS_KEY = Symbol.for("@zhcsyncer/pi-meter/quota-adapters");
export const CURSOR_QUOTA_SOURCE_ID = CURSOR_ASK_IDENTITY.providerId;
export const CURSOR_QUOTA_TITLE = "Cursor";

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
  matchProvider(modelProvider: string): boolean;
  fetch(ctx: { modelRegistry?: unknown }, fetchedAt?: number): Promise<CursorQuotaSnapshot>;
}

interface QuotaAdapterHost {
  register?(adapter: CursorQuotaAdapter): void;
  list?(): unknown[];
  mailbox?: unknown[];
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function planLabel(summary: CursorUsageSummary): string {
  const name = summary.membershipType?.trim();
  return name ? `${name} plan` : "Monthly plan";
}

export function cursorUsageToQuotaSnapshot(
  summary: CursorUsageSummary,
  fetchedAt: number,
): CursorQuotaSnapshot {
  const plan = summary.individualUsage?.plan;
  const usedPercent = summary.isUnlimited ? 0 : clampPercent(plan?.totalPercentUsed ?? 0);
  const window: CursorQuotaWindow = {
    id: "plan",
    label: planLabel(summary),
    usedPercent,
    ...(summary.billingCycleEnd ? { resetsAt: summary.billingCycleEnd } : {}),
    ...(summary.isUnlimited ? { note: "unlimited" } : {}),
  };
  return {
    provider: CURSOR_QUOTA_SOURCE_ID,
    title: CURSOR_QUOTA_TITLE,
    primary: window,
    windows: [window],
    fetchedAt,
    ok: true,
  };
}

export function createCursorQuotaAdapter(
  getAccessToken: () => Promise<string>,
): CursorQuotaAdapter {
  return {
    id: CURSOR_QUOTA_SOURCE_ID,
    title: CURSOR_QUOTA_TITLE,
    matchProvider: (modelProvider) => modelProvider === CURSOR_ASK_IDENTITY.providerId,
    fetch: async (_ctx, fetchedAt = Date.now()) => {
      try {
        return cursorUsageToQuotaSnapshot(await getCursorUsageSummary(getAccessToken), fetchedAt);
      } catch (error) {
        return {
          provider: CURSOR_QUOTA_SOURCE_ID,
          title: CURSOR_QUOTA_TITLE,
          windows: [],
          fetchedAt,
          ok: false,
          error: redactSecrets(error instanceof Error ? error.message : String(error)),
        };
      }
    },
  };
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
