import type {
  GatingMode,
  MergedFinding,
  MergedReviewReport,
  ReviewTarget,
  ReviewerRoute,
  ReviewerRouteResult,
} from "../types.ts";
import { clusterReviewFindings, type ClusteringConfig } from "./cluster.ts";

export interface GatingConfig {
  minSuccessRatio: number;
  minConsensus: number;
  consensusRatio: number;
  singleHighConfidence: number;
}

export const DEFAULT_GATING_CONFIG: GatingConfig = {
  minSuccessRatio: 0.5,
  minConsensus: 2,
  consensusRatio: 0.5,
  singleHighConfidence: 0.85,
};

export function minSuccessfulReviewerCount(
  requestedCount: number,
  config: GatingConfig = DEFAULT_GATING_CONFIG,
): number {
  return Math.max(2, Math.ceil(requestedCount * config.minSuccessRatio));
}

export function findingConsensusThreshold(
  successfulCount: number,
  config: GatingConfig = DEFAULT_GATING_CONFIG,
): number {
  return Math.max(config.minConsensus, Math.ceil(successfulCount * config.consensusRatio));
}

function validateConfig(config: GatingConfig): void {
  if (
    config.minSuccessRatio <= 0 || config.minSuccessRatio > 1 ||
    !Number.isInteger(config.minConsensus) || config.minConsensus < 1 ||
    config.consensusRatio <= 0 || config.consensusRatio > 1 ||
    config.singleHighConfidence < 0 || config.singleHighConfidence > 1
  ) throw new Error("Invalid gating configuration.");
}

function isSingleHighException(finding: MergedFinding, config: GatingConfig): boolean {
  return (
    (finding.severity === "critical" || finding.severity === "high") &&
    finding.confidence >= config.singleHighConfidence
  );
}

export interface BuildMergedReviewReportOptions {
  runId: string;
  target: ReviewTarget;
  charterSource: string;
  charterSha256: string;
  requestedRoutes: ReviewerRoute[];
  routeResults: ReviewerRouteResult[];
  gating: GatingMode;
  stale: boolean;
  cancelled: boolean;
  limitedContext: string[];
  startedAt: Date;
  completedAt?: Date;
  gatingConfig?: GatingConfig;
  clusteringConfig?: ClusteringConfig;
}

export function buildMergedReviewReport(
  options: BuildMergedReviewReportOptions,
): MergedReviewReport {
  const config = options.gatingConfig ?? DEFAULT_GATING_CONFIG;
  validateConfig(config);
  const successful = options.routeResults.filter((result) => (
    result.status === "completed" && result.report !== undefined
  ));
  const successfulCount = successful.length;
  const minSuccessful = minSuccessfulReviewerCount(options.requestedRoutes.length, config);
  const consensusThreshold = findingConsensusThreshold(successfulCount, config);
  const clusters = clusterReviewFindings(successful, options.clusteringConfig);
  let blocking: MergedFinding[];
  let advisory: MergedFinding[];

  if (options.gating === "strict") {
    blocking = clusters;
    advisory = [];
  } else {
    blocking = clusters.filter((finding) => (
      finding.votes >= consensusThreshold || isSingleHighException(finding, config)
    ));
    advisory = clusters.filter((finding) => !blocking.includes(finding));
  }

  let overall: MergedReviewReport["overall"];
  if (successfulCount === 0) overall = "failed";
  else if (successfulCount < minSuccessful) overall = "inconclusive";
  else if (blocking.length > 0) overall = "needs-adjudication";
  else overall = "candidate-approve";
  if (options.stale) overall = "stale";
  if (options.cancelled) overall = "cancelled";

  return {
    version: 1,
    runId: options.runId,
    target: options.target,
    charterSource: options.charterSource,
    charterSha256: options.charterSha256,
    requestedRoutes: options.requestedRoutes,
    routeResults: options.routeResults,
    successfulReviewerCount: successfulCount,
    minSuccessfulReviewerCount: minSuccessful,
    consensusThreshold,
    gating: options.gating,
    overall,
    blocking,
    advisory,
    contested: [],
    stale: options.stale,
    limitedContext: options.limitedContext,
    startedAt: options.startedAt.toISOString(),
    completedAt: (options.completedAt ?? new Date()).toISOString(),
  };
}
