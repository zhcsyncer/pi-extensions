import type {
  ExtensionAPI,
  MessageRenderOptions,
  Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type {
  GatingMode,
  ReviewerRoute,
  ReviewTargetPreflight,
  ReviewTargetRequest,
} from "../types.ts";
import { persistStandaloneAudit } from "./audit-store.ts";
import { safeReviewDiagnosticText } from "./headless-output.ts";

export const ADVERSARIAL_REVIEW_CANCELLATION_TYPE = "adversarial-review-cancellation";

export interface SerializedReviewerRouteIdentity {
  key: string;
  provider: string;
  modelId: string;
  thinking: ReviewerRoute["thinking"];
  thinkingSource: ReviewerRoute["thinkingSource"];
  ordinal: number;
}

export interface ReviewFreezeCancellationAudit {
  version: 1;
  status: "cancelled";
  phase: "freeze";
  target: {
    request: ReviewTargetRequest;
    preflight: ReviewTargetPreflight;
  };
  requestedRoutes: SerializedReviewerRouteIdentity[];
  refuteRequested: boolean;
  refuterRoute?: SerializedReviewerRouteIdentity;
  gating: GatingMode;
  startedAt: string;
  cancelledAt: string;
}

function routeIdentity(route: ReviewerRoute): SerializedReviewerRouteIdentity {
  return {
    key: route.key,
    provider: route.provider,
    modelId: route.modelId,
    thinking: route.thinking,
    thinkingSource: route.thinkingSource,
    ordinal: route.ordinal,
  };
}

export function buildReviewFreezeCancellationAudit(options: {
  target: ReviewTargetRequest;
  preflight: ReviewTargetPreflight;
  requestedRoutes: ReviewerRoute[];
  refuteRequested: boolean;
  refuterRoute?: ReviewerRoute;
  gating: GatingMode;
  startedAt: Date;
  cancelledAt?: Date;
}): ReviewFreezeCancellationAudit {
  return {
    version: 1,
    status: "cancelled",
    phase: "freeze",
    target: {
      request: options.target,
      preflight: options.preflight,
    },
    requestedRoutes: options.requestedRoutes.map(routeIdentity),
    refuteRequested: options.refuteRequested,
    ...(options.refuterRoute ? { refuterRoute: routeIdentity(options.refuterRoute) } : {}),
    gating: options.gating,
    startedAt: options.startedAt.toISOString(),
    cancelledAt: (options.cancelledAt ?? new Date()).toISOString(),
  };
}

function isFreezeCancellationAudit(value: unknown): value is ReviewFreezeCancellationAudit {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 &&
    candidate.status === "cancelled" &&
    candidate.phase === "freeze" &&
    Array.isArray(candidate.requestedRoutes) &&
    typeof candidate.startedAt === "string" &&
    typeof candidate.cancelledAt === "string";
}

export function renderReviewFreezeCancellationMessage(
  details: unknown,
  options: MessageRenderOptions,
  theme: Theme,
): Component {
  if (!isFreezeCancellationAudit(details)) {
    return new Text(
      theme.fg("warning", "Adversarial review cancellation (invalid details)"),
      options.outputPad,
      0,
    );
  }
  const text = theme.fg(
    "warning",
    `Review cancelled during input freeze · ${details.requestedRoutes.length} routes not started`,
  );
  return new Text(text, options.outputPad, 0);
}

export interface PublishFreezeCancellationResult {
  message: string;
  auditPath?: string;
  deliveryWarning?: string;
}

/** Persist a truthful pre-freeze cancellation without inventing frozen-input or route results. */
export function publishReviewFreezeCancellation(options: {
  pi: ExtensionAPI;
  mode: "tui" | "rpc" | "json" | "print";
  audit: ReviewFreezeCancellationAudit;
  sessionId?: string;
  cwd?: string;
  agentDir?: string;
}): PublishFreezeCancellationResult {
  const message = "Adversarial review: cancelled while freezing input; no reviewer was started.";
  const warnings: string[] = [];
  let auditPath: string | undefined;

  try {
    auditPath = persistStandaloneAudit({
      kind: "cancellation",
      mode: options.mode,
      payload: options.audit,
      ...(options.sessionId ? { sessionId: options.sessionId } : {}),
      ...(options.cwd ? { cwd: options.cwd } : {}),
      ...(options.agentDir ? { agentDir: options.agentDir } : {}),
    });
  } catch (error) {
    warnings.push(`Cancellation audit could not be persisted: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }

  try {
    options.pi.appendEntry(ADVERSARIAL_REVIEW_CANCELLATION_TYPE, options.audit);
  } catch (error) {
    warnings.push(`Cancellation session entry could not be appended: ${
      error instanceof Error ? error.message : String(error)
    }`);
  }

  if (options.mode === "print" || options.mode === "json") {
    console.error(message);
    for (const warning of warnings) console.error(safeReviewDiagnosticText(warning));
    if (process.exitCode === undefined || process.exitCode === 0) process.exitCode = 1;
  }

  return {
    message,
    ...(auditPath ? { auditPath } : {}),
    ...(warnings.length > 0
      ? { deliveryWarning: safeReviewDiagnosticText(warnings.join(" ")) }
      : {}),
  };
}
