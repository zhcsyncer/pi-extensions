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
  minIssueSharedTokens: number;
  corroboratingIssueSimilarity: number;
  minCorroboratingIssueTokens: number;
  minSharedActionTokens: number;
}

export const DEFAULT_CLUSTERING_CONFIG: ClusteringConfig = {
  lineTolerance: 2,
  invariantSimilarity: 0.18,
  issueSimilarity: 0.16,
  minIssueSharedTokens: 2,
  corroboratingIssueSimilarity: 0.11,
  minCorroboratingIssueTokens: 2,
  minSharedActionTokens: 1,
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
  "a", "after", "all", "an", "and", "are", "as", "at", "be", "because", "before", "both", "by", "can",
  "configured", "current", "different", "does", "during", "each", "either", "every",
  "existing", "field", "fields", "for", "from", "has", "if", "in", "inside", "into",
  "is", "it", "may", "must", "neither", "never", "new", "not", "of", "on", "only",
  "or", "outside", "path", "per", "previous", "remain", "remains", "request", "requests",
  "same", "stay", "stays", "successful", "that", "the", "this", "through", "to", "under",
  "user", "users", "value", "values", "when", "which", "will", "with", "without",
]);

// Deliberately narrow inflection table. Do not collapse broad concepts such as
// authorization/token or URL/origin: nearby findings can mention those words
// while describing different vulnerabilities.
const TOKEN_ALIASES = new Map<string, string>();
for (const [canonical, variants] of Object.entries({
  access: ["access", "accessed", "accesses", "accessing"],
  address: ["address", "addresses"],
  auth: ["auth", "authenticated", "authentication"],
  cache: ["cache", "cached", "caches", "caching"],
  charge: ["charge", "charged", "charges", "charging"],
  class: ["class", "classes"],
  clear: ["clear", "cleared", "clearing", "clears"],
  client: ["client", "clients"],
  concurrent: ["concurrency", "concurrent"],
  create: ["create", "created", "creates", "creating", "creation"],
  duplicate: ["duplicate", "duplicated", "duplicates"],
  expire: ["expiration", "expired", "expiry"],
  fail: ["fail", "failed", "failing", "fails", "failure", "failures"],
  header: ["header", "headers"],
  identifier: ["identifier", "identifiers"],
  insert: ["insert", "inserted", "insertion", "inserts"],
  job: ["job", "jobs"],
  lock: ["lock", "locked", "locking", "locks"],
  log: ["log", "logged", "logging", "logs"],
  order: ["order", "orders"],
  payment: ["payment", "payments"],
  persist: ["persist", "persisted", "persistence"],
  process: ["process", "processed", "processes", "processing"],
  profile: ["profile", "profiles"],
  query: ["filter", "filtered", "filtering", "filters", "lookup", "lookups", "queries", "query"],
  read: ["read", "reading", "reads"],
  record: ["record", "records"],
  redirect: ["redirect", "redirected", "redirects"],
  reservation: ["reservation", "reservations", "reserve", "reserved"],
  response: ["response", "responses"],
  retry: ["retried", "retries", "retry", "retrying"],
  rollback: ["revert", "reverted", "reverts", "rollback", "rolled"],
  row: ["row", "rows"],
  status: ["status", "statuses"],
  tenant: ["tenant", "tenants"],
  token: ["token", "tokens"],
  update: ["update", "updated", "updates", "updating"],
  wirechange: ["remove", "removed", "removes", "removing", "rename", "renamed", "renames", "renaming"],
  url: ["url", "urls"],
  write: ["write", "writes", "writing"],
})) {
  for (const variant of variants) TOKEN_ALIASES.set(variant, canonical);
}

// Entity overlap (order/tenant/id/profile/etc.) is context, not mechanism.
// At least one shared action token is required so nearby read/write or tax/
// discount defects cannot become a false consensus merely by naming the same data.
const ACTION_MECHANISM_TOKENS = new Set([
  "charge", "clear", "create", "fail", "idempotency", "log", "null", "persist",
  "query", "redirect", "retry", "rollback", "update", "wirechange", "write",
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

function canonicalToken(value: string): string {
  const token = value.replace(/[’']s$/u, "");
  return TOKEN_ALIASES.get(token) ?? token;
}

export function normalizedTokens(value: string): Set<string> {
  const rawTokens = value
    .normalize("NFKD")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .split(/\s+/u)
    .filter(Boolean);
  const tokens = new Set<string>();
  for (const rawToken of rawTokens) {
    // Preserve the whole identifier and add camelCase components as extra
    // evidence. This keeps status/process/access intact while allowing
    // tenantId from two reviewers to overlap with tenant id wording.
    const candidates = [
      rawToken.toLowerCase(),
      ...rawToken.replace(/([\p{Ll}\d])(\p{Lu})/gu, "$1 $2").toLowerCase().split(" "),
    ];
    for (const candidate of candidates) {
      const token = canonicalToken(candidate.trim());
      if (token.length > 0 && !STOP_WORDS.has(token)) tokens.add(token);
    }
  }
  return tokens;
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
  const invariantScore = jaccard(left.invariantTokens, right.invariantTokens);
  const issueScore = jaccard(left.issueTokens, right.issueTokens);
  const sharedIssueTokens = [...left.issueTokens].filter((token) => right.issueTokens.has(token));
  const sharedActionTokens = sharedIssueTokens.filter((token) => ACTION_MECHANISM_TOKENS.has(token));
  const hasSharedAction = sharedActionTokens.length >= config.minSharedActionTokens;
  return hasSharedAction && (
    (
      issueScore >= config.issueSimilarity &&
      sharedIssueTokens.length >= config.minIssueSharedTokens
    ) ||
    (
      invariantScore >= config.invariantSimilarity &&
      issueScore >= config.corroboratingIssueSimilarity &&
      sharedIssueTokens.length >= config.minCorroboratingIssueTokens
    )
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
    config.issueSimilarity < 0 || config.issueSimilarity > 1 ||
    !Number.isInteger(config.minIssueSharedTokens) || config.minIssueSharedTokens < 1 ||
    config.corroboratingIssueSimilarity < 0 || config.corroboratingIssueSimilarity > 1 ||
    !Number.isInteger(config.minCorroboratingIssueTokens) || config.minCorroboratingIssueTokens < 0 ||
    !Number.isInteger(config.minSharedActionTokens) || config.minSharedActionTokens < 0
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
