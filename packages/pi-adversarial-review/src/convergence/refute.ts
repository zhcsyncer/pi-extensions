import type {
  MergedReviewReport,
  RefuteRouteResult,
  ReviewerRoute,
} from "../types.ts";
import type { ReviewRuntimeCapabilities } from "../runtime/types.ts";

export interface AttachRefuteResultsOptions {
  report: MergedReviewReport;
  refuterRoute: ReviewerRoute;
  routeResults: readonly RefuteRouteResult[];
  capabilities: ReviewRuntimeCapabilities;
  stale: boolean;
  cancelled: boolean;
  completedAt?: Date;
}

/**
 * Attach refute evidence without changing or removing a blocking finding.
 * A refuter can make a finding contested, never approved.
 */
export function attachRefuteResults(options: AttachRefuteResultsOptions): MergedReviewReport {
  if (
    options.capabilities.protocolVersion !== 3 ||
    !Number.isInteger(options.capabilities.maxConcurrent) ||
    options.capabilities.maxConcurrent < 1
  ) {
    throw new Error("Invalid refute runtime capabilities.");
  }

  const seen = new Set<number>();
  const routeResults = [...options.routeResults]
    .sort((left, right) => left.findingIndex - right.findingIndex)
    .map((result) => {
      if (
        !Number.isInteger(result.findingIndex) ||
        result.findingIndex < 0 ||
        result.findingIndex >= options.report.blocking.length
      ) {
        throw new Error(`Invalid refute finding index: ${result.findingIndex}.`);
      }
      if (seen.has(result.findingIndex)) {
        throw new Error(`Duplicate refute finding index: ${result.findingIndex}.`);
      }
      seen.add(result.findingIndex);
      return result;
    });

  const contested = routeResults.flatMap((result) => {
    if (result.status !== "completed" || !result.report?.refuted) return [];
    return [{
      findingIndex: result.findingIndex,
      finding: options.report.blocking[result.findingIndex],
      refuterRoute: result.route,
      reason: result.report.reason,
      evidence: result.report.evidence,
    }];
  });

  const stale = options.report.stale || options.stale;
  let overall = options.report.overall;
  if (stale) overall = "stale";
  if (options.cancelled) overall = "cancelled";

  return {
    ...options.report,
    overall,
    stale,
    refuteRequested: true,
    refuterRoute: options.refuterRoute,
    refuteRuntime: {
      ...options.capabilities,
      waves: Math.ceil(options.report.blocking.length / options.capabilities.maxConcurrent),
    },
    refuteResults: routeResults,
    contested,
    completedAt: (options.completedAt ?? new Date()).toISOString(),
  };
}
