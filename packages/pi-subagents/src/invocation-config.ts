import { Type } from "@sinclair/typebox";
import type { AgentConfig, IsolationMode, JoinMode, ThinkingLevel } from "./types.js";

/**
 * Model-facing isolation field. `off` is first and inert, giving models that
 * fill optional parameters a safe value instead of forcing a worktree.
 */
const isolationParamShape = {
  isolation: Type.Optional(
    Type.Union([Type.Literal("off"), Type.Literal("worktree")], {
      description:
        'Isolation mode. Default "off". "off" runs the agent in the current checkout, the same as omitting the field. "worktree" creates a temporary git worktree so the agent works on an isolated copy of the repo (a copy cannot see uncommitted or staged changes in the main checkout).',
    }),
  ),
};

/** Build the isolation schema field, or remove it entirely for this repository. */
export function isolationParam(enabled: boolean): Partial<typeof isolationParamShape> {
  return enabled ? isolationParamShape : {};
}

interface AgentInvocationParams {
  model?: string;
  thinking?: string;
  max_turns?: number;
  run_in_background?: boolean;
  inherit_context?: boolean;
  isolated?: boolean;
  /** Tool schemas and RPC callers narrow this at runtime. */
  isolation?: unknown;
}

interface ResolveOptions {
  /** False silently downgrades every worktree request to the real checkout. */
  worktreeAllowed?: boolean;
}

export function resolveAgentInvocationConfig(
  agentConfig: AgentConfig | undefined,
  params: AgentInvocationParams,
  options?: ResolveOptions,
): {
  modelInput?: string;
  modelFromParams: boolean;
  thinking?: ThinkingLevel;
  maxTurns?: number;
  inheritContext: boolean;
  runInBackground: boolean;
  isolated: boolean;
  isolation?: IsolationMode;
} {
  // Preserve precedence until after resolution: frontmatter `off` must veto a
  // caller's `worktree`, while omitted frontmatter lets the caller choose.
  const requestedIsolation = agentConfig?.isolation ?? params.isolation;
  const isolation = requestedIsolation === "worktree" && options?.worktreeAllowed !== false
    ? "worktree"
    : undefined;

  return {
    modelInput: agentConfig?.model ?? params.model,
    modelFromParams: agentConfig?.model == null && params.model != null,
    thinking: (agentConfig?.thinking ?? params.thinking) as ThinkingLevel | undefined,
    maxTurns: agentConfig?.maxTurns ?? params.max_turns,
    inheritContext: agentConfig?.inheritContext ?? params.inherit_context ?? false,
    runInBackground: agentConfig?.runInBackground ?? params.run_in_background ?? false,
    isolated: agentConfig?.isolated ?? params.isolated ?? false,
    isolation,
  };
}

export function resolveJoinMode(defaultJoinMode: JoinMode, runInBackground: boolean): JoinMode | undefined {
  return runInBackground ? defaultJoinMode : undefined;
}
