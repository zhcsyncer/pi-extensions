import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { parseReviewCommand, ReviewCommandError } from "./command/parse-args.ts";
import {
  resolveRefuterRoute,
  resolveReviewerRoutes,
} from "./command/resolve-routes.ts";
import { buildMergedReviewReport } from "./convergence/gate.ts";
import { attachRefuteResults } from "./convergence/refute.ts";
import { EmptyReviewInputError, prepareFrozenReviewInput } from "./input/freeze-input.ts";
import { ReviewInputError } from "./input/errors.ts";
import {
  emitHeadlessDiagnostic,
  publishReviewFailure,
  safeReviewDiagnosticText,
} from "./output/headless-output.ts";
import {
  ADVERSARIAL_REVIEW_CANCELLATION_TYPE,
  buildReviewFreezeCancellationAudit,
  publishReviewFreezeCancellation,
  renderReviewFreezeCancellationMessage,
} from "./output/publish-cancellation.ts";
import {
  ADVERSARIAL_REVIEW_MESSAGE_TYPE,
  publishMergedReviewReport,
  renderMergedReviewMessage,
} from "./output/publish-report.ts";
import {
  resolveReviewPreflight,
  revalidateReviewPreflight,
  type ResolvedReviewPreflight,
  type ResolveReviewPreflightOptions,
} from "./preflight/resolve-preflight.ts";
import {
  DEFAULT_REVIEWER_MAX_TURNS,
  DEFAULT_REVIEWER_OVERALL_TIMEOUT_MS,
  DEFAULT_REVIEWER_ROUTE_TIMEOUT_MS,
  LARGE_REVIEWER_MAX_TURNS,
  LARGE_REVIEWER_OVERALL_TIMEOUT_MS,
  LARGE_REVIEWER_ROUTE_TIMEOUT_MS,
  runReviewerFleet,
} from "./runtime/orchestrator.ts";
import {
  DEFAULT_REFUTER_MAX_TURNS,
  DEFAULT_REFUTER_OVERALL_TIMEOUT_MS,
  DEFAULT_REFUTER_ROUTE_TIMEOUT_MS,
  LARGE_REFUTER_MAX_TURNS,
  LARGE_REFUTER_OVERALL_TIMEOUT_MS,
  LARGE_REFUTER_ROUTE_TIMEOUT_MS,
  runRefuteFleet,
} from "./runtime/refute-orchestrator.ts";
import {
  loadRefuterSystemPrompt,
  loadReviewerSystemPrompt,
} from "./runtime/reviewer-assets.ts";
import {
  resolveReviewRuntime,
  type ResolvedReviewRuntime,
  type ResolveReviewRuntimeOptions,
} from "./runtime/resolve-runtime.ts";
import type { PiEventBus } from "./runtime/rpc-v3-client.ts";
import type { ReviewRuntimeCapabilities } from "./runtime/types.ts";
import type { ParsedReviewCommand, ReviewerRoute } from "./types.ts";
import {
  pickRefuterSpec,
  pickReviewerSpecs,
  retainValidRefuterSpec,
  retainValidReviewerSpecs,
} from "./ui/reviewer-picker.ts";
import { createReviewRunStatus, runWithTuiCancellation } from "./ui/run-status.ts";

export const ADVERSARIAL_REVIEW_COMMAND = "adversarial-review";

export interface ReviewCommandPreflight {
  command: ParsedReviewCommand;
  routes: ReviewerRoute[];
  refuterRoute?: ReviewerRoute;
}

