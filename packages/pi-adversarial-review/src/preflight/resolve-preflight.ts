import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ReviewCommandError } from "../command/parse-args.ts";
import {
  EmptyReviewInputError,
  OversizedReviewInputError,
  ReviewInputError,
} from "../input/errors.ts";
import {
  fingerprintReviewTarget,
  MAX_FROZEN_INPUT_BYTES,
  MAX_FROZEN_INPUT_LINES,
  RECOMMENDED_FROZEN_INPUT_BYTES,
  RECOMMENDED_FROZEN_INPUT_LINES,
  suggestReviewRanges,
  type ReviewTargetFingerprint,
} from "../input/freeze-input.ts";
import { safeReviewDiagnosticText } from "../output/headless-output.ts";
import type {
  FrozenReviewInput,
  ReviewTarget,
  ReviewTargetPreflight,
  ReviewTargetRequest,
} from "../types.ts";
import {
  fetchReviewRemote,
  hasLocalChanges,
  inspectGitPreflight,
  remotesReferencedByTarget,
  type GitPreflightState,
  type PreflightCommandRunner,
  type ResolvedPreflightRef,
} from "./git-preflight.ts";
import {
  inferReviewTarget,
  type PreflightIssue,
} from "./target-inference.ts";

const RETRY_FETCH = "Retry fetch";
const USE_LOCAL_REF = "Use existing local remote-tracking ref";
const CANCEL_REVIEW = "Cancel review";
const ENTER_CUSTOM_BASE = "Enter a custom base ref…";
const REVIEW_WHOLE_TARGET = "Review the whole target";
const SHOW_RANGE_SUGGESTIONS = "Show smaller range suggestions and cancel";

export interface ReviewPreflightGuard {
  root: string;
  headSha: string;
  statusSha256: string;
  branch?: string;
  remote?: string;
  defaultBranchRef?: string;
  defaultBranchSha?: string;
  operation?: string;
  unmerged: boolean;
  targetSha256: string;
  inputSha256: string;
  targetRefs: ResolvedPreflightRef[];
}

export interface ResolvedReviewPreflight {
  target: ReviewTargetRequest;
  audit: ReviewTargetPreflight;
  summary: string;
  inputSize: { bytes: number; lines: number };
  largeInput: boolean;
  reqdoc?: string;
  focus?: string;
  guard: ReviewPreflightGuard;
}

export interface ResolveReviewPreflightOptions {
  ctx: ExtensionCommandContext;
  target: ReviewTargetRequest;
  targetExplicit: boolean;
  allowLarge?: boolean;
  reqdoc?: string;
  focus?: string;
  signal?: AbortSignal;
  runner?: PreflightCommandRunner;
  fetchTimeoutMs?: number;
  inspect?: typeof inspectGitPreflight;
  fetch?: typeof fetchReviewRemote;
  fingerprintTarget?: typeof fingerprintReviewTarget;
  suggestRanges?: typeof suggestReviewRanges;
}

function display(value: string): string {
  return safeReviewDiagnosticText(value).slice(0, 160);
}

function targetLabel(target: ReviewTargetRequest): string {
  if (target.mode === "local") return "local staged, unstaged, and untracked changes";
  if (target.mode === "base") {
    return `committed changes from ${display(target.baseRef)} through HEAD, plus local changes`;
  }
  return `committed snapshot ${display(target.fromRef)}..${display(target.toRef)}`;
}

