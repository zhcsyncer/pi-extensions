import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export type GatingMode = "weighted" | "strict";

export type ReviewTargetRequest =
  | { mode: "local" }
  | { mode: "base"; baseRef: string }
  | { mode: "range"; fromRef: string; toRef: string };

export interface ParsedReviewCommand {
  target: ReviewTargetRequest;
  reviewerSpecs: string[];
  reqdoc?: string;
  focus?: string;
  gating: GatingMode;
}

export interface ScopedModelEntry {
  model: Model<any>;
  thinkingLevel?: ModelThinkingLevel;
}

export interface ReviewerRoute {
  key: string;
  model: Model<any>;
  provider: string;
  modelId: string;
  thinking: ModelThinkingLevel;
  thinkingSource: "scope-pinned" | "user";
  ordinal: number;
}

export type FindingSeverity = "critical" | "high" | "medium" | "low";
export type FindingCategory =
  | "auth"
  | "data-integrity"
  | "concurrency"
  | "failure-recovery"
  | "compatibility"
  | "observability"
  | "correctness"
  | "security"
  | "performance"
  | "other";

export interface Finding {
  file: string;
  lineStart: number;
  lineEnd: number;
  severity: FindingSeverity;
  category: FindingCategory;
  confidence: number;
  invariant: string;
  issue: string;
  evidence: string;
  recommendation: string;
}

export interface ReviewReport {
  verdict: "needs-attention" | "approve";
  summary: string;
  findings: Finding[];
}

export type ReviewerRouteStatus =
  | "queued"
  | "running"
  | "completed"
  | "errored"
  | "timed-out"
  | "cancelled"
  | "invalid-output";

export interface ReviewerRouteResult {
  route: ReviewerRoute;
  status: ReviewerRouteStatus;
  agentId?: string;
  report?: ReviewReport;
  rawOutput?: string;
  error?: string;
  durationMs?: number;
  usage?: { input?: number; output?: number; total?: number };
}

export interface ReviewTarget {
  mode: ReviewTargetRequest["mode"];
  description: string;
  root: string;
  headSha: string;
  baseSha?: string;
  fromSha?: string;
  toSha?: string;
  statusSha256: string;
  targetSha256: string;
  changedFiles: string[];
}

export interface ReviewInputDrift {
  stale: boolean;
  changed: Array<"head" | "status" | "target">;
}

export interface FrozenReviewInput {
  runId: string;
  target: ReviewTarget;
  reviewerCwd: string;
  inputPath: string;
  charterSource: "builtin";
  charterSha256: string;
  limitedContext: string[];
  recheck(): Promise<ReviewInputDrift>;
  cleanup(): Promise<void>;
}

export interface MergedFinding {
  file: string;
  lineStart: number;
  lineEnd: number;
  severity: FindingSeverity;
  category: FindingCategory;
  confidence: number;
  invariant: string;
  issue: string;
  evidence: string[];
  recommendation: string;
  reviewers: string[];
  votes: number;
  sourceFindingIndexes: Array<{ routeKey: string; findingIndex: number }>;
}

export interface MergedReviewReport {
  version: 1;
  runId: string;
  target: ReviewTarget;
  charterSource: string;
  charterSha256: string;
  requestedRoutes: ReviewerRoute[];
  routeResults: ReviewerRouteResult[];
  successfulReviewerCount: number;
  minSuccessfulReviewerCount: number;
  consensusThreshold: number;
  gating: GatingMode;
  overall:
    | "candidate-approve"
    | "needs-adjudication"
    | "inconclusive"
    | "stale"
    | "cancelled"
    | "failed";
  blocking: MergedFinding[];
  advisory: MergedFinding[];
  contested: never[];
  stale: boolean;
  limitedContext: string[];
  startedAt: string;
  completedAt: string;
}
