/** Cursor-only context estimates. Billing totals must never become a context fallback. */
import { createHash, type Hash } from "node:crypto";
import type { Api, AssistantMessage, Context, Message, Model } from "@earendil-works/pi-ai";
import type { CursorBillingInfo } from "./run-usage.js";

export interface CursorUsageMetadata {
  version: 1;
  billing?: CursorBillingInfo;
  context: {
    tokens: number;
    source: "checkpoint" | "estimate";
    scope: string;
    history: string;
  };
}

type ContextMessage = Message & { cursorUsage?: CursorUsageMetadata };
export type CursorAssistantMessage = AssistantMessage & { cursorUsage?: CursorUsageMetadata };

export function positiveContextTokens(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.ceil(value)
    : undefined;
}

function textTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / 4);
}

/** A bounded image heuristic, not base64 length or an assertion of upstream tokenization. */
export function estimateMessageTokens(message: Pick<Message, "content">): number {
  if (typeof message.content === "string") return 4 + textTokens(message.content);
  let tokens = 4;
  for (const block of message.content) {
    switch (block.type) {
      case "text":
        tokens += textTokens(block.text);
        break;
      case "thinking":
        tokens += textTokens(block.thinking);
        break;
      case "image":
        tokens += 1200;
        break;
      case "toolCall":
        tokens += textTokens(block.name) + textTokens(JSON.stringify(block.arguments));
        break;
    }
  }
  return tokens;
}

function appendMessageHash(hash: Hash, message: Message): void {
  // Exclude accounting metadata/timestamps, but bind the anchor to the actual message prefix.
  hash.update(JSON.stringify({ role: message.role, content: message.content }));
  hash.update("\n");
}

export function createCursorContextTracker(
  model: Model<Api>,
  context: Context = { messages: [] },
  options?: { sessionId?: string; reasoning?: string },
) {
  const scope = createHash("sha256")
    .update(
      JSON.stringify({
        provider: model.provider,
        model: model.id,
        window: model.contextWindow,
        session: options?.sessionId,
        reasoning: options?.reasoning,
        system: context.systemPrompt,
        tools: context.tools,
      }),
    )
    .digest("hex");
  const history = createHash("sha256");
  let inputTokens =
    textTokens(context.systemPrompt ?? "") + textTokens(JSON.stringify(context.tools ?? []));
  let rawInputTokens = inputTokens;
  let anchorTokens: number | undefined;
  let trailingTokens = 0;
  for (const message of context.messages) {
    appendMessageHash(history, message);
    const estimated = estimateMessageTokens(message);
    inputTokens += estimated;
    rawInputTokens += estimated;
    trailingTokens += estimated;
    const saved = (message as ContextMessage).cursorUsage;
    if (
      message.role === "assistant" &&
      message.provider === model.provider &&
      message.model === model.id &&
      saved?.version === 1 &&
      saved.context &&
      positiveContextTokens(saved.context.tokens) &&
      saved.context.scope === scope &&
      saved.context.history === history.copy().digest("hex")
    ) {
      // An unchanged same-session prefix preserves Cursor's otherwise invisible prompt overhead.
      // A fork/new session, compaction, history edit, model or system/tools change invalidates it.
      inputTokens = saved.context.tokens;
      anchorTokens = saved.context.tokens;
      trailingTokens = 0;
    }
  }
  const anchoredInputTokens = inputTokens;
  let snapshot: { tokens: number; generatedAtSnapshot: number } | undefined;
  return {
    begin(mode: "history" | "checkpoint" | "live", inheritedTokens?: number): void {
      snapshot = undefined;
      // A server-side summary cannot calibrate a request that re-expanded the full Pi history.
      inputTokens = mode === "history" ? rawInputTokens : anchoredInputTokens;
      const inherited = positiveContextTokens(inheritedTokens);
      if (
        mode !== "history" &&
        inherited !== undefined &&
        (mode === "live" || anchorTokens !== undefined)
      ) {
        // This observation is newer than the message anchor, so it must also be allowed to shrink.
        inputTokens = inherited + (anchorTokens !== undefined ? trailingTokens : 0);
      }
    },
    observe(tokens: number, output: AssistantMessage): void {
      const valid = positiveContextTokens(tokens);
      if (valid === undefined) return;
      // A genuine smaller positive snapshot (e.g. upstream summarization) must be accepted too.
      snapshot = { tokens: valid, generatedAtSnapshot: estimateMessageTokens(output) };
    },
    finish(output: CursorAssistantMessage): CursorUsageMetadata["context"] {
      const generated = estimateMessageTokens(output);
      const suffix = snapshot ? Math.max(0, generated - snapshot.generatedAtSnapshot) : generated;
      const tokens = Math.max(1, Math.ceil((snapshot?.tokens ?? inputTokens) + suffix));
      const finalHistory = history.copy();
      appendMessageHash(finalHistory, output);
      const result: CursorUsageMetadata["context"] = {
        tokens,
        source: snapshot && suffix === 0 ? "checkpoint" : "estimate",
        scope,
        history: finalHistory.digest("hex"),
      };
      output.cursorUsage = { version: 1, context: result };
      return result;
    },
  };
}