function buildAudit(options: {
  state: GitPreflightState;
  selection: ReviewTargetPreflight["selection"];
  fetchStatus: ReviewTargetPreflight["fetchStatus"];
  attemptedRemotes: readonly string[];
  fetchedRemotes: readonly string[];
}): ReviewTargetPreflight {
  const { state } = options;
  return {
    selection: options.selection,
    fetchStatus: options.fetchStatus,
    ...(state.branch ? { branch: state.branch } : {}),
    ...(state.preferredRemote ? { remote: state.preferredRemote } : {}),
    ...(options.attemptedRemotes.length > 0
      ? { attemptedRemotes: [...options.attemptedRemotes] }
      : {}),
    ...(options.fetchedRemotes.length > 0 ? { fetchedRemotes: [...options.fetchedRemotes] } : {}),
    ...(state.defaultBranchRef ? { defaultBranchRef: state.defaultBranchRef } : {}),
    ...(state.ahead !== undefined ? { ahead: state.ahead } : {}),
    ...(state.behind !== undefined ? { behind: state.behind } : {}),
    ...(state.operation ? { operation: state.operation } : {}),
    ...(state.workingTree.unmerged ? { unmerged: true } : {}),
  };
}

function summaryText(
  target: ReviewTargetRequest,
  audit: ReviewTargetPreflight,
): string {
  const relation = audit.ahead !== undefined && audit.behind !== undefined
    ? ` · ahead ${audit.ahead}, behind ${audit.behind}`
    : "";
  const fetch = audit.fetchStatus === "succeeded"
    ? ` · fetched ${audit.fetchedRemotes?.map(display).join(", ") || display(audit.remote ?? "remote")}`
    : audit.fetchStatus === "failed-used-local"
      ? " · fetch failed, using local remote-tracking ref"
      : "";
  const branch = audit.branch ? display(audit.branch) : "detached HEAD";
  return safeReviewDiagnosticText(
    `Adversarial review target: ${targetLabel(target)} · branch ${branch}${relation}${fetch}.`,
  );
}

type ReviewTargetGitFingerprint = Pick<
  ReviewTargetFingerprint,
  "root" | "headSha" | "statusSha256" | "targetSha256" | "targetRefs"
>;

function fingerprintFromFrozenTarget(
  request: ReviewTargetRequest,
  target: ReviewTarget,
): ReviewTargetGitFingerprint {
  if (target.mode !== request.mode) {
    throw new ReviewInputError("Frozen target mode does not match adversarial review preflight.");
  }
  const targetRefs: ResolvedPreflightRef[] = [];
  if (request.mode === "base") {
    if (!target.baseSha) throw new ReviewInputError("Frozen base target is missing its resolved SHA.");
    targetRefs.push({ ref: request.baseRef, sha: target.baseSha });
  } else if (request.mode === "range") {
    if (!target.fromSha || !target.toSha) {
      throw new ReviewInputError("Frozen range target is missing its resolved SHAs.");
    }
    targetRefs.push(
      { ref: request.fromRef, sha: target.fromSha },
      { ref: request.toRef, sha: target.toSha },
    );
  }
  return {
    root: target.root,
    headSha: target.headSha,
    statusSha256: target.statusSha256,
    targetSha256: target.targetSha256,
    targetRefs,
  };
}

function exceedsRecommendedInput(size: { bytes: number; lines: number }): boolean {
  return size.bytes > RECOMMENDED_FROZEN_INPUT_BYTES ||
    size.lines > RECOMMENDED_FROZEN_INPUT_LINES;
}

function recommendedExcessText(size: { bytes: number; lines: number }): string {
  return [
    ...(size.bytes > RECOMMENDED_FROZEN_INPUT_BYTES
      ? [`${size.bytes} bytes > ${RECOMMENDED_FROZEN_INPUT_BYTES} bytes`]
      : []),
    ...(size.lines > RECOMMENDED_FROZEN_INPUT_LINES
      ? [`${size.lines} lines > ${RECOMMENDED_FROZEN_INPUT_LINES} lines`]
      : []),
  ].join("; ");
}

function recommendedLimitError(size: { bytes: number; lines: number }): OversizedReviewInputError {
  return new OversizedReviewInputError({
    ...(size.bytes > RECOMMENDED_FROZEN_INPUT_BYTES
      ? { bytes: { limit: RECOMMENDED_FROZEN_INPUT_BYTES, actual: size.bytes } }
      : {}),
    ...(size.lines > RECOMMENDED_FROZEN_INPUT_LINES
      ? { lines: { limit: RECOMMENDED_FROZEN_INPUT_LINES, actual: size.lines } }
      : {}),
  });
}

