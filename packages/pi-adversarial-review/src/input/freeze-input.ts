import { createHash, randomUUID } from "node:crypto";
import { open, readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type {
  FrozenReviewInput,
  ReviewInputDrift,
  ReviewTarget,
  ReviewTargetPreflight,
  ReviewTargetRequest,
} from "../types.ts";
import {
  captureRangeForSizing,
  captureReviewTarget,
  resolveCommittedReviewPath,
  resolveGitRoot,
  resolveReviewTarget,
  type CaptureLimits,
  type ResolvedReviewTarget,
  type TargetCapture,
} from "./git-target.ts";
import {
  EmptyReviewInputError,
  OversizedReviewInputError,
  ReviewInputCleanupError,
  ReviewInputError,
  type ReviewRangePlan,
  type ReviewRangePlanCommit,
  type ReviewRangePlanItem,
} from "./errors.ts";
import {
  assertFrozenInputWithinLimits,
  MAX_FROZEN_INPUT_BYTES,
  MAX_FROZEN_INPUT_LINES,
  measureFrozenInput,
  RECOMMENDED_FROZEN_INPUT_BYTES,
  RECOMMENDED_FROZEN_INPUT_LINES,
} from "./limits.ts";
import {
  createReviewTempWorkspace,
  type ReviewTempWorkspace,
} from "./temp-workspace.ts";

export { EmptyReviewInputError, OversizedReviewInputError } from "./errors.ts";
export {
  assertFrozenInputWithinLimits,
  MAX_FROZEN_INPUT_BYTES,
  MAX_FROZEN_INPUT_LINES,
  measureFrozenInput,
  RECOMMENDED_FROZEN_INPUT_BYTES,
  RECOMMENDED_FROZEN_INPUT_LINES,
} from "./limits.ts";

const CHARTER_PATH = fileURLToPath(new URL("../../assets/adversarial-charter.md", import.meta.url));

export interface PrepareFrozenReviewInputOptions {
  cwd: string;
  target: ReviewTargetRequest;
  reqdoc?: string;
  focus?: string;
  preflight?: ReviewTargetPreflight;
  signal?: AbortSignal;
  runId?: string;
  maxBytes?: number;
  maxLines?: number;
}

function sha256(content: string): string {
  return createHash("sha256").update(content).digest("hex");
}

function assertFreezeActive(signal?: AbortSignal): void {
  if (!signal?.aborted) return;
  throw signal.reason instanceof Error
    ? signal.reason
    : new Error("Adversarial review input freezing cancelled.");
}

async function readRequirement(
  root: string,
  requestedPath: string | undefined,
  maxBytes: number,
  maxLines: number,
): Promise<string | undefined> {
  if (!requestedPath) return undefined;
  const absolute = path.resolve(root, requestedPath);
  const relative = path.relative(root, absolute);
  if (relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new ReviewInputError("--reqdoc must resolve to a file inside the Git repository.");
  }
  let canonical: string;
  try {
    canonical = await realpath(absolute);
  } catch {
    throw new ReviewInputError(`Requirement document not found: ${requestedPath}`);
  }
  const canonicalRelative = path.relative(await realpath(root), canonical);
  if (canonicalRelative.startsWith("..") || path.isAbsolute(canonicalRelative)) {
    throw new ReviewInputError("--reqdoc may not escape the Git repository through a symlink.");
  }
  const fileInfo = await stat(canonical);
  if (!fileInfo.isFile()) {
    throw new ReviewInputError(`Requirement document is not a regular file: ${requestedPath}`);
  }
  if (fileInfo.size > maxBytes) {
    throw new OversizedReviewInputError({
      bytes: { limit: maxBytes, actual: fileInfo.size },
      subject: "Frozen requirement document",
      canSuggestRanges: false,
    });
  }

  const handle = await open(canonical, "r");
  try {
    const chunks: Buffer[] = [];
    let total = 0;
    while (total <= maxBytes) {
      const chunk = Buffer.alloc(Math.min(64 * 1024, maxBytes + 1 - total));
      if (chunk.length === 0) break;
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, total);
      if (bytesRead === 0) break;
      chunks.push(chunk.subarray(0, bytesRead));
      total += bytesRead;
    }
    const content = Buffer.concat(chunks).toString("utf8");
    assertFrozenInputWithinLimits(content, maxBytes, maxLines, {
      subject: "Frozen requirement document",
      canSuggestRanges: false,
    });
    return content;
  } finally {
    await handle.close();
  }
}

