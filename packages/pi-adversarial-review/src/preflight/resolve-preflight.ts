import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { ReviewCommandError } from "../command/parse-args.ts";
import {
  EmptyReviewInputError,
  OversizedReviewInputError,
  ReviewInputError,
  type ReviewRangePlan,
  type ReviewRangePlanItem,
} from "../input/errors.ts";
import {
  fingerprintReviewTarget,
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
  listInteractiveRangeStarts,
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
const CHOOSE_CONTINUOUS_RANGE = "Choose a continuous range ending at HEAD";
const CHOOSE_COMMIT_PLAN = "Review by commit plan";
const BACK_TO_LARGE_TARGET = "Back to whole-target choices";
const REVIEW_LARGE_COMMIT = "Review this large commit";
const BACK_TO_COMMIT_PLAN = "Back to commit plan";

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
  interactiveRange?: boolean;
  allowLarge?: boolean;
  reqdoc?: string;
  focus?: string;
  signal?: AbortSignal;
  runner?: PreflightCommandRunner;
  fetchTimeoutMs?: number;
  inspect?: typeof inspectGitPreflight;
  fetch?: typeof fetchReviewRemote;
  listRangeStarts?: typeof listInteractiveRangeStarts;
  fingerprintTarget?: typeof fingerprintReviewTarget;
  suggestRanges?: typeof suggestReviewRanges;
}

function display(value: string): string {
  return safeReviewDiagnosticText(value).slice(0, 160);
}

interface StableSelectOption<T> {
  label: string;
  value: T;
}

/** Preserve ordinary labels, but add an index before every colliding label. */
function stableSelectOptions<T>(options: StableSelectOption<T>[]): StableSelectOption<T>[] {
  const labels = options.map(({ label }) => label);
  if (new Set(labels).size === labels.length) return options;
  return options.map((option, index) => ({
    ...option,
    label: `[${index + 1}] ${option.label}`,
  }));
}

function selectedValue<T>(
  options: readonly StableSelectOption<T>[],
  label: string | undefined,
): T | undefined {
  return options.find((option) => option.label === label)?.value;
}

type SuggestedRangeTarget = Extract<ReviewTargetRequest, { mode: "range" }>;
type SuggestedRangePickerResult =
  | { kind: "range"; target: SuggestedRangeTarget; allowLarge: boolean }
  | { kind: "back" }
  | { kind: "cancel" }
  | { kind: "unavailable" };

function parseSuggestedRangeCommand(command: string): SuggestedRangeTarget | undefined {
  const match = /^--range ([0-9a-f]{40}|[0-9a-f]{64})\.\.([0-9a-f]{40}|[0-9a-f]{64})$/u.exec(command);
  if (!match?.[1] || !match[2] || match[1].length !== match[2].length) return undefined;
  return { mode: "range", fromRef: match[1], toRef: match[2] };
}

function oneLine(value: string, maxLength = 72): string {
  const cleaned = safeReviewDiagnosticText(value)
    .replace(/[\u202a-\u202e\u2066-\u2069]/gu, "�")
    .replace(/\s+/gu, " ")
    .trim();
  if (!cleaned) return "(no subject)";
  const points = [...cleaned];
  return points.length <= maxLength
    ? cleaned
    : `${points.slice(0, maxLength - 1).join("")}…`;
}

function formatCount(value: number): string {
  return String(value).replace(/\B(?=(\d{3})+(?!\d))/gu, ",");
}

function formatInputSize(size: { bytes: number; lines: number }): string {
  const bytes = size.bytes < 1024
    ? `${size.bytes} B`
    : size.bytes < 1024 * 1024
      ? `${(size.bytes / 1024).toFixed(1)} KiB`
      : `${(size.bytes / (1024 * 1024)).toFixed(2)} MiB`;
  return `${bytes} / ${formatCount(size.lines)} lines`;
}

function planItemTarget(item: ReviewRangePlanItem): SuggestedRangeTarget | undefined {
  return parseSuggestedRangeCommand(`--range ${item.fromSha}..${item.toSha}`);
}

