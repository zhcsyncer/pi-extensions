/** Correct Pi's successful-response silent-overflow heuristic for cumulative Cursor receipts. */
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import { positiveContextTokens, type CursorAssistantMessage } from "../stream/context-usage.js";
import { lifecycleLog } from "../stream/debug-log.js";
import { ProviderConstant } from "../types/enums.js";

export function shouldSuppressCursorOverflow(input: {
  reason?: string;
  willRetry?: boolean;
  model?: { provider: string; id: string; contextWindow: number };
  lastAssistant?: AssistantMessage;
  reserveTokens: number;
  currentContextTokens?: number | null;
}): boolean {
  const { model, lastAssistant: message } = input;
  if (input.reason !== "overflow" || input.willRetry !== false) return false;
  if (!model || model.provider !== "cursor" || !message) return false;
  if (
    message.provider !== model.provider ||
    message.model !== model.id ||
    message.api !== ProviderConstant.NativeApi
  )
    return false;
  if (message.stopReason !== "stop" || message.errorMessage) return false;
  const metadata = (message as CursorAssistantMessage).cursorUsage;
  const observed = positiveContextTokens(metadata?.context?.tokens);
  const current = positiveContextTokens(input.currentContextTokens);
  const window = positiveContextTokens(model.contextWindow);
  if (
    metadata?.version !== 1 ||
    metadata.context?.source !== "checkpoint" ||
    observed === undefined ||
    current === undefined ||
    window === undefined
  )
    return false;
  if (
    message.usage.totalTokens !== observed ||
    !Number.isFinite(input.reserveTokens) ||
    input.reserveTokens < 0
  )
    return false;
  const promptBill = message.usage.input + message.usage.cacheRead;
  const threshold = window - input.reserveTokens;
  // Leave actual/near overflow, unknown evidence, manual requests and error recovery to Pi.
  // Also check current context so a later large tool/user message cannot be hidden by an old snapshot.
  return (
    Number.isFinite(promptBill) &&
    promptBill > window &&
    observed < threshold &&
    current < threshold
  );
}

export function registerCursorCompactionGuard(pi: ExtensionAPI): void {
  pi.on("session_before_compact", (event, ctx) => {
    let lastAssistant: AssistantMessage | undefined;
    for (let i = event.branchEntries.length - 1; i >= 0; i--) {
      const entry = event.branchEntries[i]!;
      if (entry.type === "compaction") break;
      if (entry.type === "message" && entry.message.role === "assistant") {
        lastAssistant = entry.message;
        break;
      }
    }
    if (
      !shouldSuppressCursorOverflow({
        reason: event.reason,
        willRetry: event.willRetry,
        model: ctx.model,
        lastAssistant,
        reserveTokens: event.preparation.settings.reserveTokens,
        currentContextTokens: ctx.getContextUsage()?.tokens,
      })
    )
      return;
    lifecycleLog("compaction_overflow_suppressed", {
      modelId: ctx.model?.id,
      contextTokens: lastAssistant!.usage.totalTokens,
      promptBill: lastAssistant!.usage.input + lastAssistant!.usage.cacheRead,
      contextWindow: ctx.model?.contextWindow,
    });
    return { cancel: true };
  });
}
