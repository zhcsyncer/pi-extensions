/**
 * subagent-error-status-e2e.test.ts — regression for issue #144: a subagent
 * whose final assistant turn is a provider error must be reported as a
 * failure, not as "completed" with an empty (or stale) result.
 *
 * Full-stack: real pi loader + real extension + real runAgent + real child
 * sessions on a faux model.
 */
import { fauxAssistantMessage, fauxText, fauxToolCall } from "@earendil-works/pi-ai";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  agentCall,
  type PrintModeRun,
  routeBySession,
  runPrintMode,
} from "./helpers/print-mode-runner.js";

/** Text of the parent's Agent tool result — what the orchestrator LLM sees. */
function agentToolResult(session: AgentSession): string {
  const msg = [...session.messages].reverse().find(
    (m) => m.role === "toolResult" && (m as { toolName?: string }).toolName === "Agent",
  );
  return ((msg?.content ?? []) as Array<{ text?: string }>).map((b) => b.text ?? "").join("");
}

vi.setConfig({ testTimeout: 30_000 });

// Not matched by pi's transient-error patterns → no auto-retry, deterministic.
const FATAL = "invalid request: provider rejected the prompt";

describe("issue #144 — empty-error final turns must not be 'completed'", () => {
  let run: PrintModeRun | undefined;
  afterEach(async () => {
    await run?.dispose();
    run = undefined;
  });

  it("a run whose ONLY turn errors with no output is a failure, not an empty success", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ description: "doomed", prompt: "Do work." }),
        parentFinal: "parent done",
        // The child's one and only turn: provider error, zero content.
        subagent: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }),
      }),
    });

    // DESIRED: the orchestrator sees a failure naming the provider error —
    // not a clean success reading "No output.".
    const toolResult = agentToolResult(run.parentSession);
    expect(toolResult).toContain(FATAL);
    expect(toolResult).not.toContain("No output.");
  });

  it("an earlier turn's text must not mask a failed final turn as a fresh success", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ description: "masked", prompt: "Do work." }),
        parentFinal: "parent done",
        subagent: (ctx) => {
          const hasToolResult = ctx.messages.some((m) => m.role === "toolResult");
          // Turn 1: real text + a tool call. Turn 2 (after the tool result):
          // provider error with zero content.
          return hasToolResult
            ? fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL })
            : fauxAssistantMessage([
                fauxText("EARLIER-PARTIAL-TEXT"),
                fauxToolCall("bash", { command: "echo hi" }),
              ]);
        },
      }),
    });

    // The orchestrator sees the failure (not the earlier text as a clean
    // answer), AND the partial output is salvaged, clearly labeled as
    // pre-failure so it can't be mistaken for the final answer.
    const toolResult = agentToolResult(run.parentSession);
    expect(toolResult).toContain(FATAL);
    expect(toolResult).toContain("Partial output before the failure:");
    expect(toolResult).toContain("EARLIER-PARTIAL-TEXT");
    // The failure headline comes before the salvaged partial output.
    expect(toolResult.indexOf(FATAL)).toBeLessThan(toolResult.indexOf("EARLIER-PARTIAL-TEXT"));
  });

  it("a pure empty-error run shows no 'partial output' section", async () => {
    run = await runPrintMode({
      prompt: "Delegate.",
      respond: routeBySession({
        parentInitial: agentCall({ description: "empty", prompt: "Do work." }),
        parentFinal: "parent done",
        subagent: () => fauxAssistantMessage([], { stopReason: "error", errorMessage: FATAL }),
      }),
    });

    const toolResult = agentToolResult(run.parentSession);
    expect(toolResult).toContain(FATAL);
    expect(toolResult).not.toContain("Partial output before the failure:");
  });
});