function toReviewTarget(
  root: string,
  resolved: ResolvedReviewTarget,
  capture: TargetCapture,
  preflight?: ReviewTargetPreflight,
): ReviewTarget {
  return {
    mode: resolved.mode,
    description: capture.description,
    root,
    headSha: capture.headSha,
    statusSha256: capture.statusSha256,
    targetSha256: capture.targetSha256,
    changedFiles: capture.changedFiles,
    ...(preflight ? { preflight } : {}),
    ...(resolved.mode === "base" ? { baseSha: resolved.baseSha } : {}),
    ...(resolved.mode === "range" ? { fromSha: resolved.fromSha, toSha: resolved.toSha } : {}),
  };
}

const OUTPUT_CONTRACT = `{
  "verdict": "needs-attention | approve",
  "summary": "string",
  "findings": [{
    "file": "relative/posix/path",
    "lineStart": 1,
    "lineEnd": 1,
    "severity": "critical | high | medium | low",
    "category": "auth | data-integrity | concurrency | failure-recovery | compatibility | observability | correctness | security | performance | other",
    "confidence": 0.0,
    "invariant": "short English guarantee that is violated",
    "issue": "what is wrong, why, and material impact",
    "evidence": "concrete evidence from the patch or repository",
    "recommendation": "practical correction direction"
  }]
}`;

function buildInputBundle(options: {
  runId: string;
  target: ReviewTarget;
  capture: TargetCapture;
  charter: string;
  charterSha256: string;
  requirement?: string;
  focus?: string;
}): string {
  const { runId, target, capture, charter, charterSha256, requirement, focus } = options;
  const sections = capture.sections.map(({ title, patch }) => (
    `### ${title}\n\n${patch || "(empty)"}`
  )).join("\n\n");
  const files = target.changedFiles.length > 0
    ? target.changedFiles.map((file) => `- ${JSON.stringify(file)}`).join("\n")
    : "- (none)";

  return `# Frozen adversarial review input

## Run metadata

- runId: ${runId}
- target: ${target.description}
- headSha: ${target.headSha}
- statusSha256: ${target.statusSha256}
- targetSha256: ${target.targetSha256}
- charterSource: builtin
- charterSha256: ${charterSha256}

## Review charter

${charter.trim()}
${requirement === undefined ? "" : `\n## Frozen requirement document\n\n${requirement.trim()}\n`}${focus === undefined ? "" : `\n## Shared review focus\n\n${focus.trim()}\n`}
## Changed files

${files}

## Frozen patches

${sections}

## Output contract

Return exactly one JSON object and no commentary. Do not use a Markdown fence. The first non-whitespace character must be \`{\` and the last non-whitespace character must be \`}\`. The object must match this shape:

${OUTPUT_CONTRACT}

An approve verdict requires an empty findings array. A needs-attention verdict requires at least one finding. Report only material issues with non-empty evidence.
`;
}

function hasReviewChanges(capture: TargetCapture): boolean {
  return capture.changedFiles.length > 0 && capture.sections.some(({ patch }) => patch.length > 0);
}

const RANGE_SUGGESTION_RUN_ID = "00000000-0000-4000-8000-000000000000";
const MAX_RANGE_SUGGESTIONS = 8;
const MAX_RANGE_SUGGESTION_COMMITS = 128;

