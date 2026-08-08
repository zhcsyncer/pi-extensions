import type {
  Finding,
  FindingSeverity,
  MergedFinding,
  ReviewerRouteResult,
} from "../types.ts";

export interface ClusteringConfig {
  lineTolerance: number;
  invariantSimilarity: number;
  issueSimilarity: number;
}

export const DEFAULT_CLUSTERING_CONFIG: ClusteringConfig = {
  lineTolerance: 2,
  invariantSimilarity: 0.35,
  issueSimilarity: 0.45,
};

interface NormalizedFinding {
  finding: Finding;
  routeKey: string;
  routeOrdinal: number;
  findingIndex: number;
  invariantTokens: Set<string>;
  issueTokens: Set<string>;
  invariantKey: string;
  issueKey: string;
}

const STOP_WORDS = new Set([
  "a", "an", "and", "are", "as", "at", "be", "because", "by", "can", "does",
  "for", "from", "has", "if", "in", "into", "is", "it", "may", "not", "of",
  "on", "or", "that", "the", "this", "to", "when", "which", "will", "with",
]);

const SEVERITY_RANK: Record<FindingSeverity, number> = {
  low: 0,
  medium: 1,
  high: 2,
  critical: 3,
};

function lexical(left: string, right: string): number {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function normalizedTokens(value: string): Set<string> {
  const tokens = value
    .normalize("NFKD")
    .toLowerCase()
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .split(/\s+/u)
    .map((token) => token.trim())
    .filter((token) => token.length > 0 && !STOP_WORDS.has(token));
  return new Set(tokens);
}

export function jaccard(left: Set<string>, right: Set<string>): number {
  if (left.size === 0 && right.size === 0) return 0;
  let intersection = 0;
  for (const token of left) if (right.has(token)) intersection++;
  const union = left.size + right.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

function lineDistance(left: Finding, right: Finding): number {
  if (left.lineEnd < right.lineStart) return right.lineStart - left.lineEnd;
  if (right.lineEnd < left.lineStart) return left.lineStart - right.lineEnd;
  return 0;
}

function compatible(
  left: NormalizedFinding,
  right: NormalizedFinding,
  config: ClusteringConfig,
): boolean {
  if (left.finding.file !== right.finding.file) return false;
  if (left.finding.category !== right.finding.category) return false;
  if (lineDistance(left.finding, right.finding) > config.lineTolerance) return false;
  return (
    jaccard(left.invariantTokens, right.invariantTokens) >= config.invariantSimilarity ||
    jaccard(left.issueTokens, right.issueTokens) >= config.issueSimilarity
  );
}

function tokenKey(tokens: Set<string>): string {
  return [...tokens].sort(lexical).join(" ");
}

function canonicalFindings(routeResults: readonly ReviewerRouteResult[]): NormalizedFinding[] {
  return routeResults
    .filter((result) => result.status === "completed" && result.report !== undefined)
    .flatMap((result) => result.report!.findings.map((finding, findingIndex) => {
      const invariantTokens = normalizedTokens(finding.invariant);
      const issueTokens = normalizedTokens(finding.issue);
      return {
        finding,
        routeKey: result.route.key,
        routeOrdinal: result.route.ordinal,
        findingIndex,
        invariantTokens,
        issueTokens,
        invariantKey: tokenKey(invariantTokens),
        issueKey: tokenKey(issueTokens),
      };
    }))
    .sort((left, right) => (
      lexical(left.finding.file, right.finding.file) ||
      left.finding.lineStart - right.finding.lineStart ||
      left.finding.lineEnd - right.finding.lineEnd ||
      lexical(left.finding.category, right.finding.category) ||
      left.routeOrdinal - right.routeOrdinal ||
      lexical(left.invariantKey, right.invariantKey) ||
      lexical(left.issueKey, right.issueKey) ||
      SEVERITY_RANK[right.finding.severity] - SEVERITY_RANK[left.finding.severity] ||
      right.finding.confidence - left.finding.confidence ||
      lexical(left.finding.evidence, right.finding.evidence) ||
      lexical(left.finding.recommendation, right.finding.recommendation) ||
      left.findingIndex - right.findingIndex
    ));
}

function mergeCluster(members: NormalizedFinding[]): MergedFinding {
  let representative = members[0];
  for (const member of members.slice(1)) {
    if (member.finding.confidence > representative.finding.confidence) representative = member;
  }
  const highestSeverity = members.reduce((current, member) => (
    SEVERITY_RANK[member.finding.severity] > SEVERITY_RANK[current]
      ? member.finding.severity
      : current
  ), members[0].finding.severity);
  const reviewerOrdinals = new Map<string, number>();
  const evidence = new Set<string>();
  for (const member of members) {
    reviewerOrdinals.set(
      member.routeKey,
      Math.min(reviewerOrdinals.get(member.routeKey) ?? member.routeOrdinal, member.routeOrdinal),
    );
    evidence.add(member.finding.evidence);
  }
  const reviewers = [...reviewerOrdinals]
    .sort((left, right) => left[1] - right[1] || lexical(left[0], right[0]))
    .map(([routeKey]) => routeKey);

  return {
    file: members[0].finding.file,
    lineStart: Math.min(...members.map((member) => member.finding.lineStart)),
    lineEnd: Math.max(...members.map((member) => member.finding.lineEnd)),
    severity: highestSeverity,
    category: members[0].finding.category,
    confidence: Math.max(...members.map((member) => member.finding.confidence)),
    invariant: representative.finding.invariant,
    issue: representative.finding.issue,
    evidence: [...evidence],
    recommendation: representative.finding.recommendation,
    reviewers,
    votes: reviewers.length,
    sourceFindingIndexes: members.map((member) => ({
      routeKey: member.routeKey,
      findingIndex: member.findingIndex,
    })),
  };
}

export function clusterReviewFindings(
  routeResults: readonly ReviewerRouteResult[],
  config: ClusteringConfig = DEFAULT_CLUSTERING_CONFIG,
): MergedFinding[] {
  if (
    config.lineTolerance < 0 ||
    config.invariantSimilarity < 0 || config.invariantSimilarity > 1 ||
    config.issueSimilarity < 0 || config.issueSimilarity > 1
  ) throw new Error("Invalid clustering configuration.");

  const clusters: NormalizedFinding[][] = [];
  for (const candidate of canonicalFindings(routeResults)) {
    const compatibleCluster = clusters.find((cluster) => (
      cluster.every((member) => compatible(candidate, member, config))
    ));
    if (compatibleCluster) compatibleCluster.push(candidate);
    else clusters.push([candidate]);
  }
  return clusters.map(mergeCluster);
}
