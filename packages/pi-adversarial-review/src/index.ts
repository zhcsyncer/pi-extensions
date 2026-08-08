import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseReviewCommand, ReviewCommandError } from "./command/parse-args.ts";
import { resolveReviewerRoutes } from "./command/resolve-routes.ts";
import { buildMergedReviewReport } from "./convergence/gate.ts";
import { EmptyReviewInputError, prepareFrozenReviewInput } from "./input/freeze-input.ts";
import { publishMergedReviewReport } from "./output/publish-report.ts";
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
        const startedAt = new Date();
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
        const report = buildMergedReviewReport({
          runId: frozenInput.runId,
          target: frozenInput.target,
          charterSource: frozenInput.charterSource,
          charterSha256: frozenInput.charterSha256,
          requestedRoutes: routes,
          routeResults: fleet.routeResults,
          gating: command.gating,
          stale: drift.stale,
          cancelled: controller.signal.aborted,
          limitedContext: frozenInput.limitedContext,
          startedAt,
        });
        const published = publishMergedReviewReport(pi, report, ctx.mode);
        ctx.ui.notify(
          published.deliveryWarning ??
            `Adversarial review: ${report.overall} (${report.successfulReviewerCount}/${routes.length} valid).`,
          published.deliveryWarning
            ? "warning"
            : report.overall === "candidate-approve" ? "info" : "warning",
        );
      } catch (error) {
        const type = error instanceof EmptyReviewInputError ? "info" : "error";
        const prefix = error instanceof ReviewCommandError || error instanceof EmptyReviewInputError
          ? "Adversarial review"
          : "Adversarial review failed";
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