export interface ReviewRangeSuggestionResult {
  /** Backward-compatible bounded target replacements for diagnostics/headless use. */
  commands: string[];
  /** Commit-aware TUI plan; complete SHA pairs remain the authoritative identities. */
  plan?: ReviewRangePlan;
  note?: string;
}

export interface SuggestReviewRangesOptions {
  root: string;
  target: ReviewTargetRequest;
  resolvedTarget: ResolvedReviewTarget;
  reqdoc?: string;
  focus?: string;
  preflight?: ReviewTargetPreflight;
  signal?: AbortSignal;
  maxBytes: number;
  maxLines: number;
}

type SuggestedRangeProbe =
  | {
      status: "fits";
      inputSize: { bytes: number; lines: number };
      changedFileCount: number;
    }
  | { status: "empty" }
  | { status: "oversized"; error: OversizedReviewInputError };

async function probeSuggestedRange(options: {
  root: string;
  fromSha: string;
  toSha: string;
  headSha: string;
  charter: string;
  charterSha256: string;
  requirement?: string;
  focus?: string;
  preflight?: ReviewTargetPreflight;
  signal?: AbortSignal;
  maxBytes: number;
  maxLines: number;
}): Promise<SuggestedRangeProbe> {
  try {
    const sizing = await captureRangeForSizing(
      options.root,
      options.fromSha,
      options.toSha,
      {
        maxBytes: options.maxBytes,
        maxLines: options.maxLines,
        signal: options.signal,
      },
    );
    if (sizing.changedFiles.length === 0 || sizing.patch.length === 0) {
      return { status: "empty" };
    }
    const resolved: ResolvedReviewTarget = {
      mode: "range",
      fromRef: options.fromSha,
      toRef: options.toSha,
      fromSha: options.fromSha,
      toSha: options.toSha,
      currentHeadSha: options.headSha,
      currentBranch: "range-suggestion",
      checkoutEstimate: { entries: 0, logicalBytes: "0" },
    };
    const capture: TargetCapture = {
      headSha: options.headSha,
      statusSha256: "0".repeat(64),
      targetSha256: "0".repeat(64),
      changedFiles: sizing.changedFiles,
      sections: [{ title: "Committed range patch", patch: sizing.patch }],
      limitedContext: [],
      description: `range ${options.fromSha} (${options.fromSha}) .. ${options.toSha} (${options.toSha})`,
    };
    const target = toReviewTarget(options.root, resolved, capture, options.preflight);
    const content = buildInputBundle({
      runId: RANGE_SUGGESTION_RUN_ID,
      target,
      capture,
      charter: options.charter,
      charterSha256: options.charterSha256,
      ...(options.requirement !== undefined ? { requirement: options.requirement } : {}),
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
    });
    const inputSize = assertFrozenInputWithinLimits(
      content,
      options.maxBytes,
      options.maxLines,
    );
    return {
      status: "fits",
      inputSize,
      changedFileCount: sizing.changedFiles.length,
    };
  } catch (error) {
    if (error instanceof OversizedReviewInputError) {
      return { status: "oversized", error };
    }
    throw error;
  }
}

function planCommit(
  metadata: readonly { sha: string; subject: string }[],
  index: number,
): ReviewRangePlanCommit {
  const commit = metadata[index];
  if (!commit) throw new ReviewInputError("Commit metadata is incomplete for range planning.");
  return { ...commit, ordinal: index + 1 };
}

