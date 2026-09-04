import {
  type EntryRenderOptions,
  type ExtensionAPI,
  type Theme,
} from "@earendil-works/pi-coding-agent";
import { Text, type Component } from "@earendil-works/pi-tui";
import type {
  FrozenReviewInput,
  GatingMode,
  ReviewerRoute,
} from "../types.ts";
import type { ReviewRuntimeCapabilities } from "../runtime/types.ts";
import type { SerializedReviewerRouteIdentity } from "./publish-cancellation.ts";
import { headMarker } from "./format.ts";
import { safeReviewDiagnosticText } from "./headless-output.ts";

export const ADVERSARIAL_REVIEW_DISPATCH_TYPE = "adversarial-review-dispatch";

export interface ReviewDispatchEntry {
  version: 1;
  status: "dispatched";
  runId: string;
  target: {
    description: string;
    inputSha256: string;
    headSha?: string;
    baseSha?: string;
    fromSha?: string;
    toSha?: string;
  };
  input: {
    bytes: number;
    lines: number;
    files: number;
  };
  requestedRoutes: SerializedReviewerRouteIdentity[];
  refuteRequested: boolean;
  refuterRoute?: SerializedReviewerRouteIdentity;
  gating: GatingMode;
  runtime: {
    backend: ReviewRuntimeCapabilities["backend"];
    maxConcurrent: number;
    persistRouteSessions?: boolean;
  };
  startedAt: string;
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

export function buildReviewDispatchEntry(options: {
  frozenInput: FrozenReviewInput;
  routes: ReviewerRoute[];
  refuteRequested: boolean;
  refuterRoute?: ReviewerRoute;
  gating: GatingMode;
  capabilities: ReviewRuntimeCapabilities;
  persistRouteSessions?: boolean;
  startedAt: Date;
}): ReviewDispatchEntry {
  return {
    version: 1,
    status: "dispatched",
    runId: options.frozenInput.runId,
    target: {
      description: options.frozenInput.target.description,
      inputSha256: options.frozenInput.inputSha256,
      headSha: options.frozenInput.target.headSha,
      ...(options.frozenInput.target.baseSha
        ? { baseSha: options.frozenInput.target.baseSha }
        : {}),
      ...(options.frozenInput.target.fromSha
        ? { fromSha: options.frozenInput.target.fromSha }
        : {}),
      ...(options.frozenInput.target.toSha
        ? { toSha: options.frozenInput.target.toSha }
        : {}),
    },
    input: {
      bytes: options.frozenInput.inputSize.bytes,
      lines: options.frozenInput.inputSize.lines,
      files: options.frozenInput.target.changedFiles.length,
    },
    requestedRoutes: options.routes.map(routeIdentity),
    refuteRequested: options.refuteRequested,
    ...(options.refuterRoute ? { refuterRoute: routeIdentity(options.refuterRoute) } : {}),
    gating: options.gating,
    runtime: {
      backend: options.capabilities.backend,
      maxConcurrent: options.capabilities.maxConcurrent,
      persistRouteSessions: options.persistRouteSessions === true,
    },
    startedAt: options.startedAt.toISOString(),
  };
}

function isReviewDispatchEntry(value: unknown): value is ReviewDispatchEntry {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Record<string, unknown>;
  return candidate.version === 1 &&
    candidate.status === "dispatched" &&
    typeof candidate.runId === "string" &&
    Array.isArray(candidate.requestedRoutes) &&
    typeof candidate.startedAt === "string";
}

export function renderReviewDispatchEntry(
  data: unknown,
  options: EntryRenderOptions,
  theme: Theme,
): Component {
  if (!isReviewDispatchEntry(data)) {
    return new Text(theme.fg("warning", "Adversarial review dispatch (invalid data)"), 1, 0);
  }
  const refute = data.refuteRequested ? " · refute" : "";
  const header = theme.fg(
    "accent",
    `● Adversarial review dispatched · ${data.requestedRoutes.length} reviewers${refute}` +
      headMarker(data.target.headSha),
  );
  if (!options.expanded) {
    return new Text(header, 1, 0);
  }
  const lines = [
    header,
    `  ${theme.fg("muted", "Routes")}`,
    ...data.requestedRoutes.map((route) => `    • ${safeReviewDiagnosticText(route.key)}`),
  ];
  if (data.refuterRoute) {
    lines.push(
      `  ${theme.fg("muted", "Refute")} · ${safeReviewDiagnosticText(data.refuterRoute.key)}`,
    );
  }
  lines.push(`  ${theme.fg("dim", `run ${safeReviewDiagnosticText(data.runId)}`)}`);
  return new Text(lines.join("\n"), 1, 0);
}

/** Persist a visible, non-model-context boundary immediately before reviewer spawn. */
export function publishReviewDispatch(
  pi: ExtensionAPI,
  entry: ReviewDispatchEntry,
): string | undefined {
  try {
    pi.appendEntry(ADVERSARIAL_REVIEW_DISPATCH_TYPE, entry);
    return undefined;
  } catch (error) {
    return `Review dispatch transcript entry could not be persisted: ${safeReviewDiagnosticText(
      error instanceof Error ? error.message : String(error),
    )}`;
  }
}
