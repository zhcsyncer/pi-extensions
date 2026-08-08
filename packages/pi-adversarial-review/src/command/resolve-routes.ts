import { getSupportedThinkingLevels, type ModelThinkingLevel } from "@earendil-works/pi-ai";
import type { ReviewerRoute, ScopedModelEntry } from "../types.ts";
import { ReviewCommandError } from "./parse-args.ts";

export const MIN_REVIEWERS = 2;
export const MAX_REVIEWERS = 8;

interface ParsedReviewerSpec {
  modelRef: string;
  thinking: string;
}

function parseReviewerSpec(spec: string): ParsedReviewerSpec {
  const separator = spec.lastIndexOf("@");
  if (separator <= 0 || separator === spec.length - 1) {
    throw new ReviewCommandError(
      `Invalid reviewer route "${spec}". Use <provider/model>@<thinking>.`,
    );
  }
  const modelRef = spec.slice(0, separator);
  const thinking = spec.slice(separator + 1);
  if (!modelRef.includes("/") || modelRef.startsWith("/") || modelRef.endsWith("/")) {
    throw new ReviewCommandError(
      `Invalid reviewer model "${modelRef}". Use the exact provider/model identifier.`,
    );
  }
  return { modelRef, thinking };
}

interface ResolveRouteOptions {
  role: "reviewer" | "refuter";
  min: number;
  max: number;
}

function resolveScopedRoutes(
  specs: readonly string[],
  scopedModels: readonly ScopedModelEntry[],
  options: ResolveRouteOptions,
): ReviewerRoute[] {
  if (scopedModels.length === 0) {
    throw new ReviewCommandError(
      "No scoped models are configured. Use /scoped-models before adversarial review.",
    );
  }
  if (specs.length < options.min || specs.length > options.max) {
    if (options.role === "reviewer") {
      if (specs.length < MIN_REVIEWERS) {
        throw new ReviewCommandError(
          `Adversarial review requires at least ${MIN_REVIEWERS} distinct reviewer models.`,
        );
      }
      throw new ReviewCommandError(
        `Adversarial review supports at most ${MAX_REVIEWERS} reviewer models.`,
      );
    }
    throw new ReviewCommandError("Adversarial refute requires exactly one refuter model.");
  }

  const scopeByKey = new Map<string, ScopedModelEntry>(
    scopedModels.map((entry) => [`${entry.model.provider}/${entry.model.id}`, entry]),
  );
  const seenModels = new Set<string>();
  const roleLabel = options.role === "reviewer" ? "Reviewer" : "Refuter";

  return specs.map((spec, ordinal) => {
    const { modelRef, thinking } = parseReviewerSpec(spec);
    if (seenModels.has(modelRef)) {
      throw new ReviewCommandError(`${roleLabel} model "${modelRef}" is duplicated.`);
    }
    seenModels.add(modelRef);

    const scoped = scopeByKey.get(modelRef);
    if (!scoped) {
      throw new ReviewCommandError(`${roleLabel} model "${modelRef}" is not in the current scoped models.`);
    }

    if (scoped.thinkingLevel !== undefined && thinking !== scoped.thinkingLevel) {
      throw new ReviewCommandError(
        `${roleLabel} model "${modelRef}" is pinned to thinking ` +
          `"${scoped.thinkingLevel}" by the current scope.`,
      );
    }

    const supported = getSupportedThinkingLevels(scoped.model);
    if (!supported.includes(thinking as ModelThinkingLevel)) {
      throw new ReviewCommandError(
        `Thinking "${thinking}" is not supported by ${options.role} model "${modelRef}". ` +
          `Supported: ${supported.join(", ")}.`,
      );
    }

    const effectiveThinking = thinking as ModelThinkingLevel;
    return {
      key: `${modelRef}@${effectiveThinking}`,
      model: scoped.model,
      provider: scoped.model.provider,
      modelId: scoped.model.id,
      thinking: effectiveThinking,
      thinkingSource: scoped.thinkingLevel === undefined ? "user" : "scope-pinned",
      ordinal,
    };
  });
}

export function resolveReviewerRoutes(
  specs: readonly string[],
  scopedModels: readonly ScopedModelEntry[],
): ReviewerRoute[] {
  return resolveScopedRoutes(specs, scopedModels, {
    role: "reviewer",
    min: MIN_REVIEWERS,
    max: MAX_REVIEWERS,
  });
}

export function resolveRefuterRoute(
  spec: string,
  scopedModels: readonly ScopedModelEntry[],
): ReviewerRoute {
  return resolveScopedRoutes([spec], scopedModels, {
    role: "refuter",
    min: 1,
    max: 1,
  })[0];
}
