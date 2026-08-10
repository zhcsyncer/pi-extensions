import type { Model, ModelThinkingLevel } from "@earendil-works/pi-ai";

export type GatingMode = "weighted" | "strict";

export type ReviewTargetRequest =
  | { mode: "local" }
  | { mode: "base"; baseRef: string }
  | { mode: "range"; fromRef: string; toRef: string };

export interface ParsedReviewCommand {
  target: ReviewTargetRequest;
  targetExplicit: boolean;
  reviewerSpecs: string[];
  reqdoc?: string;
  focus?: string;
  gating: GatingMode;
  allowLarge: boolean;
  refute: boolean;
  refuterSpec?: string;
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
  turnLimited?: boolean;
  durationMs?: number;
  usage?: { input?: number; output?: number; total?: number };
}

export interface VerifyReport {
  refuted: boolean;
  reason: string;
  evidence: string[];
}

export interface RefuteRouteResult {
  findingIndex: number;
  route: ReviewerRoute;
  status: ReviewerRouteStatus;
  agentId?: string;
  report?: VerifyReport;
  rawOutput?: string;
  error?: string;
  turnLimited?: boolean;
  durationMs?: number;
  usage?: { input?: number; output?: number; total?: number };
}

export interface ReviewTargetPreflight {
  selection: "explicit" | "inferred" | "interactive";
  fetchStatus: "succeeded" | "failed-used-local" | "not-needed";
  branch?: string;
  remote?: string;
  attemptedRemotes?: string[];
  fetchedRemotes?: string[];
  defaultBranchRef?: string;
  ahead?: number;
  behind?: number;
  inputBytes?: number;
  inputLines?: number;
  largeInput?: boolean;
  operation?: string;
  unmerged?: boolean;
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
  preflight?: ReviewTargetPreflight;
}

export interface ReviewInputDrift {
  stale: boolean;
  changed: Array<"head" | "status" | "target">;
}

export interface FrozenInputSize {
  bytes: number;
  lines: number;
}

export interface FrozenReviewInput {
  runId: string;
  target: ReviewTarget;
  inputSize: FrozenInputSize;
  inputSha256: string;
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

export interface ContestedFinding {
  findingIndex: number;
  finding: MergedFinding;
  refuterRoute: ReviewerRoute;
  reason: string;
  evidence: string[];
}

export interface MergedReviewReport {
  version: 1;
  runId: string;
  target: ReviewTarget;
  charterSource: string;
  charterSha256: string;
  requestedRoutes: ReviewerRoute[];
  routeResults: ReviewerRouteResult[];
  runtime: {
    protocolVersion: 3;
    maxConcurrent: number;
    backend: "external-v3" | "embedded";
    fallbackReason?: "unavailable" | "incompatible";
    waves: number;
    maxTurns: number;
    routeTimeoutMs: number;
    overallTimeoutMs: number;
  };
  successfulReviewerCount: number;
  minSuccessfulReviewerCount: number;
  consensusThreshold: number;
  advisoryReviewerCount: number;
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
  refuteRequested: boolean;
  refuterRoute?: ReviewerRoute;
  refuteRuntime?: {
    protocolVersion: 3;
    maxConcurrent: number;
    backend: "external-v3" | "embedded";
    fallbackReason?: "unavailable" | "incompatible";
    waves: number;
    maxTurns: number;
    routeTimeoutMs: number;
    overallTimeoutMs: number;
  };
  refuteResults: RefuteRouteResult[];
  contested: ContestedFinding[];
  stale: boolean;
  limitedContext: string[];
  startedAt: string;
  completedAt: string;
}
