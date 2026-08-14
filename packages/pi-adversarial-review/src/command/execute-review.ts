import type {
  ExtensionAPI,
  ExtensionCommandContext,
} from "@earendil-works/pi-coding-agent";
import { buildMergedReviewReport } from "../convergence/gate.ts";
import { attachRefuteResults } from "../convergence/refute.ts";
import { prepareFrozenReviewInput } from "../input/freeze-input.ts";
import { ReviewInputError } from "../input/errors.ts";
import {
  emitHeadlessDiagnostic,
  safeReviewDiagnosticText,
} from "../output/headless-output.ts";
import {
  buildReviewFreezeCancellationAudit,
  publishReviewFreezeCancellation,
} from "../output/publish-cancellation.ts";
import {
  publishMergedReviewReport,
  summarizeRefuteStatus,
} from "../output/publish-report.ts";
import {
  buildReviewDispatchEntry,
  publishReviewDispatch,
} from "../output/run-transcript.ts";
import {
  revalidateReviewPreflight,
  type ResolvedReviewPreflight,
} from "../preflight/resolve-preflight.ts";
import {
  DEFAULT_REVIEWER_MAX_TURNS,
  DEFAULT_REVIEWER_OVERALL_TIMEOUT_MS,
  DEFAULT_REVIEWER_ROUTE_TIMEOUT_MS,
  LARGE_REVIEWER_MAX_TURNS,
  LARGE_REVIEWER_OVERALL_TIMEOUT_MS,
  LARGE_REVIEWER_ROUTE_TIMEOUT_MS,
  runReviewerFleet,
} from "../runtime/orchestrator.ts";
import {
  DEFAULT_REFUTER_MAX_TURNS,
  DEFAULT_REFUTER_OVERALL_TIMEOUT_MS,
  DEFAULT_REFUTER_ROUTE_TIMEOUT_MS,
  LARGE_REFUTER_MAX_TURNS,
  LARGE_REFUTER_OVERALL_TIMEOUT_MS,
  LARGE_REFUTER_ROUTE_TIMEOUT_MS,
  runRefuteFleet,
} from "../runtime/refute-orchestrator.ts";
import {
  loadRefuterSystemPrompt,
  loadReviewerSystemPrompt,
} from "../runtime/reviewer-assets.ts";
import type { ResolvedReviewRuntime } from "../runtime/resolve-runtime.ts";
import type {
  FrozenReviewInput,
  ParsedReviewCommand,
  ReviewerRoute,
} from "../types.ts";
import type { ReviewRunStatus } from "../ui/run-status.ts";

export interface ExecuteReviewRunOptions {
  pi: ExtensionAPI;
  ctx: ExtensionCommandContext;
  command: ParsedReviewCommand;
  targetPreflight: ResolvedReviewPreflight;
  routes: ReviewerRoute[];
  refuteRequested: boolean;
  refuterRoute?: ReviewerRoute;
  controller: AbortController;
  startedAt: Date;
  runStatus?: ReviewRunStatus;
  ensureRuntime(): Promise<ResolvedReviewRuntime>;
  revalidate: typeof revalidateReviewPreflight;
  sessionShuttingDown(): boolean;
  retainFrozenInput(input: FrozenReviewInput): void;
}

/** Execute one already-selected review pipeline; caller retains lifecycle cleanup ownership. */
export async function executeReviewRun(options: ExecuteReviewRunOptions): Promise<void> {
  const {
    pi,
    ctx,
    command,
    targetPreflight,
    routes,
    refuteRequested,
    refuterRoute,
    controller,
    startedAt,
  } = options;
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
      refuteRequested,
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
  let capabilities: ResolvedReviewRuntime["capabilities"];
  try {
    // Resolve backend/assets before the final guard so its comparison remains
    // immediately adjacent to the first possible spawn.
    const selectedRuntime = await options.ensureRuntime();
    runtime = selectedRuntime.runtime;
    capabilities = selectedRuntime.capabilities;
    options.runStatus?.runtime(capabilities.backend);
    reviewerSystemPrompt = await loadReviewerSystemPrompt();
    let stable = true;
    if (!controller.signal.aborted) {
      try {
        stable = await options.revalidate(targetPreflight, {
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
    options.retainFrozenInput(candidateInput);
    options.runStatus?.frozen(candidateInput);
  } catch (error) {
    await candidateInput.cleanup();
    throw error;
  }

  const frozenInput = candidateInput;
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

  const dispatchWarning = publishReviewDispatch(pi, buildReviewDispatchEntry({
    frozenInput,
    routes,
    refuteRequested,
    ...(refuterRoute ? { refuterRoute } : {}),
    gating: command.gating,
    capabilities,
    startedAt,
  }));
  if (dispatchWarning) {
    emitHeadlessDiagnostic(ctx.mode, dispatchWarning);
    ctx.ui.notify(dispatchWarning, "warning");
  }

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
    onProgress: (progress) => options.runStatus?.update(progress),
  });
  if (options.sessionShuttingDown()) return;
  const drift = await frozenInput.recheck();
  if (options.sessionShuttingDown()) return;
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
    refuteRequested,
    refuterRoute,
    gating: command.gating,
    stale: drift.stale,
    cancelled: controller.signal.aborted,
    limitedContext: frozenInput.limitedContext,
    startedAt,
  });
  options.runStatus?.gate({
    gating: report.gating,
    overall: report.overall,
    validReviewers: report.successfulReviewerCount,
    totalReviewers: routes.length,
    blocking: report.blocking.length,
    advisory: report.advisory.length,
  });

  const refuteEligible = refuteRequested &&
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
      onProgress: (progress) => options.runStatus?.update(progress),
    });
    if (options.sessionShuttingDown()) return;
    const finalDrift = await frozenInput.recheck();
    if (options.sessionShuttingDown()) return;
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
    options.runStatus?.refute({
      state: "completed",
      valid: refuteFleet.routeResults.filter((result) => result.status === "completed").length,
      total: refuteFleet.routeResults.length,
      contested: report.contested.length,
    });
  } else if (!refuteRequested) {
    options.runStatus?.refute({ state: "disabled" });
  } else {
    options.runStatus?.refute({
      state: "skipped",
      reason: refuterRoute === undefined
        ? "no-route"
        : report.blocking.length === 0 ? "no-blocking" : "review-ineligible",
      overall: report.overall,
    });
  }

  options.runStatus?.publishing();
  const published = publishMergedReviewReport(pi, report, ctx.mode, {
    sessionId: ctx.sessionManager.getSessionId(),
    cwd: ctx.cwd,
  });
  const completionMessage = safeReviewDiagnosticText(
    `${published.deliveryWarning ??
      `Adversarial review: ${report.overall} (${report.successfulReviewerCount}/${routes.length} valid).`} ` +
      summarizeRefuteStatus(report).notification,
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
}