export function preflightReviewCommand(
  args: string,
  ctx: ExtensionCommandContext,
): ReviewCommandPreflight {
  const command = parseReviewCommand(args);
  const routes = resolveReviewerRoutes(command.reviewerSpecs, ctx.scopedModels);
  const refuterRoute = command.refuterSpec
    ? resolveRefuterRoute(command.refuterSpec, ctx.scopedModels)
    : undefined;
  return { command, routes, ...(refuterRoute ? { refuterRoute } : {}) };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export interface AdversarialReviewExtensionOptions {
  resolveRuntime?: (
    options: ResolveReviewRuntimeOptions,
  ) => Promise<ResolvedReviewRuntime>;
  resolvePreflight?: (
    options: ResolveReviewPreflightOptions,
  ) => Promise<ResolvedReviewPreflight | undefined>;
  revalidatePreflight?: typeof revalidateReviewPreflight;
}

export default function adversarialReviewExtension(
  pi: ExtensionAPI,
  extensionOptions: AdversarialReviewExtensionOptions = {},
): void {
  let activeRun: AbortController | undefined;
  let activeRunCompletion: Promise<void> | undefined;
  let previousPickedReviewerSpecs: string[] | undefined;
  let previousPickedRefuterSpec: string | undefined;
  let sessionShuttingDown = false;

  pi.registerMessageRenderer(ADVERSARIAL_REVIEW_MESSAGE_TYPE, (message, options, theme) => (
    renderMergedReviewMessage(message.details, options, theme)
  ));
  pi.registerMessageRenderer(ADVERSARIAL_REVIEW_CANCELLATION_TYPE, (message, options, theme) => (
    renderReviewFreezeCancellationMessage(message.details, options, theme)
  ));

  pi.registerCommand(ADVERSARIAL_REVIEW_COMMAND, {
    description: "Run deterministic multi-model adversarial code review",
    handler: async (args, ctx) => {
      if (activeRun) {
        const message = "Adversarial review: another review run is already active.";
        publishReviewFailure({
          pi,
          mode: ctx.mode,
          kind: "runtime",
          message,
          sessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
        });
        ctx.ui.notify(message, "error");
        return;
      }

      let frozenInput: Awaited<ReturnType<typeof prepareFrozenReviewInput>> | undefined;
      let resolvedRuntime: ResolvedReviewRuntime | undefined;
      const controller = new AbortController();
      let resolveRunCompletion!: () => void;
      const runCompletion = new Promise<void>((resolve) => { resolveRunCompletion = resolve; });
      activeRun = controller;
      activeRunCompletion = runCompletion;
      try {
        const command = parseReviewCommand(args);
        if (command.reviewerSpecs.length === 0 && ctx.mode !== "tui") {
          throw new ReviewCommandError(
            "Reviewer selection requires TUI mode. Outside TUI, pass at least two " +
              "--reviewer <provider/model>@<thinking> options.",
          );
        }
        if (command.reviewerSpecs.length === 0 && ctx.scopedModels.length === 0) {
          throw new ReviewCommandError(
            "No scoped models are configured. Use /scoped-models before adversarial review.",
          );
        }
        if (command.refute && command.refuterSpec === undefined && ctx.mode !== "tui") {
          throw new ReviewCommandError(
            "Refuter selection requires TUI mode. Outside TUI, pass " +
              "--refuter <provider/model>@<thinking> with --refute.",
          );
        }
        const preResolvedRoutes = command.reviewerSpecs.length > 0
          ? resolveReviewerRoutes(command.reviewerSpecs, ctx.scopedModels)
          : undefined;
        const preResolvedRefuterRoute = command.refuterSpec
          ? resolveRefuterRoute(command.refuterSpec, ctx.scopedModels)
          : undefined;
        const runTargetPreflight = async (): Promise<ResolvedReviewPreflight | undefined> => {
          let removePreflightInput = () => {};
          if (ctx.mode === "tui") {
            ctx.ui.setStatus("adversarial-review", "Adversarial review · checking Git target…");
            removePreflightInput = ctx.ui.onTerminalInput((data) => {
              if (matchesKey(data, "escape")) {
                controller.abort(new Error("Adversarial review preflight cancelled by user"));
              }
            });
          }
          try {
            return await (extensionOptions.resolvePreflight ?? resolveReviewPreflight)({
              ctx,
              target: command.target,
              targetExplicit: command.targetExplicit,
              allowLarge: command.allowLarge,
              ...(command.reqdoc ? { reqdoc: command.reqdoc } : {}),
              ...(command.focus !== undefined ? { focus: command.focus } : {}),
              signal: controller.signal,
            });
          } finally {
            removePreflightInput();
            if (ctx.mode === "tui") ctx.ui.setStatus("adversarial-review", undefined);
          }
        };
        let targetPreflight = await runTargetPreflight();
        if (!targetPreflight) {
          if (!controller.signal.aborted) {
            ctx.ui.notify("Adversarial review: target selection cancelled.", "info");
          }
          return;
        }
        if (controller.signal.aborted) return;
        ctx.ui.notify(targetPreflight.summary, "info");
        let capabilities: ReviewRuntimeCapabilities | undefined;
        const ensureRuntime = async () => {
          if (resolvedRuntime) return resolvedRuntime;
          resolvedRuntime = await (extensionOptions.resolveRuntime ?? resolveReviewRuntime)({
            pi,
            ctx,
            events: pi.events as PiEventBus,
          });
          capabilities = resolvedRuntime.capabilities;
          if (resolvedRuntime.warning) {
            const warning = safeReviewDiagnosticText(
              `Adversarial review: ${resolvedRuntime.warning}`,
            );
            emitHeadlessDiagnostic(ctx.mode, warning);
            ctx.ui.notify(warning, "warning");
          }
          return resolvedRuntime;
        };
        let reviewerSpecs = command.reviewerSpecs;

        if (reviewerSpecs.length === 0) {
          // Prune memory as soon as this scope snapshot is observed. Cancelling the
          // picker must not let a removed route resurrect if it is re-added later.
          previousPickedReviewerSpecs = retainValidReviewerSpecs(
            previousPickedReviewerSpecs,
            ctx.scopedModels,
          );
          capabilities = (await ensureRuntime()).capabilities;
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

        let refuterSpec = command.refuterSpec;
        if (command.refute && refuterSpec === undefined) {
          previousPickedRefuterSpec = retainValidRefuterSpec(
            previousPickedRefuterSpec,
            ctx.scopedModels,
          );
          capabilities ??= (await ensureRuntime()).capabilities;
          const picked = await pickRefuterSpec({
            ctx,
            previousSpec: previousPickedRefuterSpec,
            signal: controller.signal,
          });
          if (picked === undefined) {
            if (!controller.signal.aborted) {
              ctx.ui.notify("Adversarial review: refuter selection cancelled.", "info");
            }
            return;
          }
          if (controller.signal.aborted) return;
          refuterSpec = picked;
          previousPickedRefuterSpec = picked;
        }

        // The picker can remain open while another process changes HEAD/status
        // or starts a Git operation. Re-run preflight rather than applying the
        // old decision/audit to a different repository state.
        if (controller.signal.aborted) return;
        const revalidate = extensionOptions.revalidatePreflight ?? revalidateReviewPreflight;
        if (!await revalidate(targetPreflight, { signal: controller.signal })) {
          if (ctx.mode !== "tui") {
            throw new ReviewInputError(
              "Git state changed after adversarial review preflight. Retry with an explicit target.",
            );
          }
          ctx.ui.notify(
            "Adversarial review: Git changed while selecting models; running preflight again.",
            "warning",
          );
          const refreshed = await runTargetPreflight();
          if (!refreshed) {
            if (!controller.signal.aborted) {
              ctx.ui.notify("Adversarial review: target selection cancelled.", "info");
            }
            return;
          }
          targetPreflight = refreshed;
          ctx.ui.notify(targetPreflight.summary, "info");
        }

        // Shutdown can race with picker confirmation or explicit preflight. Do
        // not freeze input, remember routes, or publish into a closing session.
        if (controller.signal.aborted) return;
        const routes = preResolvedRoutes ?? resolveReviewerRoutes(reviewerSpecs, ctx.scopedModels);
        const refuterRoute = preResolvedRefuterRoute ?? (refuterSpec
          ? resolveRefuterRoute(refuterSpec, ctx.scopedModels)
          : undefined);
        const startedAt = new Date();
        const runStatus = ctx.mode === "tui"
          ? createReviewRunStatus(ctx, routes.length, startedAt.getTime())
          : undefined;
        const executeReview = async () => {
          let candidateInput: Awaited<ReturnType<typeof prepareFrozenReviewInput>>;
          try {
            candidateInput = await prepareFrozenReviewInput({
              cwd: ctx.cwd,
              target: targetPreflight.target,
              preflight: targetPreflight.audit,
              reqdoc: command.reqdoc,
              focus: command.focus,
              signal: controller.signal,
            });
          } catch (error) {
            if (!controller.signal.aborted || error !== controller.signal.reason) throw error;
            const cancellationAudit = buildReviewFreezeCancellationAudit({
              target: targetPreflight.target,
              preflight: targetPreflight.audit,
              requestedRoutes: routes,
              refuteRequested: command.refute,
              ...(refuterRoute ? { refuterRoute } : {}),
              gating: command.gating,
              startedAt,
            });
            const published = publishReviewFreezeCancellation({
              pi,
              mode: ctx.mode,
              audit: cancellationAudit,
              sessionId: ctx.sessionManager.getSessionId(),
              cwd: ctx.cwd,
            });
            ctx.ui.notify(
              published.deliveryWarning
                ? `${published.message} ${published.deliveryWarning}`
                : published.message,
              published.deliveryWarning ? "warning" : "info",
            );
            return;
          }
          let runtime: ResolvedReviewRuntime["runtime"];
          let reviewerSystemPrompt: string;
          try {
            // Resolve backend/assets before the final guard so its comparison
            // remains immediately adjacent to the first possible spawn.
            const selectedRuntime = await ensureRuntime();
            runtime = selectedRuntime.runtime;
            capabilities = selectedRuntime.capabilities;
            reviewerSystemPrompt = await loadReviewerSystemPrompt();
            // Once freezing succeeds, Escape must still produce the full
            // cancelled report. Skip guard failure and all reviewer spawns
            // through the aborted signal.
            let stable = true;
            if (!controller.signal.aborted) {
              try {
                stable = await revalidate(targetPreflight, {
                  signal: controller.signal,
                  frozenInput: candidateInput,
                });
              } catch (error) {
                if (!controller.signal.aborted) throw error;
              }
            }
            if (!controller.signal.aborted && !stable) {
              throw new ReviewInputError(
                "Git state changed while freezing adversarial review input. Retry the review.",
              );
            }
            frozenInput = candidateInput;
          } catch (error) {
            await candidateInput.cleanup();
            throw error;
          }
          const reviewerMaxTurns = targetPreflight.largeInput
            ? LARGE_REVIEWER_MAX_TURNS
            : DEFAULT_REVIEWER_MAX_TURNS;
          const refuterMaxTurns = targetPreflight.largeInput
            ? LARGE_REFUTER_MAX_TURNS
            : DEFAULT_REFUTER_MAX_TURNS;
          const reviewerRouteTimeoutMs = targetPreflight.largeInput
            ? LARGE_REVIEWER_ROUTE_TIMEOUT_MS
            : DEFAULT_REVIEWER_ROUTE_TIMEOUT_MS;
          const reviewerOverallTimeoutMs = targetPreflight.largeInput
            ? LARGE_REVIEWER_OVERALL_TIMEOUT_MS
            : DEFAULT_REVIEWER_OVERALL_TIMEOUT_MS;
          const refuterRouteTimeoutMs = targetPreflight.largeInput
            ? LARGE_REFUTER_ROUTE_TIMEOUT_MS
            : DEFAULT_REFUTER_ROUTE_TIMEOUT_MS;
          const refuterOverallTimeoutMs = targetPreflight.largeInput
            ? LARGE_REFUTER_OVERALL_TIMEOUT_MS
            : DEFAULT_REFUTER_OVERALL_TIMEOUT_MS;
          const fleet = await runReviewerFleet({
            runtime,
            routes,
            frozenInput,
            reviewerSystemPrompt,
            signal: controller.signal,
            capabilities,
            maxTurns: reviewerMaxTurns,
            routeTimeoutMs: reviewerRouteTimeoutMs,
            overallTimeoutMs: reviewerOverallTimeoutMs,
            onProgress: (progress) => runStatus?.update(progress),
          });
          if (sessionShuttingDown) return;
          const drift = await frozenInput.recheck();
          if (sessionShuttingDown) return;
          let report = buildMergedReviewReport({
            runId: frozenInput.runId,
            target: frozenInput.target,
            charterSource: frozenInput.charterSource,
            charterSha256: frozenInput.charterSha256,
            requestedRoutes: routes,
            routeResults: fleet.routeResults,
            runtimeCapabilities: fleet.capabilities,
            maxTurns: reviewerMaxTurns,
            routeTimeoutMs: reviewerRouteTimeoutMs,
            overallTimeoutMs: reviewerOverallTimeoutMs,
            refuteRequested: command.refute,
            refuterRoute,
            gating: command.gating,
            stale: drift.stale,
            cancelled: controller.signal.aborted,
            limitedContext: frozenInput.limitedContext,
            startedAt,
          });

          const refuteEligible = command.refute &&
            refuterRoute !== undefined &&
            report.blocking.length > 0 &&
            report.overall !== "cancelled" &&
            report.overall !== "stale" &&
            report.overall !== "failed";
          if (refuteEligible) {
            const refuterSystemPrompt = await loadRefuterSystemPrompt();
            const refuteFleet = await runRefuteFleet({
              runtime,
              refuterRoute,
              blocking: report.blocking,
              frozenInput,
              refuterSystemPrompt,
              capabilities: fleet.capabilities,
              signal: controller.signal,
              maxTurns: refuterMaxTurns,
              routeTimeoutMs: refuterRouteTimeoutMs,
              overallTimeoutMs: refuterOverallTimeoutMs,
              onProgress: (progress) => runStatus?.update(progress),
            });
            if (sessionShuttingDown) return;
            const finalDrift = await frozenInput.recheck();
            if (sessionShuttingDown) return;
            report = attachRefuteResults({
              report,
              refuterRoute,
              routeResults: refuteFleet.routeResults,
              capabilities: refuteFleet.capabilities,
              maxTurns: refuterMaxTurns,
              routeTimeoutMs: refuterRouteTimeoutMs,
              overallTimeoutMs: refuterOverallTimeoutMs,
              stale: finalDrift.stale,
              cancelled: controller.signal.aborted,
            });
          }

          const published = publishMergedReviewReport(pi, report, ctx.mode, {
            sessionId: ctx.sessionManager.getSessionId(),
            cwd: ctx.cwd,
          });
          const completionMessage = safeReviewDiagnosticText(
            published.deliveryWarning ??
              `Adversarial review: ${report.overall} (${report.successfulReviewerCount}/${routes.length} valid).`,
          );
          if (published.deliveryWarning) {
            emitHeadlessDiagnostic(ctx.mode, completionMessage);
            if (
              (ctx.mode === "print" || ctx.mode === "json") &&
              (process.exitCode === undefined || process.exitCode === 0)
            ) {
              process.exitCode = 1;
            }
          }
          ctx.ui.notify(
            completionMessage,
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
        if (controller.signal.aborted && error === controller.signal.reason) {
          ctx.ui.notify("Adversarial review: Git preflight cancelled.", "info");
          return;
        }
        const type = error instanceof EmptyReviewInputError ? "info" : "error";
        const prefix = error instanceof ReviewCommandError || error instanceof EmptyReviewInputError
          ? "Adversarial review"
          : "Adversarial review failed";
        const message = safeReviewDiagnosticText(`${prefix}: ${errorMessage(error)}`);
        publishReviewFailure({
          pi,
          mode: ctx.mode,
          kind: error instanceof EmptyReviewInputError
            ? "empty-input"
            : error instanceof ReviewCommandError
              ? "command"
              : error instanceof ReviewInputError ? "input" : "runtime",
          message,
          sessionId: ctx.sessionManager.getSessionId(),
          cwd: ctx.cwd,
        });
        ctx.ui.notify(message, type);
      } finally {
        // The frozen snapshot must remain readable until every reviewer/refuter
        // has actually terminated. Runtime disposal is therefore the first barrier.
        let runtimeCleanupComplete = true;
        if (resolvedRuntime) {
          try {
            await resolvedRuntime.dispose();
          } catch (error) {
            runtimeCleanupComplete = false;
            if (!sessionShuttingDown) {
              const warning = safeReviewDiagnosticText(
                `Adversarial review runtime cleanup warning: ${errorMessage(error)} ` +
                  "Frozen input retained for safety.",
              );
              emitHeadlessDiagnostic(ctx.mode, warning);
              ctx.ui.notify(warning, "warning");
            }
          }
        }
        if (frozenInput && runtimeCleanupComplete) {
          try {
            await frozenInput.cleanup();
          } catch (error) {
            if (!sessionShuttingDown) {
              const warning = safeReviewDiagnosticText(
                `Adversarial review cleanup warning: ${errorMessage(error)}`,
              );
              emitHeadlessDiagnostic(ctx.mode, warning);
              ctx.ui.notify(warning, "warning");
            }
          }
        }
        if (activeRun === controller) activeRun = undefined;
        if (activeRunCompletion === runCompletion) activeRunCompletion = undefined;
        resolveRunCompletion();
      }
    },
  });

  pi.on("session_shutdown", async () => {
    sessionShuttingDown = true;
    const completion = activeRunCompletion;
    activeRun?.abort(new Error("Pi session shut down"));
    await completion;
  });
}
