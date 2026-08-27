import {
  keyHint,
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
import { safeReviewDiagnosticText } from "./headless-output.ts";

export const ADVERSARIAL_REVIEW_DISPATCH_TYPE = "adversarial-review-dispatch";

export interface ReviewDispatchEntry {
  version: 1;
  status: "dispatched";
  runId: string;
  target: {
    description: string;
    inputSha256: string;
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

function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function expandHint(): string {
  try {
    const hint = keyHint("app.tools.expand", "details");
    return hint.trim() || "Ctrl+O details";
  } catch {
    return "Ctrl+O details";
  }
}

export function renderReviewDispatchEntry(
  data: unknown,
  options: EntryRenderOptions,
  theme: Theme,
): Component {
  if (!isReviewDispatchEntry(data)) {
    return new Text(theme.fg("warning", "Adversarial review dispatch (invalid data)"), 1, 0);
  }
  const target = safeReviewDiagnosticText(data.target.description).replace(/\s+/gu, " ").trim();
  const lines = [
    theme.fg(
      "accent",
      `● Adversarial review dispatched · ${data.requestedRoutes.length} reviewers · ${data.gating}`,
    ),
    `  ${theme.fg("muted", "Target")} · ${target}`,
  ];
  if (options.expanded) {
    lines.push(
      `  ${theme.fg("muted", "Input")} · ${formatBytes(data.input.bytes)} · ` +
        `${data.input.lines} lines · ${data.input.files} files`,
      `  ${theme.fg("muted", "Runtime")} · ${data.runtime.backend} · ` +
        `max concurrent ${data.runtime.maxConcurrent} · route sessions ` +
        `${data.runtime.persistRouteSessions === true ? "persisted" : "memory-only"}`,
      `  ${theme.fg("muted", "Routes")}`,
      ...data.requestedRoutes.map((route) => `    • ${safeReviewDiagnosticText(route.key)}`),
      `  ${theme.fg("muted", "Refute")} · ${data.refuteRequested
        ? data.refuterRoute
          ? `requested · ${safeReviewDiagnosticText(data.refuterRoute.key)}`
          : "requested · route pending"
        : "disabled"}`,
      `  ${theme.fg("muted", "Run")} · ${safeReviewDiagnosticText(data.runId)}`,
    );
  } else {
    lines.push(`  ${theme.fg("dim", expandHint())}`);
  }
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