function planItemLabel(item: ReviewRangePlanItem, totalCommits: number): string {
  const position = item.commitCount === 1
    ? `${item.firstCommit.ordinal}/${totalCommits}`
    : `${item.firstCommit.ordinal}–${item.lastCommit.ordinal}/${totalCommits}`;
  const subjects = item.commitCount === 1
    ? oneLine(item.firstCommit.subject)
    : `${oneLine(item.firstCommit.subject, 38)} → ${oneLine(item.lastCommit.subject, 38)}`;
  const identity = item.commitCount === 1
    ? item.firstCommit.sha.slice(0, 7)
    : `${item.firstCommit.sha.slice(0, 7)}..${item.lastCommit.sha.slice(0, 7)}`;
  const size = item.inputSize ? ` · ${formatInputSize(item.inputSize)}` : "";
  const files = item.changedFileCount === undefined
    ? ""
    : ` · ${item.changedFileCount} ${item.changedFileCount === 1 ? "file" : "files"}`;
  const state = item.kind === "bounded"
    ? "✓"
    : item.kind === "large-single" ? "⚠" : "✗";
  const status = item.kind === "large-single"
    ? "approval required"
    : item.kind === "too-large-single" ? "exceeds absolute limit" : "bounded";
  const count = item.commitCount > 1 ? ` · ${item.commitCount} commits` : "";
  return `${state} ${position}${count} · ${status}${size}${files} · ${subjects} · ${identity}`;
}

function commitPlanTitle(plan: ReviewRangePlan): string {
  const accounted = plan.items.reduce((sum, item) => sum + item.commitCount, 0) +
    plan.emptyCommitCount;
  const bounded = plan.items.filter(({ kind }) => kind === "bounded").length;
  const large = plan.items.filter(({ kind }) => kind === "large-single").length;
  const blocked = plan.items.filter(({ kind }) => kind === "too-large-single").length;
  const details = [
    `${accounted}/${plan.targetCommitCount} commits accounted for`,
    `${bounded} bounded ${bounded === 1 ? "segment" : "segments"}`,
    ...(large > 0 ? [`${large} large ${large === 1 ? "commit needs" : "commits need"} approval`] : []),
    ...(blocked > 0 ? [`${blocked} ${blocked === 1 ? "commit exceeds" : "commits exceed"} the absolute limit`] : []),
    ...(plan.emptyCommitCount > 0 ? [`${plan.emptyCommitCount} empty`] : []),
  ];
  return `Commit review plan · ${details.join(" · ")}. Choose one item now; run the others separately.`;
}

async function confirmLargeCommit(options: {
  ctx: ExtensionCommandContext;
  item: ReviewRangePlanItem;
  target: SuggestedRangeTarget;
  signal?: AbortSignal;
}): Promise<SuggestedRangePickerResult | { kind: "plan" }> {
  const size = options.item.inputSize
    ? formatInputSize(options.item.inputSize)
    : "size below the absolute limit";
  const files = options.item.changedFileCount === undefined
    ? ""
    : ` · ${options.item.changedFileCount} ${options.item.changedFileCount === 1 ? "file" : "files"}`;
  const choice = await options.ctx.ui.select(
    `Commit ${options.item.firstCommit.ordinal} · ${oneLine(options.item.firstCommit.subject)} · ` +
      `${options.item.firstCommit.sha.slice(0, 12)} · ${size}${files}. ` +
      "It exceeds the recommended review size and may reduce precision.",
    [REVIEW_LARGE_COMMIT, BACK_TO_COMMIT_PLAN, CANCEL_REVIEW],
    options.signal ? { signal: options.signal } : undefined,
  );
  if (choice === REVIEW_LARGE_COMMIT) {
    return { kind: "range", target: options.target, allowLarge: true };
  }
  if (choice === BACK_TO_COMMIT_PLAN) return { kind: "plan" };
  return { kind: "cancel" };
}

