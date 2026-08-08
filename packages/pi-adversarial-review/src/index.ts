import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseReviewCommand, ReviewCommandError } from "./command/parse-args.ts";
import { resolveReviewerRoutes } from "./command/resolve-routes.ts";
import { EmptyReviewInputError, prepareFrozenReviewInput } from "./input/freeze-input.ts";
import { runReviewerFleet } from "./runtime/orchestrator.ts";
import { loadReviewerSystemPrompt } from "./runtime/reviewer-assets.ts";
import { PiSubagentRpcV3Client, type PiEventBus } from "./runtime/rpc-v3-client.ts";
import type { ParsedReviewCommand, ReviewerRoute } from "./types.ts";

export const ADVERSARIAL_REVIEW_COMMAND = "adversarial-review";

export interface ReviewCommandPreflight {
  command: ParsedReviewCommand;
  routes: ReviewerRoute[];
}

export function preflightReviewCommand(
  args: string,
  ctx: ExtensionCommandContext,
): ReviewCommandPreflight {
  const command = parseReviewCommand(args);
  const routes = resolveReviewerRoutes(command.reviewerSpecs, ctx.scopedModels);
  return { command, routes };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function adversarialReviewExtension(pi: ExtensionAPI): void {
  let activeRun: AbortController | undefined;

  pi.registerCommand(ADVERSARIAL_REVIEW_COMMAND, {
    description: "Run deterministic multi-model adversarial code review",
    handler: async (args, ctx) => {
      if (activeRun) {
        ctx.ui.notify("Adversarial review: another review run is already active.", "error");
        return;
      }

      let frozenInput: Awaited<ReturnType<typeof prepareFrozenReviewInput>> | undefined;
      const controller = new AbortController();
      try {
        const { command, routes } = preflightReviewCommand(args, ctx);
        activeRun = controller;
        frozenInput = await prepareFrozenReviewInput({
          cwd: ctx.cwd,
          target: command.target,
          reqdoc: command.reqdoc,
          focus: command.focus,
        });
        const reviewerSystemPrompt = await loadReviewerSystemPrompt();
        const fleet = await runReviewerFleet({
          runtime: new PiSubagentRpcV3Client(pi.events as PiEventBus),
          routes,
          frozenInput,
          reviewerSystemPrompt,
          signal: controller.signal,
        });
        const drift = await frozenInput.recheck();
        const completed = fleet.routeResults.filter((result) => result.status === "completed").length;
        const safeRouteResults = fleet.routeResults.map((result) => ({
          route: result.route.key,
          status: result.status,
          report: result.report,
          error: result.error,
          durationMs: result.durationMs,
          usage: result.usage,
          rawOutput: result.rawOutput,
        }));
        pi.sendMessage({
          customType: "adversarial-review-route-report",
          content:
            `Adversarial review collected ${completed}/${routes.length} valid reviewer reports. ` +
            `${drift.stale ? "The target changed during review." : "The frozen target is still current."}`,
          display: true,
          details: {
            runId: frozenInput.runId,
            target: frozenInput.target,
            maxConcurrent: fleet.capabilities.maxConcurrent,
            routeResults: safeRouteResults,
            stale: drift.stale,
            drift: drift.changed,
          },
        }, { deliverAs: "nextTurn" });
        ctx.ui.notify(`Adversarial review collected ${completed}/${routes.length} valid reports.`, "info");
      } catch (error) {
        const type = error instanceof EmptyReviewInputError ? "info" : "error";
        const prefix = error instanceof ReviewCommandError ? "Adversarial review" : "Adversarial review failed";
        ctx.ui.notify(`${prefix}: ${errorMessage(error)}`, type);
      } finally {
        if (frozenInput) {
          try {
            await frozenInput.cleanup();
          } catch (error) {
            ctx.ui.notify(`Adversarial review cleanup warning: ${errorMessage(error)}`, "warning");
          }
        }
        if (activeRun === controller) activeRun = undefined;
      }
    },
  });

  pi.on("session_shutdown", async () => {
    activeRun?.abort(new Error("Pi session shut down"));
    activeRun = undefined;
  });
}
