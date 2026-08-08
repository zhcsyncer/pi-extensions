import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { parseReviewCommand, ReviewCommandError } from "./command/parse-args.ts";
import { resolveReviewerRoutes } from "./command/resolve-routes.ts";
import { buildMergedReviewReport } from "./convergence/gate.ts";
import { EmptyReviewInputError, prepareFrozenReviewInput } from "./input/freeze-input.ts";
import { publishMergedReviewReport } from "./output/publish-report.ts";
import { runReviewerFleet } from "./runtime/orchestrator.ts";
import { loadReviewerSystemPrompt } from "./runtime/reviewer-assets.ts";
import { PiSubagentRpcV3Client, type PiEventBus } from "./runtime/rpc-v3-client.ts";
import type { ReviewRuntimeCapabilities } from "./runtime/types.ts";
import type { ParsedReviewCommand, ReviewerRoute } from "./types.ts";
import {
  pickReviewerSpecs,
  retainValidReviewerSpecs,
} from "./ui/reviewer-picker.ts";
import { createReviewRunStatus, runWithTuiCancellation } from "./ui/run-status.ts";

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
  let previousPickedReviewerSpecs: string[] | undefined;
  let sessionShuttingDown = false;

  pi.registerCommand(ADVERSARIAL_REVIEW_COMMAND, {
    description: "Run deterministic multi-model adversarial code review",
    handler: async (args, ctx) => {
      if (activeRun) {
        ctx.ui.notify("Adversarial review: another review run is already active.", "error");
        return;
      }

      let frozenInput: Awaited<ReturnType<typeof prepareFrozenReviewInput>> | undefined;
      const controller = new AbortController();
      activeRun = controller;
      try {
        const command = parseReviewCommand(args);
        const runtime = new PiSubagentRpcV3Client(pi.events as PiEventBus);
        let capabilities: ReviewRuntimeCapabilities | undefined;
        let reviewerSpecs = command.reviewerSpecs;

        if (reviewerSpecs.length === 0) {
          if (ctx.mode !== "tui") {
            throw new ReviewCommandError(
              "Reviewer selection requires TUI mode. Outside TUI, pass at least two " +
                "--reviewer <provider/model>@<thinking> options.",
            );
          }
          // Prune memory as soon as this scope snapshot is observed. Cancelling the
          // picker must not let a removed route resurrect if it is re-added later.
          previousPickedReviewerSpecs = retainValidReviewerSpecs(
            previousPickedReviewerSpecs,
            ctx.scopedModels,
          );
          capabilities = await runtime.getCapabilities();
          const picked = await pickReviewerSpecs({
            ctx,
            maxConcurrent: capabilities.maxConcurrent,
            previousSpecs: previousPickedReviewerSpecs,
            signal: controller.signal,
          });
          if (picked === undefined) {
            if (!controller.signal.aborted) {
              ctx.ui.notify("Adversarial review: reviewer selection cancelled.", "info");
            }
            return;
          }
          if (controller.signal.aborted) return;
          reviewerSpecs = picked;
          previousPickedReviewerSpecs = [...picked];
        }

        // Shutdown can race with picker confirmation or explicit preflight. Do
        // not freeze input, remember routes, or publish into a closing session.
        if (controller.signal.aborted) return;
        const routes = resolveReviewerRoutes(reviewerSpecs, ctx.scopedModels);
        const startedAt = new Date();
        const runStatus = ctx.mode === "tui"
          ? createReviewRunStatus(ctx, routes.length, startedAt.getTime())
          : undefined;
        const executeReview = async () => {
          frozenInput = await prepareFrozenReviewInput({
            cwd: ctx.cwd,
            target: command.target,
            reqdoc: command.reqdoc,
            focus: command.focus,
          });
          const reviewerSystemPrompt = await loadReviewerSystemPrompt();
          const fleet = await runReviewerFleet({
            runtime,
            routes,
            frozenInput,
            reviewerSystemPrompt,
            signal: controller.signal,
            capabilities,
            onProgress: (progress) => runStatus?.update(progress),
          });
          if (sessionShuttingDown) return;
          const drift = await frozenInput.recheck();
          if (sessionShuttingDown) return;
          const report = buildMergedReviewReport({
            runId: frozenInput.runId,
            target: frozenInput.target,
            charterSource: frozenInput.charterSource,
            charterSha256: frozenInput.charterSha256,
            requestedRoutes: routes,
            routeResults: fleet.routeResults,
            runtimeCapabilities: fleet.capabilities,
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
        };

        try {
          if (ctx.mode === "tui") {
            await runWithTuiCancellation(ctx, controller, executeReview);
          } else {
            await executeReview();
          }
        } finally {
          runStatus?.dispose();
        }
      } catch (error) {
        if (sessionShuttingDown) return;
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
            if (!sessionShuttingDown) {
              ctx.ui.notify(`Adversarial review cleanup warning: ${errorMessage(error)}`, "warning");
            }
          }
        }
        if (activeRun === controller) activeRun = undefined;
      }
    },
  });

  pi.on("session_shutdown", async () => {
    sessionShuttingDown = true;
    activeRun?.abort(new Error("Pi session shut down"));
  });
}
