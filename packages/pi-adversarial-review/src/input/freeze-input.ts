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
  captureReviewTarget,
  extractRangeSnapshot,
  resolveGitRoot,
  resolveReviewTarget,
  type CaptureLimits,
  type ResolvedReviewTarget,
  type TargetCapture,
} from "./git-target.ts";
import { EmptyReviewInputError, OversizedReviewInputError, ReviewInputError } from "./errors.ts";
import {
  assertFrozenInputWithinLimits,
  MAX_FROZEN_INPUT_BYTES,
  MAX_FROZEN_INPUT_LINES,
  measureFrozenInput,
} from "./limits.ts";
import { createReviewTempWorkspace } from "./temp-workspace.ts";

export { EmptyReviewInputError, OversizedReviewInputError } from "./errors.ts";
export {
  assertFrozenInputWithinLimits,
  MAX_FROZEN_INPUT_BYTES,
  MAX_FROZEN_INPUT_LINES,
  measureFrozenInput,
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
    throw new OversizedReviewInputError(fileInfo.size, 0, maxBytes, maxLines);
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
    assertFrozenInputWithinLimits(content, maxBytes, maxLines);
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

Return exactly one JSON object and no commentary. The object must match this shape:

\`\`\`json
${OUTPUT_CONTRACT}
\`\`\`

An approve verdict requires an empty findings array. A needs-attention verdict requires at least one finding. Report only material issues with non-empty evidence.
`;
}

function hasReviewChanges(capture: TargetCapture): boolean {
  return capture.changedFiles.length > 0 && capture.sections.some(({ patch }) => patch.length > 0);
}

export interface ReviewTargetFingerprint {
  root: string;
  headSha: string;
  statusSha256: string;
  targetSha256: string;
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
  signal?: AbortSignal;
  maxBytes?: number;
  maxLines?: number;
}): Promise<ReviewTargetFingerprint> {
  const maxBytes = options.maxBytes ?? MAX_FROZEN_INPUT_BYTES;
  const maxLines = options.maxLines ?? MAX_FROZEN_INPUT_LINES;
  if (!Number.isInteger(maxBytes) || maxBytes <= 0 || !Number.isInteger(maxLines) || maxLines <= 0) {
    throw new ReviewInputError("Frozen input limits must be positive integers.");
  }
  const root = await resolveGitRoot(options.cwd, options.signal);
  const captureOptions = { maxBytes, maxLines, signal: options.signal };
  const firstResolved = await resolveReviewTarget(root, options.target, options.signal);
  const firstCapture = await captureReviewTarget(root, firstResolved, captureOptions);
  const secondResolved = await resolveReviewTarget(root, options.target, options.signal);
  if (resolvedTargetIdentity(firstResolved) !== resolvedTargetIdentity(secondResolved)) {
    throw new ReviewInputError(
      "Git target refs changed while fingerprinting adversarial review input. Retry the review.",
    );
  }
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
    targetRefs,
  };
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
  const capture = await captureReviewTarget(root, resolved, {
    maxBytes,
    maxLines,
    signal: options.signal,
  });
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
  assertFrozenInputWithinLimits(content, maxBytes, maxLines);

  const workspace = await createReviewTempWorkspace(runId);
  try {
    let reviewerCwd = root;
    if (resolved.mode === "range") {
      await extractRangeSnapshot(
        root,
        resolved.toSha,
        workspace.snapshotDir,
        options.signal,
      );
      await workspace.makeSnapshotReadOnly();
      reviewerCwd = workspace.snapshotDir;
    }
    assertFreezeActive(options.signal);
    await workspace.writeInput(content);

    return {
      runId,
      target,
      reviewerCwd,
      inputPath: workspace.inputPath,
      charterSource: "builtin",
      charterSha256,
      limitedContext: capture.limitedContext,
      recheck: () => detectDrift(root, options.target, target, { maxBytes, maxLines }),
      cleanup: workspace.cleanup,
    };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}