export async function suggestReviewRanges(
  options: SuggestReviewRangesOptions,
): Promise<ReviewRangeSuggestionResult> {
  if (options.target.mode === "local" || options.resolvedTarget.mode === "local") {
    return { commands: [] };
  }
  const path = await resolveCommittedReviewPath(
    options.root,
    options.resolvedTarget,
    {
      metadataLimit: MAX_RANGE_SUGGESTION_COMMITS,
      ...(options.signal ? { signal: options.signal } : {}),
    },
  );
  if (!path || path.commits.length === 0) return { commands: [] };
  const [charter, requirement] = await Promise.all([
    readFile(CHARTER_PATH, "utf8"),
    readRequirement(options.root, options.reqdoc, options.maxBytes, options.maxLines),
  ]);
  const charterSha256 = sha256(charter);
  const commits = path.commits.slice(0, MAX_RANGE_SUGGESTION_COMMITS);
  const metadata = path.commitMetadata.slice(0, MAX_RANGE_SUGGESTION_COMMITS);
  const commands: string[] = [];
  const items: ReviewRangePlanItem[] = [];
  let emptyCommitCount = 0;
  let startSha = path.startSha;
  let commitIndex = 0;

  const probe = (fromSha: string, toSha: string, maxBytes: number, maxLines: number) => (
    probeSuggestedRange({
      root: options.root,
      fromSha,
      toSha,
      headSha: path.headSha,
      charter,
      charterSha256,
      ...(requirement !== undefined ? { requirement } : {}),
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
      ...(options.preflight ? { preflight: options.preflight } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      maxBytes,
      maxLines,
    })
  );

  while (commitIndex < commits.length && items.length < MAX_RANGE_SUGGESTIONS) {
    let lastFit = -1;
    let lastFitSize: { bytes: number; lines: number } | undefined;
    let lastFitChangedFileCount: number | undefined;
    let firstOversized = -1;
    for (let candidateIndex = commitIndex; candidateIndex < commits.length; candidateIndex++) {
      assertFreezeActive(options.signal);
      const result = await probe(
        startSha,
        commits[candidateIndex],
        options.maxBytes,
        options.maxLines,
      );
      if (result.status === "oversized") {
        firstOversized = candidateIndex;
        break;
      }
      if (result.status === "fits") {
        lastFit = candidateIndex;
        lastFitSize = result.inputSize;
        lastFitChangedFileCount = result.changedFileCount;
      }
    }

    if (
      lastFit >= commitIndex &&
      lastFitSize &&
      lastFitChangedFileCount !== undefined
    ) {
      const toSha = commits[lastFit];
      const item: ReviewRangePlanItem = {
        kind: "bounded",
        fromSha: startSha,
        toSha,
        commitCount: lastFit - commitIndex + 1,
        firstCommit: planCommit(metadata, commitIndex),
        lastCommit: planCommit(metadata, lastFit),
        inputSize: lastFitSize,
        changedFileCount: lastFitChangedFileCount,
      };
      items.push(item);
      commands.push(`--range ${item.fromSha}..${item.toSha}`);
      startSha = toSha;
      commitIndex = lastFit + 1;
      continue;
    }

    if (firstOversized > commitIndex) {
      // Every commit before the first oversized candidate produced no patch.
      emptyCommitCount += firstOversized - commitIndex;
      startSha = commits[firstOversized - 1];
      commitIndex = firstOversized;
      continue;
    }
    if (firstOversized < 0) {
      emptyCommitCount += commits.length - commitIndex;
      commitIndex = commits.length;
      break;
    }

    const toSha = commits[commitIndex];
    const absolute = await probe(
      startSha,
      toSha,
      MAX_FROZEN_INPUT_BYTES,
      MAX_FROZEN_INPUT_LINES,
    );
    if (absolute.status === "empty") {
      emptyCommitCount++;
    } else {
      items.push({
        kind: absolute.status === "fits" ? "large-single" : "too-large-single",
        fromSha: startSha,
        toSha,
        commitCount: 1,
        firstCommit: planCommit(metadata, commitIndex),
        lastCommit: planCommit(metadata, commitIndex),
        ...(absolute.status === "fits"
          ? {
              inputSize: absolute.inputSize,
              changedFileCount: absolute.changedFileCount,
            }
          : {}),
      });
    }
    startSha = toSha;
    commitIndex++;
  }

  const plan: ReviewRangePlan = {
    targetCommitCount: path.commits.length,
    analyzedCommitCount: commitIndex,
    emptyCommitCount,
    requiresSeparateLocalReview: options.target.mode === "base",
    items,
  };
  const largeSingles = items.filter(({ kind }) => kind === "large-single");
  const tooLargeSingles = items.filter(({ kind }) => kind === "too-large-single");
  const notes: string[] = [];
  if (options.target.mode === "base") {
    notes.push(
      "These ranges cover committed changes only; review any uncommitted changes separately with /adversarial-review --local.",
    );
  }
  if (largeSingles.length > 0) {
    notes.push(
      `Single-commit ranges needing explicit whole-target approval: ${largeSingles.map(({ toSha }) => toSha.slice(0, 12)).join(", ")}.`,
    );
  }
  if (tooLargeSingles.length > 0) {
    notes.push(
      `Single-commit ranges exceeding the absolute limit: ${tooLargeSingles.map(({ toSha }) => toSha.slice(0, 12)).join(", ")}. Reduce attached context or split those commits before review.`,
    );
  }
  if (path.commits.length > commits.length || commitIndex < commits.length) {
    notes.push(
      `Automatic analysis stops at ${startSha.slice(0, 12)}; continue with another smaller range from that commit.`,
    );
  }
  return {
    commands,
    plan,
    ...(notes.length > 0 ? { note: notes.join(" ") } : {}),
  };
}

async function enrichOversizedInputError(
  error: unknown,
  options: SuggestReviewRangesOptions,
): Promise<unknown> {
  if (
    !(error instanceof OversizedReviewInputError) ||
    !error.canSuggestRanges ||
    (error.rangeSuggestions.length > 0 || error.rangePlan !== undefined) ||
    options.target.mode === "local"
  ) {
    return error;
  }
  try {
    const suggestions = await suggestReviewRanges({
      ...options,
      maxBytes: Math.min(options.maxBytes, RECOMMENDED_FROZEN_INPUT_BYTES),
      maxLines: Math.min(options.maxLines, RECOMMENDED_FROZEN_INPUT_LINES),
    });
    if (suggestions.commands.length > 0 || suggestions.plan || suggestions.note) {
      error.addRangeSuggestions(
        suggestions.commands,
        suggestions.note,
        suggestions.plan,
      );
    }
  } catch (suggestionError) {
    if (options.signal?.aborted) throw suggestionError;
    // Range advice is best-effort; the original bounded-input failure remains authoritative.
  }
  return error;
}

export interface ReviewTargetFingerprint {
  root: string;
  headSha: string;
  statusSha256: string;
  targetSha256: string;
  inputSize: { bytes: number; lines: number };
  inputSha256: string;
  resolvedTarget: ResolvedReviewTarget;
  targetRefs: Array<{ ref: string; sha: string }>;
}

function resolvedTargetIdentity(target: ResolvedReviewTarget): string {
  return JSON.stringify(target);
}

function captureIdentity(capture: TargetCapture): string {
  return JSON.stringify({
    headSha: capture.headSha,
    statusSha256: capture.statusSha256,
    targetSha256: capture.targetSha256,
  });
}

export async function fingerprintReviewTarget(options: {
  cwd: string;
  target: ReviewTargetRequest;
  reqdoc?: string;
  focus?: string;
  signal?: AbortSignal;
  maxBytes?: number;
  maxLines?: number;
  /** Disable best-effort automatic range planning when the caller owns range re-selection. */
  suggestRangesOnOversize?: boolean;
}): Promise<ReviewTargetFingerprint> {
  const maxBytes = options.maxBytes ?? MAX_FROZEN_INPUT_BYTES;
  const maxLines = options.maxLines ?? MAX_FROZEN_INPUT_LINES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || !Number.isInteger(maxLines) || maxLines <= 0) {
    throw new ReviewInputError("Frozen input limits must be positive integers.");
  }
  const root = await resolveGitRoot(options.cwd, options.signal);
  let resolvedForSuggestions: ResolvedReviewTarget | undefined;
  try {
    const captureOptions = { maxBytes, maxLines, signal: options.signal };
    const firstResolved = await resolveReviewTarget(root, options.target, options.signal);
    resolvedForSuggestions = firstResolved;
    const firstCapture = await captureReviewTarget(root, firstResolved, captureOptions);
    const secondResolved = await resolveReviewTarget(root, options.target, options.signal);
    if (resolvedTargetIdentity(firstResolved) !== resolvedTargetIdentity(secondResolved)) {
      throw new ReviewInputError(
        "Git target refs changed while fingerprinting adversarial review input. Retry the review.",
      );
    }
    resolvedForSuggestions = secondResolved;
    const secondCapture = await captureReviewTarget(root, secondResolved, captureOptions);
    const finalResolved = await resolveReviewTarget(root, options.target, options.signal);
    if (
      resolvedTargetIdentity(secondResolved) !== resolvedTargetIdentity(finalResolved) ||
      captureIdentity(firstCapture) !== captureIdentity(secondCapture)
    ) {
      throw new ReviewInputError(
        "Git content changed while fingerprinting adversarial review input. Retry the review.",
      );
    }
    if (!hasReviewChanges(secondCapture)) throw new EmptyReviewInputError();
    const [charter, requirement] = await Promise.all([
      readFile(CHARTER_PATH, "utf8"),
      readRequirement(root, options.reqdoc, maxBytes, maxLines),
    ]);
    const charterSha256 = sha256(charter);
    const measuredTarget = toReviewTarget(root, finalResolved, secondCapture);
    const measuredContent = buildInputBundle({
      runId: RANGE_SUGGESTION_RUN_ID,
      target: measuredTarget,
      capture: secondCapture,
      charter,
      charterSha256,
      ...(requirement !== undefined ? { requirement } : {}),
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
    });
    const inputSize = assertFrozenInputWithinLimits(measuredContent, maxBytes, maxLines);
    const targetRefs = options.target.mode === "base" && finalResolved.mode === "base"
      ? [{ ref: options.target.baseRef, sha: finalResolved.baseSha }]
      : options.target.mode === "range" && finalResolved.mode === "range"
        ? [
            { ref: options.target.fromRef, sha: finalResolved.fromSha },
            { ref: options.target.toRef, sha: finalResolved.toSha },
          ]
        : [];
    return {
      root,
      headSha: secondCapture.headSha,
      statusSha256: secondCapture.statusSha256,
      targetSha256: secondCapture.targetSha256,
      inputSize,
      inputSha256: sha256(measuredContent),
      resolvedTarget: finalResolved,
      targetRefs,
    };
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : error;
    }
    if (!resolvedForSuggestions || options.suggestRangesOnOversize === false) throw error;
    throw await enrichOversizedInputError(error, {
      root,
      target: options.target,
      resolvedTarget: resolvedForSuggestions,
      ...(options.reqdoc ? { reqdoc: options.reqdoc } : {}),
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      maxBytes,
      maxLines,
    });
  }
}

