export class ReviewInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewInputError";
  }
}

export class EmptyReviewInputError extends ReviewInputError {
  constructor() {
    super("The selected review target has no changes.");
    this.name = "EmptyReviewInputError";
  }
}

export class ReviewInputCleanupError extends ReviewInputError {
  readonly freezeError: unknown;
  readonly cleanupError: unknown;

  constructor(freezeError: unknown, cleanupError: unknown) {
    super(
      "Adversarial review input freeze failed and temporary review workspace cleanup also failed. " +
        "Temporary data and a detached review worktree may remain until marker-proven same-UID recovery removes them.",
    );
    this.name = "ReviewInputCleanupError";
    this.freezeError = freezeError;
    this.cleanupError = cleanupError;
  }
}

export interface ExceededInputLimit {
  limit: number;
  actual?: number;
}

export interface OversizedReviewInputDetails {
  bytes?: ExceededInputLimit;
  lines?: ExceededInputLimit;
  subject?: string;
  canSuggestRanges?: boolean;
}

export interface ReviewRangePlanCommit {
  sha: string;
  subject: string;
  /** One-based position in the requested first-parent commit path. */
  ordinal: number;
}

export interface ReviewRangePlanItem {
  kind: "bounded" | "large-single" | "too-large-single";
  fromSha: string;
  toSha: string;
  commitCount: number;
  firstCommit: ReviewRangePlanCommit;
  lastCommit: ReviewRangePlanCommit;
  /** Exact complete frozen-bundle size when it was measurable within the applicable limit. */
  inputSize?: { bytes: number; lines: number };
  /** Exact changed-file count from the same deterministic range capture. */
  changedFileCount?: number;
}

export interface ReviewRangePlan {
  targetCommitCount: number;
  analyzedCommitCount: number;
  /** Commits in the first-parent path that produce no patch in the planned ranges. */
  emptyCommitCount: number;
  /** Base-mode plans exclude staged/unstaged/untracked work from committed segments. */
  requiresSeparateLocalReview: boolean;
  items: ReviewRangePlanItem[];
}

function formatExceededLimit(
  kind: "byte" | "line",
  exceeded: ExceededInputLimit,
): string {
  const unit = kind === "byte" ? "bytes" : "lines";
  return exceeded.actual === undefined
    ? `${exceeded.limit}-${kind} limit`
    : `${exceeded.limit}-${kind} limit (${exceeded.actual} ${unit})`;
}

function formatOversizedReviewInputError(options: {
  details: OversizedReviewInputDetails;
  suggestions: readonly string[];
  suggestionNote?: string;
}): string {
  const { details } = options;
  const subject = details.subject ?? "Frozen review input";
  const exceeded = [
    ...(details.bytes ? [formatExceededLimit("byte", details.bytes)] : []),
    ...(details.lines ? [formatExceededLimit("line", details.lines)] : []),
  ];
  const limitText = exceeded.length === 1
    ? `the ${exceeded[0]}`
    : `its limits: ${exceeded.join("; ")}`;
  const fallback = subject === "Frozen requirement document"
    ? "Reduce or split the requirement document."
    : "Split the review target.";
  const suggestions = options.suggestions.length > 0
    ? `\nSuggested smaller review ranges (replace only the original target and keep all other options):\n${
      options.suggestions.map((suggestion) => `  ${suggestion}`).join("\n")
    }`
    : "";
  const note = options.suggestionNote ? `\n${options.suggestionNote}` : "";
  return `${subject} exceeds ${limitText}.${suggestions}${note}${suggestions || note ? "" : ` ${fallback}`}`;
}

export class OversizedReviewInputError extends ReviewInputError {
  readonly bytes?: ExceededInputLimit;
  readonly lines?: ExceededInputLimit;
  readonly subject: string;
  readonly canSuggestRanges: boolean;
  readonly rangeSuggestions: string[] = [];
  rangeSuggestionNote: string | undefined;
  rangePlan: ReviewRangePlan | undefined;

  constructor(details: OversizedReviewInputDetails) {
    if (!details.bytes && !details.lines) {
      throw new Error("Oversized review input must identify an exceeded limit.");
    }
    super(formatOversizedReviewInputError({ details, suggestions: [] }));
    this.name = "OversizedReviewInputError";
    this.bytes = details.bytes;
    this.lines = details.lines;
    this.subject = details.subject ?? "Frozen review input";
    this.canSuggestRanges = details.canSuggestRanges ?? true;
  }

  addRangeSuggestions(
    suggestions: readonly string[],
    note?: string,
    plan?: ReviewRangePlan,
  ): this {
    this.rangeSuggestions.splice(0, this.rangeSuggestions.length, ...new Set(suggestions));
    this.rangeSuggestionNote = note;
    this.rangePlan = plan
      ? {
          ...plan,
          items: plan.items.map((item) => ({
            ...item,
            firstCommit: { ...item.firstCommit },
            lastCommit: { ...item.lastCommit },
            ...(item.inputSize ? { inputSize: { ...item.inputSize } } : {}),
          })),
        }
      : undefined;
    this.message = formatOversizedReviewInputError({
      details: {
        ...(this.bytes ? { bytes: this.bytes } : {}),
        ...(this.lines ? { lines: this.lines } : {}),
        subject: this.subject,
        canSuggestRanges: this.canSuggestRanges,
      },
      suggestions: this.rangeSuggestions,
      ...(note ? { suggestionNote: note } : {}),
    });
    return this;
  }
}
