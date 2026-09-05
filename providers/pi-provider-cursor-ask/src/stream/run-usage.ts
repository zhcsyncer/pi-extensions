/** Receipt ownership follows an upstream Run, not each local Pi tool response. */
import { lifecycleLog, reportCursorAnomaly } from "./debug-log.js";
import type {
  CursorBilledUsage,
  CursorRunUsage,
  StoredConversation,
  StreamState,
} from "./types.js";

export interface CursorBillingInfo {
  status: "reported" | "partial" | "already-reported" | "pending" | "unavailable" | "not-started";
  missingFields?: Array<keyof CursorBilledUsage>;
  carriedReceipts?: number;
}

export function recordRunReceipt(
  state: StreamState,
  billed: CursorBilledUsage,
  raw: {
    inputTokens?: bigint | number;
    outputTokens?: bigint | number;
    cacheReadTokens?: bigint | number;
    cacheWriteTokens?: bigint | number;
  },
): void {
  const run = (state.runUsage ??= {});
  // A repeated terminal frame must never turn the same receipt into a second charge.
  if (run.billedUsage) return;
  const pairs = [
    ["input", raw.inputTokens],
    ["output", raw.outputTokens],
    ["cacheRead", raw.cacheReadTokens],
    ["cacheWrite", raw.cacheWriteTokens],
  ] as const;
  const missingFields = pairs
    .filter(
      ([, value]) =>
        value === undefined || !Number.isSafeInteger(Number(value)) || Number(value) < 0,
    )
    .map(([key]) => key);
  if (billed.cacheRead + billed.cacheWrite > billed.input && !missingFields.includes("input"))
    missingFields.push("input");
  state.billedUsage = billed;
  run.billedUsage = billed;
  run.missingFields = missingFields;
}

export function takeRunReceipt(state?: StreamState): {
  billed?: CursorBilledUsage;
  info: CursorBillingInfo;
} {
  if (!state) return { info: { status: "not-started" } };
  const run = (state.runUsage ??= {});
  // Preserve the small standalone StreamState seam used by older callers/tests.
  run.billedUsage ??= state.billedUsage;
  if (run.reported) return { info: { status: "already-reported" } };
  if (!run.billedUsage) return { info: { status: state.turnEnded ? "unavailable" : "pending" } };
  run.reported = true;
  const missingFields = run.missingFields ?? [];
  const raw = run.billedUsage;
  const canPriceInput = !missingFields.some(
    (key) => key === "input" || key === "cacheRead" || key === "cacheWrite",
  );
  return {
    billed: {
      ...raw,
      // When the cache split is incomplete we cannot price the cache-inclusive input as uncached.
      // Only explicitly known output/cache buckets are charged; metadata marks the missing remainder.
      input: canPriceInput ? raw.input : raw.cacheRead + raw.cacheWrite,
    },
    info: missingFields.length ? { status: "partial", missingFields } : { status: "reported" },
  };
}

export function retainRunReceipt(
  stored: StoredConversation | undefined,
  run: CursorRunUsage,
): void {
  if (!stored || !run.billedUsage || run.reported) return;
  const pending = (stored.unreportedUsage ??= []);
  if (!pending.includes(run)) pending.push(run);
}

export function takePendingRunReceipts(
  stored: StoredConversation | undefined,
  modelId: string,
): CursorRunUsage[] {
  if (!stored?.unreportedUsage) return [];
  const receipts = stored.unreportedUsage.filter((run) => !run.reported && run.modelId === modelId);
  stored.unreportedUsage = stored.unreportedUsage.filter(
    (run) => !run.reported && run.modelId !== modelId,
  );
  return receipts;
}

export function reportRunUsageBoundary(run: CursorRunUsage, reason: string): void {
  if (run.boundaryLogged || run.reported) return;
  run.boundaryLogged = true;
  const status = run.billedUsage ? "receipt_unreported" : "receipt_missing";
  lifecycleLog("usage_run_unsettled", { reason, status });
  reportCursorAnomaly(
    "usage_incomplete",
    "Cursor billing is not fully reported; displayed costs may omit usage.",
    { reason, status },
    { level: "warning" },
  );
}