async function approveLargeInput(options: {
  ctx: ExtensionCommandContext;
  target: ReviewTargetRequest;
  fingerprint: ReviewTargetFingerprint;
  allowLarge?: boolean;
  reqdoc?: string;
  focus?: string;
  signal?: AbortSignal;
  suggestRanges?: typeof suggestReviewRanges;
}): Promise<boolean | undefined> {
  if (!exceedsRecommendedInput(options.fingerprint.inputSize)) return false;
  if (options.allowLarge) return true;
  const { bytes, lines } = options.fingerprint.inputSize;
  if (options.ctx.mode !== "tui") {
    throw new ReviewCommandError(
      `Frozen review input exceeds the recommended threshold (${recommendedExcessText(options.fingerprint.inputSize)}). ` +
        "Pass --allow-large to review it whole, or use a smaller --range target.",
    );
  }

  const choices = [
    REVIEW_WHOLE_TARGET,
    ...(options.target.mode === "local" ? [] : [SHOW_RANGE_SUGGESTIONS]),
    CANCEL_REVIEW,
  ];
  const choice = await options.ctx.ui.select(
    `Frozen review input is ${bytes} bytes / ${lines} lines. ` +
      "Large targets use more reviewer turns and may reduce review precision.",
    choices,
    options.signal ? { signal: options.signal } : undefined,
  );
  if (choice === REVIEW_WHOLE_TARGET) return true;
  if (choice === SHOW_RANGE_SUGGESTIONS) {
    let suggestions: string[] = [];
    let suggestionNote: string | undefined;
    try {
      const result = await (options.suggestRanges ?? suggestReviewRanges)({
        root: options.fingerprint.root,
        target: options.target,
        resolvedTarget: options.fingerprint.resolvedTarget,
        ...(options.reqdoc ? { reqdoc: options.reqdoc } : {}),
        ...(options.focus !== undefined ? { focus: options.focus } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        maxBytes: RECOMMENDED_FROZEN_INPUT_BYTES,
        maxLines: RECOMMENDED_FROZEN_INPUT_LINES,
      });
      suggestions = result.commands;
      suggestionNote = result.note;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // The original size warning remains authoritative if range advice fails.
    }
    const policyNote =
      `This is the recommended whole-target threshold; the absolute limit remains ` +
      `${MAX_FROZEN_INPUT_BYTES} bytes / ${MAX_FROZEN_INPUT_LINES} lines.`;
    throw recommendedLimitError(options.fingerprint.inputSize)
      .addRangeSuggestions(
        suggestions,
        [policyNote, suggestionNote].filter(Boolean).join(" "),
      );
  }
  return undefined;
}

async function finalizePreflight(options: {
  ctx: ExtensionCommandContext;
  state: GitPreflightState;
  target: ReviewTargetRequest;
  audit: ReviewTargetPreflight;
  summary: string;
  allowLarge?: boolean;
  reqdoc?: string;
  focus?: string;
  signal?: AbortSignal;
  fingerprintTarget?: typeof fingerprintReviewTarget;
  suggestRanges?: typeof suggestReviewRanges;
}): Promise<ResolvedReviewPreflight | undefined> {
  if (options.signal?.aborted) throw options.signal.reason;
  const fingerprint = await (options.fingerprintTarget ?? fingerprintReviewTarget)({
    cwd: options.state.root,
    target: options.target,
    ...(options.reqdoc ? { reqdoc: options.reqdoc } : {}),
    ...(options.focus !== undefined ? { focus: options.focus } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  if (options.signal?.aborted) throw options.signal.reason;
  const knownRefChanged = fingerprint.targetRefs.some(({ ref, sha }) => (
    (ref === "HEAD" && sha !== options.state.headSha) ||
    (ref === options.state.defaultBranchRef &&
      options.state.defaultBranchSha !== undefined &&
      sha !== options.state.defaultBranchSha)
  ));
  if (
    fingerprint.root !== options.state.root ||
    fingerprint.headSha !== options.state.headSha ||
    fingerprint.statusSha256 !== options.state.statusSha256 ||
    knownRefChanged
  ) {
    throw new ReviewInputError("Git state changed during adversarial review preflight. Retry the review.");
  }
  const largeInput = await approveLargeInput({
    ctx: options.ctx,
    target: options.target,
    fingerprint,
    ...(options.allowLarge !== undefined ? { allowLarge: options.allowLarge } : {}),
    ...(options.reqdoc ? { reqdoc: options.reqdoc } : {}),
    ...(options.focus !== undefined ? { focus: options.focus } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.suggestRanges ? { suggestRanges: options.suggestRanges } : {}),
  });
  if (largeInput === undefined) return undefined;
  const sizeSummary = largeInput
    ? ` Large input approved: ${fingerprint.inputSize.bytes} bytes / ${fingerprint.inputSize.lines} lines.`
    : "";
  return {
    target: options.target,
    audit: {
      ...options.audit,
      inputBytes: fingerprint.inputSize.bytes,
      inputLines: fingerprint.inputSize.lines,
      ...(largeInput ? { largeInput: true } : {}),
    },
    summary: `${options.summary}${sizeSummary}`,
    inputSize: fingerprint.inputSize,
    largeInput,
    ...(options.reqdoc ? { reqdoc: options.reqdoc } : {}),
    ...(options.focus !== undefined ? { focus: options.focus } : {}),
    guard: {
      root: fingerprint.root,
      headSha: fingerprint.headSha,
      statusSha256: fingerprint.statusSha256,
      ...(options.state.branch ? { branch: options.state.branch } : {}),
      ...(options.state.preferredRemote ? { remote: options.state.preferredRemote } : {}),
      ...(options.state.defaultBranchRef
        ? { defaultBranchRef: options.state.defaultBranchRef }
        : {}),
      ...(options.state.defaultBranchSha
        ? { defaultBranchSha: options.state.defaultBranchSha }
        : {}),
      ...(options.state.operation ? { operation: options.state.operation } : {}),
      unmerged: options.state.workingTree.unmerged,
      targetSha256: fingerprint.targetSha256,
      inputSha256: fingerprint.inputSha256,
      targetRefs: fingerprint.targetRefs,
    },
  };
}

export async function revalidateReviewPreflight(
  preflight: ResolvedReviewPreflight,
  options: {
    signal?: AbortSignal;
    runner?: PreflightCommandRunner;
    inspect?: typeof inspectGitPreflight;
    fingerprintTarget?: typeof fingerprintReviewTarget;
    frozenTarget?: ReviewTarget;
    frozenInput?: Pick<FrozenReviewInput, "target" | "inputSha256">;
  } = {},
): Promise<boolean> {
  try {
    const inspect = options.inspect ?? inspectGitPreflight;
    const state = await inspect(preflight.guard.root, {
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(preflight.guard.remote ? { preferredRemote: preflight.guard.remote } : {}),
    });
    if (options.signal?.aborted) throw options.signal.reason;
    const currentFingerprint = await (
      options.fingerprintTarget ?? fingerprintReviewTarget
    )({
      cwd: state.root,
      target: preflight.target,
      ...(preflight.reqdoc ? { reqdoc: preflight.reqdoc } : {}),
      ...(preflight.focus !== undefined ? { focus: preflight.focus } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
    });
    const frozenTarget = options.frozenInput?.target ?? options.frozenTarget;
    const frozenFingerprint = frozenTarget
      ? fingerprintFromFrozenTarget(preflight.target, frozenTarget)
      : undefined;
    if (options.signal?.aborted) throw options.signal.reason;
    const guard = preflight.guard;
    const gitFingerprintMatches = (fingerprint: ReviewTargetGitFingerprint) => (
      fingerprint.root === guard.root &&
      fingerprint.headSha === guard.headSha &&
      fingerprint.statusSha256 === guard.statusSha256 &&
      fingerprint.targetSha256 === guard.targetSha256 &&
      JSON.stringify(fingerprint.targetRefs) === JSON.stringify(guard.targetRefs)
    );
    return (
      state.root === guard.root &&
      state.headSha === guard.headSha &&
      state.statusSha256 === guard.statusSha256 &&
      state.branch === guard.branch &&
      state.preferredRemote === guard.remote &&
      state.defaultBranchRef === guard.defaultBranchRef &&
      state.defaultBranchSha === guard.defaultBranchSha &&
      state.operation === guard.operation &&
      state.workingTree.unmerged === guard.unmerged &&
      gitFingerprintMatches(currentFingerprint) &&
      currentFingerprint.inputSha256 === guard.inputSha256 &&
      (frozenFingerprint === undefined || gitFingerprintMatches(frozenFingerprint)) &&
      (options.frozenInput === undefined || options.frozenInput.inputSha256 === guard.inputSha256)
    );
  } catch (error) {
    if (options.signal?.aborted) {
      throw options.signal.reason instanceof Error ? options.signal.reason : error;
    }
    return false;
  }
}

async function fetchWithPolicy(options: {
  ctx: ExtensionCommandContext;
  root: string;
  remote: string;
  signal?: AbortSignal;
  runner?: PreflightCommandRunner;
  fetchTimeoutMs?: number;
  fetch?: typeof fetchReviewRemote;
}): Promise<"succeeded" | "failed-used-local" | undefined> {
  while (true) {
    const result = await (options.fetch ?? fetchReviewRemote)(options.root, options.remote, {
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fetchTimeoutMs !== undefined ? { timeoutMs: options.fetchTimeoutMs } : {}),
    });
    if (result.status === "succeeded") return "succeeded";
    if (options.ctx.mode !== "tui") {
      throw new ReviewInputError(
        `Automatic Git fetch failed for remote ${JSON.stringify(options.remote)}. ` +
          "Pass --local for an explicit offline review, or refresh the remote before retrying.",
      );
    }
    const detail = result.timedOut ? "timed out" : "failed";
    const choice = await options.ctx.ui.select(
      `Git fetch ${detail} for ${display(options.remote)}. How should adversarial review continue?`,
      [RETRY_FETCH, USE_LOCAL_REF, CANCEL_REVIEW],
      options.signal ? { signal: options.signal } : undefined,
    );
    if (choice === RETRY_FETCH) continue;
    if (choice === USE_LOCAL_REF) return "failed-used-local";
    return undefined;
  }
}

async function chooseRemote(
  ctx: ExtensionCommandContext,
  state: GitPreflightState,
  signal?: AbortSignal,
): Promise<string | undefined | null> {
  if (!state.remoteAmbiguous) return state.preferredRemote;
  if (ctx.mode !== "tui") {
    throw new ReviewCommandError(
      "Adversarial review found multiple remotes but no branch upstream or origin. " +
        "Pass --local, --base, or --range explicitly.",
    );
  }
  const labels = state.remotes.map((remote) => `Use remote: ${display(remote)}`);
  const manual = "Continue without fetch and choose target manually";
  const choice = await ctx.ui.select(
    "Multiple Git remotes are available. Choose the remote used to refresh and detect the default branch.",
    [...labels, manual, CANCEL_REVIEW],
    signal ? { signal } : undefined,
  );
  if (!choice || choice === CANCEL_REVIEW) return null;
  if (choice === manual) return undefined;
  const index = labels.indexOf(choice);
  return index >= 0 ? state.remotes[index] : null;
}

function issueTitle(issue: PreflightIssue, state: GitPreflightState): string {
  switch (issue) {
    case "detached-head":
      return "HEAD is detached, so the branch review base is ambiguous.";
    case "git-operation":
      return `A Git ${state.operation ?? "operation"} is in progress.`;
    case "unmerged-files":
      return "The working tree contains unmerged files.";
    case "ambiguous-remote":
      return "Multiple remotes are available without a preferred upstream.";
    case "missing-remote":
      return "No Git remote is available for automatic base detection.";
    case "ambiguous-default-branch":
      return `Remote ${display(state.preferredRemote ?? "(none)")} has both main and master but no default-branch HEAD.`;
    case "missing-default-branch":
      return `The default branch for remote ${display(state.preferredRemote ?? "(none)")} could not be determined.`;
    case "missing-relation":
      return "The relation between HEAD and the remote default branch could not be determined.";
    case "default-branch-ahead":
      return "The default branch contains local commits that are not on its remote.";
    case "default-branch-diverged":
      return "The local default branch and its remote have diverged.";
    case "default-branch-behind":
      return "The dirty default branch is behind its freshly fetched remote.";
  }
}

async function customBase(
  ctx: ExtensionCommandContext,
  signal?: AbortSignal,
): Promise<ReviewTargetRequest | undefined> {
  const value = await ctx.ui.input(
    "Base Git ref",
    "for example origin/main or HEAD~3",
    signal ? { signal } : undefined,
  );
  const baseRef = value?.trim();
  return baseRef ? { mode: "base", baseRef } : undefined;
}

async function chooseExceptionalTarget(
  ctx: ExtensionCommandContext,
  state: GitPreflightState,
  issue: PreflightIssue,
  signal?: AbortSignal,
): Promise<ReviewTargetRequest | undefined> {
  if (ctx.mode !== "tui") {
    throw new ReviewCommandError(
      `${issueTitle(issue, state)} Pass --local, --base <ref>, or --range <from>..<to> explicitly.`,
    );
  }

  const dirty = hasLocalChanges(state);
  const baseRef = state.defaultBranchRef;
  const combined = baseRef
    ? `Review committed + local changes from ${display(baseRef)}`
    : undefined;
  const committed = baseRef && (state.ahead ?? 0) > 0
    ? `Review committed changes only: ${display(baseRef)}..HEAD`
    : undefined;
  const local = dirty ? "Review local uncommitted changes only" : undefined;
  const candidateBases = state.defaultBranchCandidates.map(
    (candidate) => `Review committed + local changes from ${display(candidate)}`,
  );
  const risky = issue === "git-operation" || issue === "unmerged-files" || issue === "default-branch-behind";
  const options = [
    ...(risky ? [`${CANCEL_REVIEW} (recommended)`] : []),
    ...(combined ? [combined] : []),
    ...candidateBases,
    ...(committed ? [committed] : []),
    ...(local ? [local] : []),
    ENTER_CUSTOM_BASE,
    ...(!risky ? [CANCEL_REVIEW] : []),
  ];
  const choice = await ctx.ui.select(
    `${issueTitle(issue, state)} Choose the exact review target before reviewers start.`,
    options,
    signal ? { signal } : undefined,
  );
  if (!choice || choice.startsWith(CANCEL_REVIEW)) return undefined;
  if (choice === combined && baseRef) return { mode: "base", baseRef };
  const candidateIndex = candidateBases.indexOf(choice);
  if (candidateIndex >= 0) {
    return { mode: "base", baseRef: state.defaultBranchCandidates[candidateIndex] };
  }
  if (choice === committed && baseRef) return { mode: "range", fromRef: baseRef, toRef: "HEAD" };
  if (choice === local) return { mode: "local" };
  if (choice === ENTER_CUSTOM_BASE) return customBase(ctx, signal);
  return undefined;
}

export async function resolveReviewPreflight(
  options: ResolveReviewPreflightOptions,
): Promise<ResolvedReviewPreflight | undefined> {
  const inspect = options.inspect ?? inspectGitPreflight;
  let state = await inspect(options.ctx.cwd, {
    ...(options.runner ? { runner: options.runner } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
  });
  const attemptedRemotes: string[] = [];
  const fetchedRemotes: string[] = [];
  let fetchStatus: ReviewTargetPreflight["fetchStatus"] = "not-needed";

  if (options.targetExplicit) {
    const remotes = remotesReferencedByTarget(options.target, state.remotes);
    for (const remote of remotes) {
      attemptedRemotes.push(remote);
      const status = await fetchWithPolicy({
        ctx: options.ctx,
        root: state.root,
        remote,
        ...(options.signal ? { signal: options.signal } : {}),
        ...(options.runner ? { runner: options.runner } : {}),
        ...(options.fetchTimeoutMs !== undefined ? { fetchTimeoutMs: options.fetchTimeoutMs } : {}),
        ...(options.fetch ? { fetch: options.fetch } : {}),
      });
      if (status === undefined) return undefined;
      if (status === "succeeded") fetchedRemotes.push(remote);
      fetchStatus = status === "failed-used-local" ? status : fetchStatus === "not-needed" ? "succeeded" : fetchStatus;
    }
    if (attemptedRemotes.length > 0) {
      state = await inspect(options.ctx.cwd, {
        ...(options.runner ? { runner: options.runner } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
        preferredRemote: attemptedRemotes[0],
      });
    }
    const audit = buildAudit({
      state,
      selection: "explicit",
      fetchStatus,
      attemptedRemotes,
      fetchedRemotes,
    });
    return finalizePreflight({
      ctx: options.ctx,
      state,
      target: options.target,
      audit,
      summary: summaryText(options.target, audit),
      ...(options.allowLarge !== undefined ? { allowLarge: options.allowLarge } : {}),
      ...(options.reqdoc ? { reqdoc: options.reqdoc } : {}),
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fingerprintTarget
        ? { fingerprintTarget: options.fingerprintTarget }
        : {}),
      ...(options.suggestRanges ? { suggestRanges: options.suggestRanges } : {}),
    });
  }

  const selectedRemote = await chooseRemote(options.ctx, state, options.signal);
  if (selectedRemote === null) return undefined;
  if (selectedRemote) {
    attemptedRemotes.push(selectedRemote);
    const status = await fetchWithPolicy({
      ctx: options.ctx,
      root: state.root,
      remote: selectedRemote,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.fetchTimeoutMs !== undefined ? { fetchTimeoutMs: options.fetchTimeoutMs } : {}),
      ...(options.fetch ? { fetch: options.fetch } : {}),
    });
    if (status === undefined) return undefined;
    if (status === "succeeded") fetchedRemotes.push(selectedRemote);
    fetchStatus = status;
    state = await inspect(options.ctx.cwd, {
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      preferredRemote: selectedRemote,
    });
  } else if (state.remoteAmbiguous) {
    state = { ...state, remoteAmbiguous: false };
  }

  const inferred = inferReviewTarget(state);
  if (inferred.kind === "empty") throw new EmptyReviewInputError();
  let target: ReviewTargetRequest;
  let selection: ReviewTargetPreflight["selection"];
  if (inferred.kind === "auto") {
    target = inferred.target;
    selection = "inferred";
  } else {
    const picked = await chooseExceptionalTarget(
      options.ctx,
      state,
      inferred.issue,
      options.signal,
    );
    if (!picked) return undefined;
    target = picked;
    selection = "interactive";
  }
  const audit = buildAudit({
    state,
    selection,
    fetchStatus,
    attemptedRemotes,
    fetchedRemotes,
  });
  return finalizePreflight({
    ctx: options.ctx,
    state,
    target,
    audit,
    summary: summaryText(target, audit),
    ...(options.allowLarge !== undefined ? { allowLarge: options.allowLarge } : {}),
    ...(options.reqdoc ? { reqdoc: options.reqdoc } : {}),
    ...(options.focus !== undefined ? { focus: options.focus } : {}),
    ...(options.signal ? { signal: options.signal } : {}),
    ...(options.fingerprintTarget
      ? { fingerprintTarget: options.fingerprintTarget }
      : {}),
    ...(options.suggestRanges ? { suggestRanges: options.suggestRanges } : {}),
  });
}
