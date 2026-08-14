import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { matchesKey } from "@earendil-works/pi-tui";
import { parseReviewCommand, ReviewCommandError } from "./command/parse-args.ts";
import { executeReviewRun } from "./command/execute-review.ts";
import {
  resolveMainSessionRefuterRoute,
  resolveRefuterRoute,
  resolveReviewerRoutes,
} from "./command/resolve-routes.ts";
import {
  EmptyReviewInputError,
  ReviewInputError,
} from "./input/errors.ts";
import {
  ADVERSARIAL_REVIEW_ERROR_TYPE,
  emitHeadlessDiagnostic,
  publishReviewFailure,
  renderReviewFailureEntry,
  safeReviewDiagnosticText,
} from "./output/headless-output.ts";
import {
  ADVERSARIAL_REVIEW_CANCELLATION_TYPE,
  renderReviewFreezeCancellationEntry,
  renderReviewFreezeCancellationMessage,
} from "./output/publish-cancellation.ts";
import {
  ADVERSARIAL_REVIEW_MESSAGE_TYPE,
  ADVERSARIAL_REVIEW_RESULT_TYPE,
  renderMergedReviewEntry,
  renderMergedReviewMessage,
} from "./output/publish-report.ts";
import {
  ADVERSARIAL_REVIEW_DISPATCH_TYPE,
  renderReviewDispatchEntry,
} from "./output/run-transcript.ts";
import {
  resolveReviewPreflight,
  revalidateReviewPreflight,
  type ResolvedReviewPreflight,
  type ResolveReviewPreflightOptions,
} from "./preflight/resolve-preflight.ts";
import {
  resolveReviewRuntime,
  type ResolvedReviewRuntime,
  type ResolveReviewRuntimeOptions,
} from "./runtime/resolve-runtime.ts";
import type { PiEventBus } from "./runtime/rpc-v3-client.ts";
import type { ReviewRuntimeCapabilities } from "./runtime/types.ts";
import type {
  FrozenReviewInput,
  ParsedReviewCommand,
  ReviewerRoute,
} from "./types.ts";
import {
  pickInteractiveReviewSetup,
  pickRefuterSpec,
  retainValidRefuterSpec,
  retainValidReviewerSpecs,
} from "./ui/reviewer-picker.ts";
import {
  createReviewRunStatus,
  type ReviewRunStatus,
  runWithTuiCancellation,
} from "./ui/run-status.ts";

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
  pi.registerEntryRenderer(ADVERSARIAL_REVIEW_DISPATCH_TYPE, (entry, options, theme) => (
    renderReviewDispatchEntry(entry.data, options, theme)
  ));
  pi.registerEntryRenderer(ADVERSARIAL_REVIEW_RESULT_TYPE, (entry, options, theme) => (
    renderMergedReviewEntry(entry.data, options, theme)
  ));
  pi.registerEntryRenderer(ADVERSARIAL_REVIEW_CANCELLATION_TYPE, (entry, options, theme) => (
    renderReviewFreezeCancellationEntry(entry.data, options, theme)
  ));
  pi.registerEntryRenderer(ADVERSARIAL_REVIEW_ERROR_TYPE, (entry, options, theme) => (
    renderReviewFailureEntry(entry.data, options, theme)
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

      let frozenInput: FrozenReviewInput | undefined;
      let resolvedRuntime: ResolvedReviewRuntime | undefined;
      let runStatus: ReviewRunStatus | undefined;
      const controller = new AbortController();
      let resolveRunCompletion!: () => void;
      const runCompletion = new Promise<void>((resolve) => { resolveRunCompletion = resolve; });
      activeRun = controller;
      activeRunCompletion = runCompletion;
      try {
        const command = parseReviewCommand(args);
        if (command.interactiveRange && ctx.mode !== "tui") {
          throw new ReviewCommandError(
            'Interactive --range requires TUI mode. Outside TUI, pass --range "<refA>..<refB>".',
          );
        }
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
              ...(command.interactiveRange ? { interactiveRange: true } : {}),
              allowLarge: command.allowLarge,
              ...(command.reqdoc ? { reqdoc: command.reqdoc } : {}),
              ...(command.focus !== undefined ? { focus: command.focus } : {}),
              signal: controller.signal,
            });
          } finally {
            removePreflightInput();
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
        let refuteRequested = command.refute;
        let refuterSpec = command.refuterSpec;
        const mainSessionThinking = ctx.thinkingLevel ?? (
          typeof pi.getThinkingLevel === "function" ? pi.getThinkingLevel() : undefined
        );
        let mainSessionRefuterRoute: ReviewerRoute | undefined;
        if (ctx.mode === "tui" && ctx.model && mainSessionThinking) {
          try {
            mainSessionRefuterRoute = resolveMainSessionRefuterRoute(
              ctx.model,
              mainSessionThinking,
            );
          } catch {
            // A transient or incompatible main-session route must not block the
            // reviewer picker. The interaction falls back to a scoped refuter.
          }
        }
        let useMainSessionRefuter = ctx.mode === "tui" && command.refute &&
          !refuterSpec && mainSessionRefuterRoute !== undefined;
        let chooseRefuterInteractively = ctx.mode === "tui" && command.refute &&
          !refuterSpec && mainSessionRefuterRoute === undefined;

        if (reviewerSpecs.length === 0) {
          // Prune memory as soon as this scope snapshot is observed. Cancelling the
          // picker must not let a removed route resurrect if it is re-added later.
          previousPickedReviewerSpecs = retainValidReviewerSpecs(
            previousPickedReviewerSpecs,
            ctx.scopedModels,
          );
          capabilities = (await ensureRuntime()).capabilities;
          const picked = await pickInteractiveReviewSetup({
            ctx,
            maxConcurrent: capabilities.maxConcurrent,
            previousSpecs: previousPickedReviewerSpecs,
            signal: controller.signal,
            ...(mainSessionRefuterRoute
              ? { mainSessionRefuterKey: mainSessionRefuterRoute.key }
              : {}),
            ...(preResolvedRefuterRoute
              ? { explicitRefuterKey: preResolvedRefuterRoute.key }
              : {}),
            refuteRequired: command.refute,
          });
          if (picked === undefined) {
            if (!controller.signal.aborted) {
              ctx.ui.notify("Adversarial review: reviewer selection cancelled.", "info");
            }
            return;
          }
          if (controller.signal.aborted) return;
          reviewerSpecs = picked.reviewerSpecs;
          previousPickedReviewerSpecs = [...picked.reviewerSpecs];
          refuteRequested = picked.refute !== "disabled";
          useMainSessionRefuter = picked.refute === "main-session";
          chooseRefuterInteractively = picked.refute === "choose-model";
        }

        if (chooseRefuterInteractively) {
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
          : useMainSessionRefuter
            ? mainSessionRefuterRoute
            : undefined);
        const startedAt = new Date();
        runStatus = ctx.mode === "tui"
          ? createReviewRunStatus(ctx, {
              totalRoutes: routes.length,
              targetSummary: targetPreflight.summary,
              startedAtMs: startedAt.getTime(),
            })
          : undefined;
        const executeReview = () => executeReviewRun({
          pi,
          ctx,
          command,
          targetPreflight,
          routes,
          refuteRequested,
          ...(refuterRoute ? { refuterRoute } : {}),
          controller,
          startedAt,
          ...(runStatus ? { runStatus } : {}),
          ensureRuntime,
          revalidate,
          sessionShuttingDown: () => sessionShuttingDown,
          retainFrozenInput: (input) => { frozenInput = input; },
        });

        if (ctx.mode === "tui") {
          await runWithTuiCancellation(ctx, controller, executeReview);
        } else {
          await executeReview();
        }
      } catch (error) {
        if (sessionShuttingDown) return;
        runStatus?.failed();
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
          ...(frozenInput ? {
            runId: frozenInput.runId,
            target: frozenInput.target.description,
          } : {}),
        });
        ctx.ui.notify(message, type);
      } finally {
        // Frozen input and any detached review worktree must remain readable until every
        // reviewer/refuter has terminated. Runtime disposal is therefore the first barrier.
        runStatus?.cleanup("running");
        let cleanupRetained = false;
        let runtimeCleanupComplete = true;
        if (resolvedRuntime) {
          try {
            await resolvedRuntime.dispose();
          } catch (error) {
            runtimeCleanupComplete = false;
            cleanupRetained = true;
            if (!sessionShuttingDown) {
              const warning = safeReviewDiagnosticText(
                `Adversarial review runtime cleanup warning: ${errorMessage(error)} ` +
                  "Frozen input and any detached review worktree were retained for safety.",
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
            cleanupRetained = true;
            if (!sessionShuttingDown) {
              const warning = safeReviewDiagnosticText(
                `Adversarial review cleanup warning: ${errorMessage(error)}`,
              );
              emitHeadlessDiagnostic(ctx.mode, warning);
              ctx.ui.notify(warning, "warning");
            }
          }
        }
        runStatus?.cleanup(cleanupRetained ? "retained" : "completed");
        runStatus?.dispose();
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
