/**
 * Stream writer adapter converting internal events to Pi AssistantMessageEventStream.
 */

import type { Api, AssistantMessageEventStream, Context, Model } from "@earendil-works/pi-ai";
import type {
  CursorRunUsage,
  NativeBlockKind,
  NativeStreamWriter,
  PendingExec,
  StreamState,
} from "./types.js";
import { applyCursorUsage, createCursorAssistantMessage } from "./pi-adapter.js";
import { parseToolCallArguments } from "./message-parsing.js";
import { createCursorContextTracker, type CursorAssistantMessage } from "./context-usage.js";
import { lifecycleLog, reportCursorAnomaly } from "./debug-log.js";

export function createNativeStreamWriter(
  stream: AssistantMessageEventStream,
  model: Model<Api>,
  context?: Context,
  options?: { sessionId?: string; reasoning?: string },
): NativeStreamWriter {
  const output: CursorAssistantMessage = createCursorAssistantMessage(model);
  const contextTracker = createCursorContextTracker(model, context, options);
  const carriedReceipts = new Set<CursorRunUsage>();
  let started = false;
  let closed = false;
  let active: { kind: NativeBlockKind; contentIndex: number; ended: boolean } | undefined;

  const ensureStarted = (): void => {
    if (started) return;
    started = true;
    stream.push({ type: "start", partial: output });
  };

  const endActiveBlock = (): void => {
    if (!active || active.ended) return;
    const block = output.content[active.contentIndex];
    if (active.kind === "text" && block?.type === "text") {
      stream.push({
        type: "text_end",
        contentIndex: active.contentIndex,
        content: block.text,
        partial: output,
      });
    } else if (active.kind === "thinking" && block?.type === "thinking") {
      stream.push({
        type: "thinking_end",
        contentIndex: active.contentIndex,
        content: block.thinking,
        partial: output,
      });
    }
    active.ended = true;
    active = undefined;
  };

  const ensureBlock = (kind: NativeBlockKind): number => {
    ensureStarted();
    if (active?.kind === kind && !active.ended) return active.contentIndex;
    endActiveBlock();
    const contentIndex = output.content.length;
    if (kind === "text") {
      output.content.push({ type: "text", text: "" });
      stream.push({ type: "text_start", contentIndex, partial: output });
    } else {
      output.content.push({ type: "thinking", thinking: "" });
      stream.push({ type: "thinking_start", contentIndex, partial: output });
    }
    active = { kind, contentIndex, ended: false };
    return contentIndex;
  };

  const finishUsage = (reason: string, state?: StreamState): void => {
    const snapshot = contextTracker.finish(output);
    const billing = applyCursorUsage(output, model, state, snapshot.tokens);
    for (const receipt of carriedReceipts) {
      const extra = createCursorAssistantMessage(model);
      const info = applyCursorUsage(
        extra,
        model,
        {
          toolCallIndex: 0,
          pendingExecs: [],
          outputTokens: 0,
          totalTokens: 0,
          turnEnded: true,
          runUsage: receipt,
        },
        snapshot.tokens,
      );
      if (info.status !== "reported" && info.status !== "partial") continue;
      for (const key of ["input", "output", "cacheRead", "cacheWrite"] as const) {
        output.usage[key] += extra.usage[key];
        output.usage.cost[key] += extra.usage.cost[key];
      }
      output.usage.cost.total += extra.usage.cost.total;
      billing.carriedReceipts = (billing.carriedReceipts ?? 0) + 1;
      if (info.status === "partial") billing.status = "partial";
    }
    if (billing.status === "pending" && reason !== "toolUse") billing.status = "unavailable";
    output.cursorUsage!.billing = billing;
    if (billing.status === "partial" || billing.status === "unavailable") {
      lifecycleLog("usage_incomplete", { modelId: model.id, reason, ...billing });
    }
    if (billing.status === "partial") {
      reportCursorAnomaly(
        "usage_incomplete",
        "Cursor returned an incomplete billing split; displayed costs include only known buckets.",
        { modelId: model.id, ...billing },
        { level: "warning" },
      );
    }
    if (snapshot.source === "estimate" && reason !== "toolUse") {
      lifecycleLog("usage_context_estimated", {
        modelId: model.id,
        reason,
        contextTokens: snapshot.tokens,
      });
    }
  };

  return {
    output,
    contextSnapshot(tokens: number) {
      if (!closed) contextTracker.observe(tokens, output);
    },
    contextMode(mode, tokens) {
      if (!closed) contextTracker.begin(mode, tokens);
    },
    carryUsage(usage) {
      if (!closed && usage.modelId === model.id) carriedReceipts.add(usage);
    },
    get closed() {
      return closed;
    },
    start: ensureStarted,
    text(delta: string) {
      if (closed || !delta) return;
      const contentIndex = ensureBlock("text");
      const block = output.content[contentIndex];
      if (block?.type !== "text") return;
      block.text += delta;
      stream.push({ type: "text_delta", contentIndex, delta, partial: output });
    },
    thinking(delta: string) {
      if (closed || !delta) return;
      const contentIndex = ensureBlock("thinking");
      const block = output.content[contentIndex];
      if (block?.type !== "thinking") return;
      block.thinking += delta;
      stream.push({ type: "thinking_delta", contentIndex, delta, partial: output });
    },
    toolCall(exec: PendingExec) {
      if (closed) return;
      ensureStarted();
      endActiveBlock();
      const contentIndex = output.content.length;
      const parsedArguments = parseToolCallArguments(exec.decodedArgs);
      const block = {
        type: "toolCall" as const,
        id: exec.toolCallId,
        name: exec.toolName,
        arguments: {},
      };
      output.content.push(block);
      stream.push({ type: "toolcall_start", contentIndex, partial: output });
      block.arguments = parsedArguments;
      stream.push({
        type: "toolcall_delta",
        contentIndex,
        delta: exec.decodedArgs,
        partial: output,
      });
      stream.push({
        type: "toolcall_end",
        contentIndex,
        toolCall: {
          type: "toolCall",
          id: exec.toolCallId,
          name: exec.toolName,
          arguments: parsedArguments,
        },
        partial: output,
      });
    },
    done(reason: "stop" | "length" | "toolUse", state?: StreamState) {
      if (closed) return;
      ensureStarted();
      endActiveBlock();
      // Intermediate tool replies publish context, not an invented per-inference bill.
      finishUsage(reason, state);
      output.stopReason = reason;
      stream.push({ type: "done", reason, message: output });
      closed = true;
      stream.end(output);
    },
    error(message: string, reason: "error" | "aborted", state?: StreamState) {
      if (closed) return;
      ensureStarted();
      endActiveBlock();
      finishUsage(reason, state);
      output.stopReason = reason;
      output.errorMessage = message;
      stream.push({ type: "error", reason, error: output });
      closed = true;
      stream.end(output);
    },
  };
}
