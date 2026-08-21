import type { SpawnReviewAgentInput } from "./types.ts";

const INLINE_AGENT = {
  reviewer: {
    name: "adversarial-reviewer",
    displayName: "Adversarial Reviewer",
    description: "Isolated adversarial code reviewer",
  },
  refuter: {
    name: "adversarial-refuter",
    displayName: "Adversarial Refuter",
    description: "Independent adversarial finding refuter",
  },
  "format-repair": {
    name: "adversarial-review-format-repair",
    displayName: "Review Format Repair",
    description: "Tool-free reviewer output formatter",
  },
} as const;

export function buildReviewInlineAgentConfig(input: SpawnReviewAgentInput) {
  const identity = INLINE_AGENT[input.role];
  return {
    type: identity.name,
    inlineAgentConfig: {
      name: identity.name,
      displayName: identity.displayName,
      description: identity.description,
      builtinToolNames: input.role === "format-repair"
        ? []
        : ["read", "grep", "find", "ls"],
      extensions: false as const,
      skills: false as const,
      systemPrompt: input.systemPrompt,
      promptMode: "replace" as const,
      persistSession: false,
    },
  };
}