async function chooseSuggestedRange(options: {
  ctx: ExtensionCommandContext;
  commands: readonly string[];
  plan?: ReviewRangePlan;
  note?: string;
  signal?: AbortSignal;
  allowBack: boolean;
}): Promise<SuggestedRangePickerResult> {
  type Choice =
    | { kind: "range"; target: SuggestedRangeTarget; item?: ReviewRangePlanItem }
    | { kind: "blocked"; item: ReviewRangePlanItem }
    | { kind: "back" }
    | { kind: "cancel" };

  const planChoices: StableSelectOption<Choice>[] = [];
  for (const item of options.plan?.items ?? []) {
    const target = planItemTarget(item);
    if (!target) continue;
    planChoices.push({
      label: planItemLabel(item, options.plan!.targetCommitCount),
      value: item.kind === "too-large-single"
        ? { kind: "blocked", item }
        : { kind: "range", target, item },
    });
  }

  const targets = new Map<string, SuggestedRangeTarget>();
  if (planChoices.length === 0) {
    for (const command of options.commands) {
      const target = parseSuggestedRangeCommand(command);
      if (target) targets.set(`${target.fromRef}..${target.toRef}`, target);
    }
  }
  if (planChoices.length === 0 && targets.size === 0) return { kind: "unavailable" };

  if (options.plan?.requiresSeparateLocalReview) {
    options.ctx.ui.notify(
      "This commit plan excludes staged, unstaged, and untracked work; review those separately with /adversarial-review --local.",
      "warning",
    );
  } else if (!options.plan && options.note) {
    options.ctx.ui.notify(safeReviewDiagnosticText(options.note), "warning");
  }
  if (options.plan && options.plan.analyzedCommitCount < options.plan.targetCommitCount) {
    options.ctx.ui.notify(
      `Automatic analysis covered ${options.plan.analyzedCommitCount}/${options.plan.targetCommitCount} commits. Continue the remaining path in another run.`,
      "warning",
    );
  }

  const fallbackRanges = [...targets.values()];
  const choices = stableSelectOptions<Choice>([
    ...planChoices,
    ...fallbackRanges.map((target, index) => ({
      label: `Range ${index + 1}/${fallbackRanges.length} · ${target.fromRef.slice(0, 12)}..${target.toRef.slice(0, 12)}`,
      value: { kind: "range" as const, target },
    })),
    ...(options.allowBack
      ? [{ label: BACK_TO_LARGE_TARGET, value: { kind: "back" as const } }]
      : []),
    { label: CANCEL_REVIEW, value: { kind: "cancel" } },
  ]);

  while (true) {
    const pickedLabel = await options.ctx.ui.select(
      options.plan
        ? commitPlanTitle(options.plan)
        : "Choose one bounded committed range to review now. Run remaining ranges separately; all non-target options are preserved.",
      choices.map(({ label }) => label),
      options.signal ? { signal: options.signal } : undefined,
    );
    const picked = selectedValue(choices, pickedLabel) ?? { kind: "cancel" as const };
    if (picked.kind === "blocked") {
      options.ctx.ui.notify(
        `Commit ${picked.item.firstCommit.ordinal}/${options.plan?.targetCommitCount ?? "?"} ` +
          `${oneLine(picked.item.firstCommit.subject)} exceeds the absolute frozen-input limit. ` +
          "Reduce attached context or split the commit before review.",
        "error",
      );
      continue;
    }
    if (picked.kind === "range" && picked.item?.kind === "large-single") {
      const confirmed = await confirmLargeCommit({
        ctx: options.ctx,
        item: picked.item,
        target: picked.target,
        ...(options.signal ? { signal: options.signal } : {}),
      });
      if (confirmed.kind === "plan") continue;
      return confirmed;
    }
    if (picked.kind === "range") {
      return { kind: "range", target: picked.target, allowLarge: false };
    }
    return picked;
  }
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

type LargeInputDecision =
  | { kind: "continue"; largeInput: boolean }
  | { kind: "range"; target: SuggestedRangeTarget; allowLarge: boolean }
  | {
      kind: "interactive-range";
      picker: InteractiveRangePicker;
      selection: InteractiveRangeSelection;
    };

type InteractiveRangePickerFactory = () => Promise<InteractiveRangePicker>;

async function approveLargeInput(options: {
  ctx: ExtensionCommandContext;
  target: ReviewTargetRequest;
  fingerprint: ReviewTargetFingerprint;
  allowLarge?: boolean;
  reqdoc?: string;
  focus?: string;
  signal?: AbortSignal;
  suggestRanges?: typeof suggestReviewRanges;
  interactiveRangePicker?: InteractiveRangePickerFactory;
  allowAutomaticCommitPlan?: boolean;
}): Promise<LargeInputDecision | undefined> {
  if (!exceedsRecommendedInput(options.fingerprint.inputSize)) {
    return { kind: "continue", largeInput: false };
  }
  if (options.allowLarge) return { kind: "continue", largeInput: true };
  const { bytes, lines } = options.fingerprint.inputSize;
  if (options.ctx.mode !== "tui") {
    throw new ReviewCommandError(
      `Frozen review input exceeds the recommended threshold (${recommendedExcessText(options.fingerprint.inputSize)}). ` +
        "Pass --allow-large to review it whole, or use a smaller --range target.",
    );
  }

  let canChooseRange = options.target.mode !== "local" &&
    (options.interactiveRangePicker !== undefined || options.allowAutomaticCommitPlan !== false);
  let cachedSuggestions: Awaited<ReturnType<typeof suggestReviewRanges>> | undefined;
  let suggestionAttempted = false;
  while (true) {
    const rangeChoice = options.interactiveRangePicker
      ? CHOOSE_CONTINUOUS_RANGE
      : CHOOSE_COMMIT_PLAN;
    const choices = [
      REVIEW_WHOLE_TARGET,
      ...(canChooseRange ? [rangeChoice] : []),
      CANCEL_REVIEW,
    ];
    const choice = await options.ctx.ui.select(
      `Frozen review input is ${bytes} bytes / ${lines} lines. ` +
        "Large targets use more reviewer turns and may reduce review precision.",
      choices,
      options.signal ? { signal: options.signal } : undefined,
    );
    if (choice === REVIEW_WHOLE_TARGET) {
      return { kind: "continue", largeInput: true };
    }
    if (choice === CHOOSE_CONTINUOUS_RANGE && options.interactiveRangePicker) {
      const picker = await options.interactiveRangePicker();
      const selection = await picker.pick({
        reason: "Choose one continuous range for this review.",
      });
      return selection ? { kind: "interactive-range", picker, selection } : undefined;
    }
    if (choice !== CHOOSE_COMMIT_PLAN) return undefined;

    if (!suggestionAttempted) {
      suggestionAttempted = true;
      try {
        cachedSuggestions = await (options.suggestRanges ?? suggestReviewRanges)({
          root: options.fingerprint.root,
          target: options.target,
          resolvedTarget: options.fingerprint.resolvedTarget,
          ...(options.reqdoc ? { reqdoc: options.reqdoc } : {}),
          ...(options.focus !== undefined ? { focus: options.focus } : {}),
          ...(options.signal ? { signal: options.signal } : {}),
          maxBytes: RECOMMENDED_FROZEN_INPUT_BYTES,
          maxLines: RECOMMENDED_FROZEN_INPUT_LINES,
        });
      } catch (error) {
        if (options.signal?.aborted) throw error;
        options.ctx.ui.notify(
          safeReviewDiagnosticText(
            `Adversarial review could not generate bounded range choices: ${display(error instanceof Error ? error.message : String(error))}`,
          ),
          "warning",
        );
      }
    }

    const picked = await chooseSuggestedRange({
      ctx: options.ctx,
      commands: cachedSuggestions?.commands ?? [],
      ...(cachedSuggestions?.plan ? { plan: cachedSuggestions.plan } : {}),
      ...(cachedSuggestions?.note ? { note: cachedSuggestions.note } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      allowBack: true,
    });
    if (picked.kind === "range") return picked;
    if (picked.kind === "cancel") return undefined;
    if (picked.kind === "unavailable") {
      canChooseRange = false;
      options.ctx.ui.notify(
        "Adversarial review found no non-empty committed range within the recommended threshold. Choose whole-target review or cancel.",
        "warning",
      );
    }
  }
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
  interactiveRange?: InteractiveRangeControl;
  interactiveRangePicker?: InteractiveRangePickerFactory;
  allowAutomaticCommitPlan?: boolean;
}): Promise<ResolvedReviewPreflight | undefined> {
  if (options.signal?.aborted) throw options.signal.reason;
  let fingerprint: ReviewTargetFingerprint;
  try {
    fingerprint = await (options.fingerprintTarget ?? fingerprintReviewTarget)({
      cwd: options.state.root,
      target: options.target,
      ...(options.reqdoc ? { reqdoc: options.reqdoc } : {}),
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.interactiveRange || options.interactiveRangePicker ||
          options.allowAutomaticCommitPlan === false
        ? { suggestRangesOnOversize: false }
        : {}),
    });
  } catch (error) {
    if (options.interactiveRange && error instanceof OversizedReviewInputError) {
      const count = options.interactiveRange.selection.commitCount;
      if (count <= 1) {
        options.ctx.ui.notify(
          "This commit cannot be reviewed because its frozen input exceeds the safety limit. Reduce attached context or split the commit.",
          "error",
        );
        return undefined;
      }
      const selected = await options.interactiveRange.picker.pick({
        maxCommitCount: count - 1,
        reason: `The selected ${count} commits cannot be reviewed together because the frozen input exceeds the safety limit.`,
      });
      if (!selected) return undefined;
      const audit = {
        ...options.audit,
        selection: "interactive" as const,
        selectedCommitCount: selected.commitCount,
      };
      return finalizePreflight({
        ...options,
        target: selected.target,
        audit,
        summary: summaryText(selected.target, audit),
        allowLarge: false,
        interactiveRange: {
          picker: options.interactiveRange.picker,
          selection: selected,
        },
      });
    }
    if (options.interactiveRangePicker && error instanceof OversizedReviewInputError) {
      const picker = await options.interactiveRangePicker();
      const selected = await picker.pick({
        reason: "The whole target cannot be reviewed because its frozen input exceeds the safety limit.",
      });
      if (!selected) return undefined;
      const audit = {
        ...options.audit,
        selection: "interactive" as const,
        selectedCommitCount: selected.commitCount,
      };
      return finalizePreflight({
        ...options,
        target: selected.target,
        audit,
        summary: summaryText(selected.target, audit),
        allowLarge: false,
        interactiveRange: { picker, selection: selected },
      });
    }
    if (
      options.ctx.mode !== "tui" ||
      !(error instanceof OversizedReviewInputError) ||
      options.target.mode === "local" ||
      options.allowAutomaticCommitPlan === false ||
      (error.rangeSuggestions.length === 0 && error.rangePlan === undefined)
    ) {
      throw error;
    }
    options.ctx.ui.notify(
      "Adversarial review cannot review the whole target because it exceeds the absolute frozen-input limit. Choose a bounded committed range or cancel.",
      "warning",
    );
    const picked = await chooseSuggestedRange({
      ctx: options.ctx,
      commands: error.rangeSuggestions,
      ...(error.rangePlan ? { plan: error.rangePlan } : {}),
      ...(error.rangeSuggestionNote ? { note: error.rangeSuggestionNote } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      allowBack: false,
    });
    if (picked.kind !== "range") {
      if (picked.kind === "unavailable") throw error;
      return undefined;
    }
    const audit = { ...options.audit, selection: "interactive" as const };
    return finalizePreflight({
      ...options,
      target: picked.target,
      audit,
      summary: summaryText(picked.target, audit),
      allowLarge: picked.allowLarge,
    });
  }
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
  let decision: LargeInputDecision | undefined;
  if (
    options.interactiveRange &&
    exceedsRecommendedInput(fingerprint.inputSize) &&
    !options.allowLarge
  ) {
    const count = options.interactiveRange.selection.commitCount;
    const reviewAll = `Review all ${count} selected ${count === 1 ? "commit" : "commits"} together`;
    const chooseCloser = "Choose a closer start commit";
    const choice = await options.ctx.ui.select(
      `The selected range contains ${count} ${count === 1 ? "commit" : "commits"} and its frozen input is ` +
        `${formatInputSize(fingerprint.inputSize)}. It exceeds the recommended review size but remains below the safety limit.`,
      [reviewAll, ...(count > 1 ? [chooseCloser] : []), CANCEL_REVIEW],
      options.signal ? { signal: options.signal } : undefined,
    );
    if (choice === reviewAll) {
      decision = { kind: "continue", largeInput: true };
    } else if (choice === chooseCloser) {
      const selected = await options.interactiveRange.picker.pick({
        maxCommitCount: count - 1,
        reason: `The previous start selected ${count} commits, which exceeded the recommended review size.`,
      });
      if (!selected) return undefined;
      const audit = {
        ...options.audit,
        selection: "interactive" as const,
        selectedCommitCount: selected.commitCount,
      };
      return finalizePreflight({
        ...options,
        target: selected.target,
        audit,
        summary: summaryText(selected.target, audit),
        allowLarge: false,
        interactiveRange: {
          picker: options.interactiveRange.picker,
          selection: selected,
        },
      });
    } else {
      return undefined;
    }
  } else {
    decision = await approveLargeInput({
      ctx: options.ctx,
      target: options.target,
      fingerprint,
      ...(options.allowLarge !== undefined ? { allowLarge: options.allowLarge } : {}),
      ...(options.reqdoc ? { reqdoc: options.reqdoc } : {}),
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.suggestRanges ? { suggestRanges: options.suggestRanges } : {}),
      ...(options.interactiveRangePicker
        ? { interactiveRangePicker: options.interactiveRangePicker }
        : {}),
      ...(options.allowAutomaticCommitPlan !== undefined
        ? { allowAutomaticCommitPlan: options.allowAutomaticCommitPlan }
        : {}),
    });
  }
  if (decision === undefined) return undefined;
  if (decision.kind === "interactive-range") {
    const audit = {
      ...options.audit,
      selection: "interactive" as const,
      selectedCommitCount: decision.selection.commitCount,
    };
    return finalizePreflight({
      ...options,
      target: decision.selection.target,
      audit,
      summary: summaryText(decision.selection.target, audit),
      allowLarge: false,
      interactiveRange: {
        picker: decision.picker,
        selection: decision.selection,
      },
    });
  }
  if (decision.kind === "range") {
    const audit = { ...options.audit, selection: "interactive" as const };
    return finalizePreflight({
      ...options,
      target: decision.target,
      audit,
      summary: summaryText(decision.target, audit),
      allowLarge: decision.allowLarge,
    });
  }
  const { largeInput } = decision;
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
  type RemoteChoice =
    | { kind: "remote"; remote: string }
    | { kind: "manual" }
    | { kind: "cancel" };
  const choices = stableSelectOptions<RemoteChoice>([
    ...state.remotes.map((remote) => ({
      label: `Use remote: ${display(remote)}`,
      value: { kind: "remote" as const, remote },
    })),
    {
      label: "Continue without fetch and choose target manually",
      value: { kind: "manual" },
    },
    { label: CANCEL_REVIEW, value: { kind: "cancel" } },
  ]);
  const pickedLabel = await ctx.ui.select(
    "Multiple Git remotes are available. Choose the remote used to refresh and detect the default branch.",
    choices.map(({ label }) => label),
    signal ? { signal } : undefined,
  );
  const picked = selectedValue(choices, pickedLabel);
  if (!picked || picked.kind === "cancel") return null;
  if (picked.kind === "manual") return undefined;
  return picked.remote;
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

function assertInteractiveRangeContext(
  ctx: ExtensionCommandContext,
  state: GitPreflightState,
): asserts state is GitPreflightState & { branch: string } {
  if (ctx.mode !== "tui") {
    throw new ReviewCommandError(
      'Interactive --range requires TUI mode. Outside TUI, pass --range "<refA>..<refB>".',
    );
  }
  if (!state.branch) {
    throw new ReviewCommandError(
      "Interactive --range requires the current worktree to be on a named branch.",
    );
  }
  if (state.operation || state.workingTree.unmerged) {
    throw new ReviewCommandError(
      "Interactive --range is unavailable during a Git operation or with unmerged files.",
    );
  }
}

interface InteractiveRangeSelection {
  target: SuggestedRangeTarget;
  commitCount: number;
}

interface InteractiveRangePicker {
  pick(options?: {
    maxCommitCount?: number;
    reason?: string;
  }): Promise<InteractiveRangeSelection | undefined>;
}

interface InteractiveRangeControl {
  picker: InteractiveRangePicker;
  selection: InteractiveRangeSelection;
}

async function createInteractiveRangePicker(options: {
  ctx: ExtensionCommandContext;
  state: GitPreflightState;
  signal?: AbortSignal;
  runner?: PreflightCommandRunner;
  listRangeStarts?: typeof listInteractiveRangeStarts;
  boundarySha?: string;
}): Promise<InteractiveRangePicker> {
  assertInteractiveRangeContext(options.ctx, options.state);
  const branch = options.state.branch;

  const boundarySha = options.boundarySha ?? (
    options.state.defaultBranchSha && options.state.branch !== options.state.defaultBranch
      ? options.state.defaultBranchSha
      : undefined
  );
  const result = await (options.listRangeStarts ?? listInteractiveRangeStarts)(
    options.state.root,
    options.state.headSha,
    {
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(boundarySha ? { boundarySha } : {}),
    },
  );
  if (result.starts.length === 0) {
    throw new ReviewCommandError(
      result.mergeBaseSha
        ? "There are no first-parent commits after the default-branch merge-base to review."
        : "Current HEAD has no parent, so there is no commit range ending at HEAD to review.",
    );
  }
  if (result.truncated) {
    options.ctx.ui.notify(
      `Interactive range selection shows the latest ${result.starts.length} first-parent commits. Use an explicit --range A..B for older history.`,
      "warning",
    );
  }
  if (!result.mergeBaseSha && options.state.branch !== options.state.defaultBranch) {
    options.ctx.ui.notify(
      "The default-branch boundary could not be proven; interactive range choices use locally available first-parent history.",
      "warning",
    );
  }
  if (options.state.shallow) {
    options.ctx.ui.notify(
      "This is a shallow repository; interactive range choices include only locally available first-parent history.",
      "warning",
    );
  }
  if (hasLocalChanges(options.state)) {
    options.ctx.ui.notify(
      "Interactive range review includes committed changes only. Review staged, unstaged, and untracked work separately with /adversarial-review --local.",
      "warning",
    );
  }

  return {
    async pick(pickOptions = {}) {
      type Choice =
        | { kind: "range"; parentSha: string; commitCount: number }
        | { kind: "cancel" };
      const starts = result.starts.filter((start) => (
        pickOptions.maxCommitCount === undefined ||
        start.commitCount <= pickOptions.maxCommitCount
      ));
      const choices = stableSelectOptions<Choice>([
        ...starts.map((start) => ({
          label: `Start ${start.commitSha.slice(0, 7)} · reviews ${start.commitCount} ` +
            `${start.commitCount === 1 ? "commit" : "commits"} · ${oneLine(start.subject)}`,
          value: {
            kind: "range" as const,
            parentSha: start.parentSha,
            commitCount: start.commitCount,
          },
        })),
        { label: CANCEL_REVIEW, value: { kind: "cancel" } },
      ]);
      const reason = pickOptions.reason ? `${pickOptions.reason} ` : "";
      const pickedLabel = await options.ctx.ui.select(
        `${reason}End is fixed at HEAD ${options.state.headSha.slice(0, 12)} on ` +
          `${oneLine(branch, 60)}. Choose the earliest commit to include; ` +
          "each row is one continuous review range and includes the shown commit." +
          (result.mergeBaseSha ? " Choices stop at the default-branch merge-base." : ""),
        choices.map(({ label }) => label),
        options.signal ? { signal: options.signal } : undefined,
      );
      const picked = selectedValue(choices, pickedLabel);
      if (!picked || picked.kind === "cancel") return undefined;
      return {
        target: {
          mode: "range",
          fromRef: picked.parentSha,
          toRef: options.state.headSha,
        },
        commitCount: picked.commitCount,
      };
    },
  };
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

  type TargetChoice =
    | { kind: "target"; target: ReviewTargetRequest }
    | { kind: "custom" }
    | { kind: "cancel" };
  const dirty = hasLocalChanges(state);
  const baseRef = state.defaultBranchRef;
  const risky = issue === "git-operation" || issue === "unmerged-files" || issue === "default-branch-behind";
  const choices = stableSelectOptions<TargetChoice>([
    ...(risky
      ? [{ label: `${CANCEL_REVIEW} (recommended)`, value: { kind: "cancel" as const } }]
      : []),
    ...(baseRef
      ? [{
          label: `Review committed + local changes from ${display(baseRef)}`,
          value: { kind: "target" as const, target: { mode: "base" as const, baseRef } },
        }]
      : []),
    ...state.defaultBranchCandidates.map((candidate) => ({
      label: `Review committed + local changes from ${display(candidate)}`,
      value: {
        kind: "target" as const,
        target: { mode: "base" as const, baseRef: candidate },
      },
    })),
    ...(baseRef && (state.ahead ?? 0) > 0
      ? [{
          label: `Review committed changes only: ${display(baseRef)}..HEAD`,
          value: {
            kind: "target" as const,
            target: { mode: "range" as const, fromRef: baseRef, toRef: "HEAD" },
          },
        }]
      : []),
    ...(dirty
      ? [{
          label: "Review local uncommitted changes only",
          value: { kind: "target" as const, target: { mode: "local" as const } },
        }]
      : []),
    { label: ENTER_CUSTOM_BASE, value: { kind: "custom" } },
    ...(!risky ? [{ label: CANCEL_REVIEW, value: { kind: "cancel" as const } }] : []),
  ]);
  const pickedLabel = await ctx.ui.select(
    `${issueTitle(issue, state)} Choose the exact review target before reviewers start.`,
    choices.map(({ label }) => label),
    signal ? { signal } : undefined,
  );
  const picked = selectedValue(choices, pickedLabel);
  if (!picked || picked.kind === "cancel") return undefined;
  if (picked.kind === "custom") return customBase(ctx, signal);
  return picked.target;
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

  if (options.interactiveRange) {
    if (!options.targetExplicit) {
      throw new ReviewCommandError("Interactive --range must be an explicit target selection.");
    }
    // Reject unsafe repository states before any network activity. State is
    // checked again after fetch/re-inspection immediately before the picker.
    assertInteractiveRangeContext(options.ctx, state);
  }

  if (options.targetExplicit && !options.interactiveRange) {
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

  if (options.interactiveRange) {
    const picker = await createInteractiveRangePicker({
      ctx: options.ctx,
      state,
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.runner ? { runner: options.runner } : {}),
      ...(options.listRangeStarts ? { listRangeStarts: options.listRangeStarts } : {}),
    });
    const selected = await picker.pick();
    if (!selected) return undefined;
    const audit = {
      ...buildAudit({
        state,
        selection: "interactive",
        fetchStatus,
        attemptedRemotes,
        fetchedRemotes,
      }),
      selectedCommitCount: selected.commitCount,
    };
    return finalizePreflight({
      ctx: options.ctx,
      state,
      target: selected.target,
      audit,
      summary: summaryText(selected.target, audit),
      ...(options.allowLarge !== undefined ? { allowLarge: options.allowLarge } : {}),
      ...(options.reqdoc ? { reqdoc: options.reqdoc } : {}),
      ...(options.focus !== undefined ? { focus: options.focus } : {}),
      ...(options.signal ? { signal: options.signal } : {}),
      ...(options.fingerprintTarget
        ? { fingerprintTarget: options.fingerprintTarget }
        : {}),
      ...(options.suggestRanges ? { suggestRanges: options.suggestRanges } : {}),
      interactiveRange: { picker, selection: selected },
    });
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
  const usesKnownDefaultBranchHistory = state.defaultBranchRef !== undefined && (
    (target.mode === "base" && target.baseRef === state.defaultBranchRef) ||
    (target.mode === "range" && target.fromRef === state.defaultBranchRef && target.toRef === "HEAD")
  );
  let continuousRangePicker: Promise<InteractiveRangePicker> | undefined;
  const interactiveRangePicker = options.ctx.mode === "tui" &&
      state.branch !== undefined &&
      !state.operation &&
      !state.workingTree.unmerged &&
      state.defaultBranchSha !== undefined &&
      usesKnownDefaultBranchHistory &&
      (state.ahead ?? 0) > 0
    ? () => {
        continuousRangePicker ??= createInteractiveRangePicker({
          ctx: options.ctx,
          state,
          ...(options.signal ? { signal: options.signal } : {}),
          ...(options.runner ? { runner: options.runner } : {}),
          ...(options.listRangeStarts ? { listRangeStarts: options.listRangeStarts } : {}),
          ...(state.defaultBranchSha ? { boundarySha: state.defaultBranchSha } : {}),
        });
        return continuousRangePicker;
      }
    : undefined;
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
    ...(interactiveRangePicker ? { interactiveRangePicker } : {}),
    allowAutomaticCommitPlan: false,
  });
}