async function cleanupFailedFreezeWorkspace(
  workspace: Pick<ReviewTempWorkspace, "cleanup">,
  freezeError: unknown,
): Promise<never> {
  try {
    await workspace.cleanup();
  } catch (cleanupError) {
    throw new ReviewInputCleanupError(freezeError, cleanupError);
  }
  throw freezeError;
}

async function detectDrift(
  root: string,
  request: ReviewTargetRequest,
  original: ReviewTarget,
  limits: CaptureLimits,
): Promise<ReviewInputDrift> {
  let current: TargetCapture;
  try {
    const resolved = await resolveReviewTarget(root, request);
    current = await captureReviewTarget(root, resolved, limits);
  } catch {
    return { stale: true, changed: ["target"] };
  }
  const changed: ReviewInputDrift["changed"] = [];
  if (current.headSha !== original.headSha) changed.push("head");
  if (current.statusSha256 !== original.statusSha256) changed.push("status");
  if (current.targetSha256 !== original.targetSha256) changed.push("target");
  return { stale: changed.length > 0, changed };
}

export async function prepareFrozenReviewInput(
  options: PrepareFrozenReviewInputOptions,
): Promise<FrozenReviewInput> {
  const maxBytes = options.maxBytes ?? MAX_FROZEN_INPUT_BYTES;
  const maxLines = options.maxLines ?? MAX_FROZEN_INPUT_LINES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || !Number.isInteger(maxLines) || maxLines <= 0) {
    throw new ReviewInputError("Frozen input limits must be positive integers.");
  }
  const root = await resolveGitRoot(options.cwd, options.signal);
  const resolved = await resolveReviewTarget(root, options.target, options.signal);
  const suggestionOptions: SuggestReviewRangesOptions = {
    root,
    target: options.target,
    resolvedTarget: resolved,
    ...(options.reqdoc ? { reqdoc: options.reqdoc } : {}),
    ...(options.focus !== undefined ? { focus: options.focus } : {}),
    ...(options.preflight ? { preflight: options.preflight } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    maxBytes,
    maxLines,
  };
  let capture: TargetCapture;
  try {
    capture = await captureReviewTarget(root, resolved, {
      maxBytes,
      maxLines,
      signal: options.signal,
    });
  } catch (error) {
    throw await enrichOversizedInputError(error, suggestionOptions);
  }
  if (!hasReviewChanges(capture)) throw new EmptyReviewInputError();
  assertFreezeActive(options.signal);

  const [charter, requirement] = await Promise.all([
    readFile(CHARTER_PATH, "utf8"),
    readRequirement(root, options.reqdoc, maxBytes, maxLines),
  ]);
  assertFreezeActive(options.signal);
  const charterSha256 = sha256(charter);
  const runId = options.runId ?? randomUUID();
  const target = toReviewTarget(root, resolved, capture, options.preflight);
  const content = buildInputBundle({
    runId,
    target,
    capture,
    charter,
    charterSha256,
    ...(requirement !== undefined ? { requirement } : {}),
    ...(options.focus !== undefined ? { focus: options.focus } : {}),
  });
  let inputSize: { bytes: number; lines: number };
  try {
    inputSize = assertFrozenInputWithinLimits(content, maxBytes, maxLines);
  } catch (error) {
    throw await enrichOversizedInputError(error, suggestionOptions);
  }
  const measuredContent = runId === RANGE_SUGGESTION_RUN_ID
    ? content
    : buildInputBundle({
        runId: RANGE_SUGGESTION_RUN_ID,
        target,
        capture,
        charter,
        charterSha256,
        ...(requirement !== undefined ? { requirement } : {}),
        ...(options.focus !== undefined ? { focus: options.focus } : {}),
      });
  const inputSha256 = sha256(measuredContent);

  const workspace = await createReviewTempWorkspace(runId);
  try {
    let reviewerCwd = root;
    if (resolved.mode === "range") {
      reviewerCwd = await workspace.createRangeWorktree({
        root,
        toSha: resolved.toSha,
        estimate: resolved.checkoutEstimate,
        ...(options.signal ? { signal: options.signal } : {}),
      });
    }
    assertFreezeActive(options.signal);
    await workspace.writeInput(content);

    return {
      runId,
      target,
      inputSize,
      inputSha256,
      reviewerCwd,
      inputPath: workspace.inputPath,
      charterSource: "builtin",
      charterSha256,
      limitedContext: capture.limitedContext,
      recheck: () => detectDrift(root, options.target, target, { maxBytes, maxLines }),
      cleanup: workspace.cleanup,
    };
  } catch (error) {
    return cleanupFailedFreezeWorkspace(workspace, error);
  }
}
