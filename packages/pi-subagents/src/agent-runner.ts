/**
 * agent-runner.ts — Core execution engine: creates sessions, runs agents, collects results.
 */

import { readFileSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionContext, LoadExtensionsResult } from "@earendil-works/pi-coding-agent";
import {
  type AgentSession,
  type AgentSessionEvent,
  createAgentSession,
  DefaultResourceLoader,
  type ExtensionAPI,
  getAgentDir,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { BUILTIN_TOOL_NAMES, getAgentConfig, getConfig, getMemoryToolNames, getReadOnlyMemoryToolNames, getToolNamesForType } from "./agent-types.js";
import { buildParentContext, extractText } from "./context.js";
import { DEFAULT_AGENTS } from "./default-agents.js";
import { detectEnv } from "./env.js";
import { buildMemoryBlock, buildReadOnlyMemoryBlock } from "./memory.js";
import { buildAgentPrompt, type PromptExtras } from "./prompts.js";
import { preloadSkills } from "./skill-loader.js";
import type { AgentConfig, AgentResumeSnapshot, InlineAgentConfig, SubagentType, ThinkingLevel } from "./types.js";
import { toLifetimeUsage, type LifetimeUsage } from "./usage.js";

/**
 * Tool names registered by THIS extension. Single source of truth so the
 * registration sites (index.ts) and the subagent exclusion list below can't
 * drift apart. These are our own tools, not pi built-ins, so they can't be
 * derived from pi — but they only need defining once.
 */
export const SUBAGENT_TOOL_NAMES = {
  AGENT: "Agent",
  GET_RESULT: "get_subagent_result",
  STEER: "steer_subagent",
} as const;

/** Names of tools registered by this extension that subagents must NOT inherit. */
const EXCLUDED_TOOL_NAMES: string[] = Object.values(SUBAGENT_TOOL_NAMES);

/**
 * Canonical name of an extension for `extensions: [...]` allowlist matching.
 * Lowercased — extension names match case-insensitively so `extensions: [Mcp]`
 * resolves the same as `[mcp]`. Tool names within `ext:foo/bar` are not affected.
 * Directory extensions (`foo/index.ts`) resolve to the parent directory name;
 * single-file extensions to the basename minus `.ts`/`.js`.
 */
export function extensionCanonicalName(extPath: string): string {
  const base = basename(extPath);
  const name = base === "index.ts" || base === "index.js"
    ? basename(dirname(extPath))
    : base.replace(/\.(ts|js)$/, "");
  return name.toLowerCase();
}

/**
 * The unscoped, lowercased npm short name of the pi package that DECLARES
 * `extPath` as an extension entry — or undefined if the entry doesn't belong to
 * such a package.
 *
 * Climbs from the entry's directory looking for the package that owns it, and
 * stays strictly within that package's tree by stopping at two structural
 * boundaries — no hardcoded depth:
 *   - the FIRST `package.json` found (the package root); the entry's own
 *     manifest always sits at the root, above the entry, below any node_modules.
 *   - a `node_modules` directory: a package never spans one (it's where OTHER
 *     packages live), so reaching it means we've climbed out of the package —
 *     stop before reading a consumer's or parent package's manifest.
 * The name is then taken only when that root's `pi.extensions` manifest actually
 * lists this entry. That "declares this entry" check is deliberate: our own test
 * fixtures live under this repo, whose root manifest declares `./src/index.ts`
 * as `@tintinweb/pi-subagents`, so a looser rule would misattribute every
 * co-located file to `pi-subagents`.
 */
function extensionPackageName(extPath: string): string | undefined {
  const entry = resolve(extPath);
  let dir = dirname(extPath);
  for (;;) {
    // Climbing into node_modules means we've left the owning package's tree.
    if (basename(dir) === "node_modules") return undefined;
    let pkg: { name?: unknown; pi?: { extensions?: unknown } };
    try {
      pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf-8"));
    } catch {
      const parent = dirname(dir);
      if (parent === dir) return undefined; // walked to the filesystem root
      dir = parent;
      continue;
    }
    // First package.json wins — it's the package root; decide here.
    const entries = pkg.pi?.extensions;
    if (
      typeof pkg.name === "string" &&
      Array.isArray(entries) &&
      entries.some((e) => typeof e === "string" && resolve(dir, e) === entry)
    ) {
      const short = pkg.name.startsWith("@") ? pkg.name.slice(pkg.name.indexOf("/") + 1) : pkg.name;
      return short.toLowerCase();
    }
    return undefined;
  }
}

/**
 * All names an extension answers to for allowlist matching (lowercased): its
 * path-derived {@link extensionCanonicalName} plus, when a pi package manifest
 * declares this entry, that package's unscoped short name (`@scope/foo` → `foo`).
 * #143: an extension installed via `pi.extensions: ["./src/index.ts"]` would
 * otherwise only ever match as `src` (the source directory), never by its
 * package name. The path-derived name is preserved, so it keeps matching too.
 */
export function extensionCanonicalNames(extPath: string): string[] {
  const canonical = extensionCanonicalName(extPath);
  const pkg = extensionPackageName(extPath);
  return pkg && pkg !== canonical ? [canonical, pkg] : [canonical];
}

/**
 * Classify `extensions: string[]` frontmatter entries for the loader-level filter.
 *
 * An entry is a PATH iff it contains a path separator or starts with `~`; otherwise
 * it is a NAME. `"*"` sets the wildcard flag (keep all default-discovered extensions).
 *
 * Path entries are resolved (`~` expanded, made absolute against `cwd`) into `paths`
 * — and their canonical name is also added to `names`. The loader override matches
 * everything by canonical name, so path-loaded extensions are matched via their name
 * rather than their post-staging `Extension.path`.
 */
export function parseExtensionsSpec(
  entries: string[],
  cwd: string,
): { names: Set<string>; paths: string[]; wildcard: boolean } {
  const names = new Set<string>();
  const paths: string[] = [];
  let wildcard = false;
  for (const entry of entries) {
    if (!entry) continue;
    if (entry === "*") {
      wildcard = true;
      continue;
    }
    const isPathEntry = entry.includes("/") || entry.includes("\\") || entry.startsWith("~");
    if (!isPathEntry) {
      names.add(entry.toLowerCase());
      continue;
    }
    let p = entry;
    if (p === "~" || p.startsWith("~/") || p.startsWith("~\\")) {
      p = homedir() + p.slice(1);
    }
    const abs = isAbsolute(p) ? p : resolve(cwd, p);
    paths.push(abs);
    names.add(extensionCanonicalName(abs));
  }
  return { names, paths, wildcard };
}

/**
 * Parse raw `ext:` selector strings (from the `tools:` CSV) into the set of
 * extension names to keep loaded and a per-extension tool-narrowing map.
 *
 * `ext:foo` → `extNames` has `foo`, no narrowing entry (all of foo's tools).
 * `ext:foo/bar` → `extNames` has `foo`, `narrowing.foo` has `bar` (only `bar`).
 * A name lands in `narrowing` only when a `/tool` form is seen, so a bare
 * `ext:foo` alongside `ext:foo/bar` leaves narrowing in effect (narrowing wins).
 * The split is on the first `/`; extension canonical names never contain `/`.
 */
export function parseExtSelectors(entries: string[]): {
  extNames: Set<string>;
  narrowing: Map<string, Set<string>>;
} {
  const extNames = new Set<string>();
  const narrowing = new Map<string, Set<string>>();
  for (const raw of entries) {
    if (!raw) continue;
    const body = raw.slice("ext:".length);
    const slash = body.indexOf("/");
    // Extension name matches case-insensitively (matches the loader-side canonical
    // name). Tool names are case-preserved — they're matched against pi-mono's
    // registered identifiers, which are case-sensitive.
    const name = (slash === -1 ? body : body.slice(0, slash)).trim().toLowerCase();
    if (!name) continue;
    extNames.add(name);
    if (slash === -1) continue;
    const tool = body.slice(slash + 1).trim();
    if (!tool) continue;
    let set = narrowing.get(name);
    if (!set) {
      set = new Set();
      narrowing.set(name, set);
    }
    set.add(tool);
  }
  return { extNames, narrowing };
}

/**
 * Keep a subagent's tool scope correct as extensions register tools over time.
 *
 * Extensions may call `registerTool` long after load — pi-mcp from `session_start`,
 * context-mode from `before_agent_start` — so scope has to be re-derived rather than
 * snapshotted. `registerTool` writes into the very `extension.tools` maps this reads,
 * so `inScope()` sees late arrivals on the next call.
 *
 * Two enforcement points, because neither covers the whole picture:
 *
 *   - `turn_end` re-narrows the ACTIVE set. pi emits `turn_end` immediately before
 *     `prepareNextTurn` re-snapshots `agent.state.tools`, and session listeners run
 *     synchronously, so the narrow lands in time for turns 2..N.
 *   - `beforeToolCall` blocks out-of-scope calls. Turn 1 cannot be narrowed at all:
 *     `before_agent_start` fires INSIDE `prompt()` and may widen the tool set, but
 *     `createContextSnapshot()` freezes that turn's tools immediately after — there
 *     is no hook in between. A call-time check is the only correct guard there.
 *
 * Both are installed on the session and deliberately NOT unsubscribed: they must
 * outlive the `runAgent` call so resumed/steered turns stay scoped. pi's `dispose()`
 * clears `_eventListeners`, so they die with the session rather than leaking.
 *
 * Only meaningful when extensions are loaded — under `noExtensions`/`isolated`
 * with an empty pin set the static `allowedToolNames` allowlist already gates
 * the registry itself.
 */
export function installExtensionToolScope(
  session: AgentSession,
  ctx: {
    loader: DefaultResourceLoader;
    toolNames: string[];
    disallowedSet: Set<string> | undefined;
    extNames: Set<string>;
    narrowing: Map<string, Set<string>>;
    /** Canonical names of extensions loaded only because they are pinned. */
    pinnedOnly?: Set<string>;
  },
): void {
  const { loader, toolNames, disallowedSet, extNames, narrowing } = ctx;
  const pinnedOnly = ctx.pinnedOnly ?? EMPTY_PINNED;

  // The names allowed right now. Mirrors the `ext:` opt-in flip: when any `ext:`
  // selector is present, extension tools become an explicit allowlist — a loaded
  // extension not named by a selector contributes nothing (its handlers still ran),
  // and `ext:foo/bar` narrows `foo` to just `bar`.
  const inScope = (): Set<string> => {
    const keep = new Set(toolNames.filter((t) => !disallowedSet?.has(t)));
    const optInActive = extNames.size > 0;
    for (const extension of loader.getExtensions().extensions) {
      const canons = extensionCanonicalNames(extension.path);
      // Pinning is load-and-observe: tools from extensions that are only here
      // because of settings stay invisible/un-callable.
      if (canons.some((c) => pinnedOnly.has(c))) continue;
      if (optInActive && !canons.some((c) => extNames.has(c))) continue;
      // First alias that carries a narrowing set — a user won't narrow one
      // extension under two different names, so first-match is correct.
      const narrowed = canons.map((c) => narrowing.get(c)).find(Boolean);
      for (const name of extension.tools.keys()) {
        if (narrowed && !narrowed.has(name)) continue;
        if (disallowedSet?.has(name)) continue;
        keep.add(name);
      }
    }
    for (const name of EXCLUDED_TOOL_NAMES) keep.delete(name);
    return keep;
  };

  const renarrow = () => {
    const allowed = inScope();
    const next = session.getAllTools().map((t) => t.name).filter((n) => allowed.has(n));
    const current = session.getActiveToolNames();
    // setActiveToolsByName unconditionally rebuilds the system prompt, so skip
    // the no-op that steady-state turns would otherwise pay for every turn.
    if (next.length !== current.length || next.some((n, i) => n !== current[i])) {
      session.setActiveToolsByName(next);
    }
  };

  // Activate what registered during session_start (eager MCP servers); pi would
  // otherwise leave only its four default built-ins active at turn 1.
  renarrow();

  session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") renarrow();
  });

  const priorBeforeToolCall = session.agent.beforeToolCall;
  session.agent.beforeToolCall = async (context, signal) => {
    if (!inScope().has(context.toolCall.name)) {
      return {
        block: true,
        reason: `Tool "${context.toolCall.name}" is not available to this subagent.`,
      };
    }
    return priorBeforeToolCall?.(context, signal);
  };
}

const EMPTY_PINNED: ReadonlySet<string> = new Set();

/** Canonical names pinned as observers in every subagent session. */
let pinnedExtensions: Set<string> = new Set();

/** Lowercased, de-duplicated pin names. Empty = no pinning (legacy paths). */
export function getPinnedExtensions(): string[] {
  return [...pinnedExtensions];
}

/** Replace the pin set. Empty / whitespace entries are dropped; names lowercased. */
export function setPinnedExtensions(names: readonly string[]): void {
  const next = new Set<string>();
  for (const raw of names) {
    if (typeof raw !== "string") continue;
    const name = raw.trim().toLowerCase();
    if (name) next.add(name);
  }
  pinnedExtensions = next;
}

/** Default max turns. undefined = unlimited (no turn limit). */
let defaultMaxTurns: number | undefined;

/** Normalize max turns. undefined or 0 = unlimited, otherwise minimum 1. */
export function normalizeMaxTurns(n: number | undefined): number | undefined {
  if (n == null || n === 0 || !Number.isFinite(n)) return undefined;
  return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(n)));
}

/** Get the default max turns value. undefined = unlimited. */
export function getDefaultMaxTurns(): number | undefined { return defaultMaxTurns; }
/** Set the default max turns value. undefined or 0 = unlimited, otherwise minimum 1. */
export function setDefaultMaxTurns(n: number | undefined): void { defaultMaxTurns = normalizeMaxTurns(n); }

/**
 * Project default for `persist_session`. On by default so ordinary subagents
 * become normal Pi sessions that can be inspected with `/resume`.
 * Per-agent frontmatter overrides this in both directions.
 */
let rememberAgents = true;

/** Whether subagent sessions are persisted by default. */
export function getRememberAgents(): boolean { return rememberAgents; }
/** Set whether subagent sessions are persisted by default. */
export function setRememberAgents(enabled: boolean): void { rememberAgents = enabled; }

/** Additional turns allowed after the soft limit steer message. */
let graceTurns = 5;

/** Get the grace turns value. */
export function getGraceTurns(): number { return graceTurns; }
/** Set the grace turns value (minimum 1). */
export function setGraceTurns(n: number): void { graceTurns = normalizeGraceTurns(n) ?? 5; }

/** Normalize a per-run grace override. undefined keeps the global setting. */
export function normalizeGraceTurns(n: number | undefined): number | undefined {
  if (n == null || !Number.isFinite(n)) return undefined;
  return Math.max(1, Math.min(Number.MAX_SAFE_INTEGER, Math.trunc(n)));
}

/**
 * Try to find the right model for an agent type.
 * Priority: explicit option > config.model > parent model.
 */
function resolveDefaultModel(
  parentModel: Model<any> | undefined,
  registry: { find(provider: string, modelId: string): Model<any> | undefined; getAvailable?(): Model<any>[] },
  configModel?: string,
): Model<any> | undefined {
  if (configModel) {
    const slashIdx = configModel.indexOf("/");
    if (slashIdx !== -1) {
      const provider = configModel.slice(0, slashIdx);
      const modelId = configModel.slice(slashIdx + 1);

      // Build a set of available model keys for fast lookup
      const available = registry.getAvailable?.();
      const availableKeys = available
        ? new Set(available.map((m: any) => `${m.provider}/${m.id}`))
        : undefined;
      const isAvailable = (p: string, id: string) =>
        !availableKeys || availableKeys.has(`${p}/${id}`);

      const found = registry.find(provider, modelId);
      if (found && isAvailable(provider, modelId)) return found;
    }
  }

  return parentModel;
}

/** Info about a tool event in the subagent. */
export interface ToolActivity {
  type: "start" | "end";
  toolName: string;
  /** Stable id for pairing start/end (preferred over toolName). */
  toolCallId?: string;
  /** Tool-call arguments at start — retained for detailed conversation step summaries. */
  args?: unknown;
}

export interface RunOptions {
  /** ExtensionAPI instance — used for pi.exec() instead of execSync. */
  pi: ExtensionAPI;
  /** Manager-assigned id; suffixes session name to disambiguate parallel spawns (e.g. `Explore#a1b2c3d4`). */
  agentId?: string;
  model?: Model<any>;
  maxTurns?: number;
  /** Extra wrap-up turns after the soft maxTurns steer. Defaults to the global setting. */
  graceTurns?: number;
  signal?: AbortSignal;
  isolated?: boolean;
  inheritContext?: boolean;
  thinkingLevel?: ThinkingLevel;
  /**
   * Caller-supplied role definition. When present, bypasses the named-agent
   * registry entirely; when absent, the historical registry/fallback path is
   * unchanged.
   */
  inlineAgentConfig?: InlineAgentConfig;
  /** Override working directory (e.g. for worktree isolation). */
  cwd?: string;
  /**
   * Where .pi config is discovered (project extensions, skills, pi settings,
   * agent memory). Default: same as the working directory. The manager sets
   * this to the parent session's cwd when `SpawnOptions.cwd` points the
   * working directory elsewhere — the agent works *there* but carries the
   * parent project's config (the target's `.pi` extensions never execute).
   *
   * WARNING for future callers: if you pass `cwd` pointing at a directory the
   * user didn't open, you almost certainly must pass `configCwd` too —
   * omitting it makes the target's `.pi` extensions execute in this process.
   * (Worktree isolation is the one intentional exception: its copy IS the
   * parent's repo, so config resolving inside it is correct.)
   */
  configCwd?: string;
  /** Called on tool start/end with activity info. */
  onToolActivity?: (activity: ToolActivity) => void;
  /** Called on streaming text deltas from the assistant response. */
  onTextDelta?: (delta: string, fullText: string) => void;
  /** Captures the resolved construction recipe before onSessionCreated and prompt. */
  onResumeSnapshot?: (snapshot: AgentResumeSnapshot) => void;
  onSessionCreated?: (session: AgentSession) => void;
  /** Called at the end of each agentic turn with the cumulative count. */
  onTurnEnd?: (turnCount: number) => void;
  /**
   * Called once per assistant message_end with that message's usage delta.
   * Lets callers maintain a lifetime accumulator that survives compaction
   * (which replaces session.state.messages and resets stats-derived sums).
   */
  onAssistantUsage?: (usage: LifetimeUsage) => void;
  /**
   * Called when the session successfully compacts. `tokensBefore` is upstream's
   * pre-compaction context size estimate. Aborted compactions don't fire.
   */
  onCompaction?: (info: { reason: "manual" | "threshold" | "overflow"; tokensBefore: number }) => void;
}

export interface RunResult {
  responseText: string;
  session: AgentSession;
  /** True if the agent was hard-aborted (max_turns + grace exceeded). */
  aborted: boolean;
  /** True if the agent was steered to wrap up (hit soft turn limit) but finished in time. */
  steered: boolean;
  /**
   * A failure message for the run's FINAL assistant turn, when that turn failed:
   * a provider error (stopReason "error"), or a "length" stop that produced no
   * text (a silent max-token death). pi resolves an exhausted-retries failure
   * normally instead of rejecting, so without this the manager would report such
   * a run as completed — with an empty result, or worse, an earlier turn's text
   * presented as the answer (#144). Undefined for a clean stop, or a "length"
   * stop that produced text (a legitimate truncated answer).
   */
  failure?: string;
}

/**
 * Subscribe to a session and collect the last assistant message text.
 * Returns an object with a `getText()` getter and an `unsubscribe` function.
 */
function collectResponseText(session: AgentSession) {
  let text = "";
  const messages: AgentSession["messages"] = [];
  let compacted = false;
  const unsubscribe = session.subscribe((event: AgentSessionEvent) => {
    // message_start also fires for user and toolResult messages — resetting on
    // those would wipe assistant text already collected. Reset only when a new
    // ASSISTANT message begins, so getText() is the last assistant message's text.
    if (event.type === "message_start" && event.message.role === "assistant") {
      text = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      text += event.assistantMessageEvent.delta;
    }
    if (event.type === "message_end" && event.message.role === "assistant" && Array.isArray(event.message.content)) {
      messages.push(event.message);
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) compacted = true;
  });
  return { getText: () => text, messages, wasCompacted: () => compacted, unsubscribe };
}

/**
 * Get the last non-empty assistant text produced during THIS invocation.
 * `startIndex` is the message count captured before the prompt, so the walk-back
 * never crosses into a previous turn: on a resume whose new turn failed empty,
 * this returns "" instead of the prior turn's answer (#144). Defaults to 0 (a
 * fresh spawn, where the whole history belongs to this run).
 */
function getLastAssistantText(session: Pick<AgentSession, "messages">, startIndex = 0): string {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    const text = extractText(msg.content).trim();
    if (text) return text;
  }
  return "";
}

/**
 * Error message of THIS invocation's final assistant message, when that turn
 * failed. Two failure shapes, both keyed off how the final turn STOPPED:
 *   - stopReason "error": a provider failure pi resolved instead of rejecting
 *     (any text; partial output is surfaced separately).
 *   - stopReason "length" with NO text: a silent max-token death — the run hit
 *     the output-token ceiling before writing anything, which would otherwise
 *     land as a "completed" run with an empty result (the #144 symptom).
 * Everything else completes: a clean "stop"/"toolUse" final, and — crucially — a
 * "length" stop that DID produce text (a legitimate truncated-but-useful answer).
 * "aborted" is handled by the manager's abort flag / "stopped" guard, not here.
 * Bounded by `startIndex` (like the text fallback) so a resume that produced no
 * assistant message of its own never inherits a PRIOR turn's stop reason.
 */
function finalTurnError(session: Pick<AgentSession, "messages">, startIndex = 0): string | undefined {
  for (let i = session.messages.length - 1; i >= startIndex; i--) {
    const msg = session.messages[i];
    if (msg.role !== "assistant") continue;
    if (msg.stopReason === "error") {
      return (msg as { errorMessage?: string }).errorMessage?.trim() || "provider error with no output";
    }
    if (msg.stopReason === "length" && !extractText(msg.content).trim()) {
      return "run hit the output token limit before producing any text";
    }
    return undefined;
  }
  return undefined;
}

/**
 * Wire an AbortSignal to abort a session.
 * Returns a cleanup function to remove the listener.
 */
function forwardAbortSignal(session: AgentSession, signal?: AbortSignal): () => void {
  if (!signal) return () => {};
  const onAbort = () => {
    void session.abort().catch(() => {
      // The manager still owns terminal/error reporting; abort cleanup is best-effort.
    });
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener("abort", onAbort, { once: true });
  return () => signal.removeEventListener("abort", onAbort);
}

function resolveConfiguredSessionDir(sessionDir: string | undefined, cwd: string): string | undefined {
  if (!sessionDir) return undefined;
  if (sessionDir === "~" || sessionDir.startsWith("~/")) return resolve(homedir(), sessionDir.slice(2));
  if (isAbsolute(sessionDir)) return sessionDir;
  return resolve(cwd, sessionDir);
}

export async function runAgent(
  ctx: ExtensionContext,
  type: SubagentType,
  prompt: string,
  options: RunOptions,
): Promise<RunResult> {
  const inlineAgentConfig = options.inlineAgentConfig;
  const agentConfig: AgentConfig | undefined = inlineAgentConfig ?? getAgentConfig(type);
  const config = inlineAgentConfig
    ? {
        displayName: inlineAgentConfig.displayName ?? inlineAgentConfig.name,
        description: inlineAgentConfig.description,
        builtinToolNames: inlineAgentConfig.builtinToolNames ?? BUILTIN_TOOL_NAMES,
        extensions: inlineAgentConfig.extensions,
        excludeExtensions: inlineAgentConfig.excludeExtensions,
        skills: inlineAgentConfig.skills,
        promptMode: inlineAgentConfig.promptMode,
      }
    : getConfig(type);

  // Resolve working directory: worktree override > parent cwd
  const effectiveCwd = resolve(options.cwd ?? ctx.cwd);
  // Filesystem work happens in effectiveCwd; config discovery in configCwd.
  // They differ only for SpawnOptions.cwd spawns (config stays with the parent).
  const configCwd = resolve(options.configCwd ?? effectiveCwd);

  const env = await detectEnv(options.pi, effectiveCwd);

  // Get parent system prompt for append-mode agents
  const parentSystemPrompt = ctx.getSystemPrompt();

  // Build prompt extras (memory, skill preloading)
  const extras: PromptExtras = {};

  const skills = options.isolated ? false : config.skills;

  // Skill preloading: when skills is string[], preload their content into prompt
  if (Array.isArray(skills)) {
    const loaded = preloadSkills(skills, configCwd);
    if (loaded.length > 0) {
      extras.skillBlocks = loaded;
    }
  }

  let toolNames = inlineAgentConfig
    ? (inlineAgentConfig.builtinToolNames ?? [...BUILTIN_TOOL_NAMES])
    : getToolNamesForType(type);

  // Persistent memory: detect write capability and branch accordingly.
  // Account for disallowedTools — a tool in the base set but on the denylist is not truly available.
  if (agentConfig?.memory) {
    const existingNames = new Set(toolNames);
    const denied = agentConfig.disallowedTools ? new Set(agentConfig.disallowedTools) : undefined;
    const effectivelyHas = (name: string) => existingNames.has(name) && !denied?.has(name);
    const hasWriteTools = effectivelyHas("write") || effectivelyHas("edit");

    if (hasWriteTools) {
      // Read-write memory: add any missing memory tool names (read/write/edit)
      const extraNames = getMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    } else {
      // Read-only memory: only add read tool name, use read-only prompt
      const extraNames = getReadOnlyMemoryToolNames(existingNames);
      if (extraNames.length > 0) toolNames = [...toolNames, ...extraNames];
      extras.memoryBlock = buildReadOnlyMemoryBlock(agentConfig.name, agentConfig.memory, configCwd);
    }
  }

  // Build system prompt from agent config
  let systemPrompt: string;
  if (agentConfig) {
    systemPrompt = buildAgentPrompt(agentConfig, effectiveCwd, env, parentSystemPrompt, extras);
  } else {
    // Unknown type fallback: spread the canonical general-purpose config (defensive —
    // unreachable in practice since index.ts resolves unknown types before calling runAgent).
    const fallback = DEFAULT_AGENTS.get("general-purpose");
    if (!fallback) throw new Error(`No fallback config available for unknown type "${type}"`);
    systemPrompt = buildAgentPrompt({ ...fallback, name: type }, effectiveCwd, env, parentSystemPrompt, extras);
  }

  const resolvedConfig = structuredClone(agentConfig ?? { ...DEFAULT_AGENTS.get("general-purpose")!, name: type });
  resolvedConfig.builtinToolNames = [...toolNames];
  resolvedConfig.extensions = config.extensions;
  resolvedConfig.excludeExtensions = config.excludeExtensions;
  resolvedConfig.skills = config.skills;
  const maxTurns = normalizeMaxTurns(options.maxTurns ?? agentConfig?.maxTurns ?? defaultMaxTurns);
  const effectiveGraceTurns = normalizeGraceTurns(options.graceTurns) ?? graceTurns;
  const session = await constructAgentSession(ctx, resolvedConfig, systemPrompt, {
    ...options, cwd: effectiveCwd, configCwd,
  });
  sessionExecutionLimits.set(session, { maxTurns, graceTurns: effectiveGraceTurns });
  try {
    if (options.onResumeSnapshot) {
      if (!session.model) throw new Error("Cannot snapshot a subagent without an effective model");
      options.onResumeSnapshot({
        version: 1,
        config: structuredClone(resolvedConfig),
        systemPrompt: session.systemPrompt,
        cwd: effectiveCwd,
        configCwd,
        model: { provider: session.model.provider, modelId: session.model.id },
        thinkingLevel: session.thinkingLevel,
        isolated: options.isolated ?? false,
        maxTurns,
        graceTurns: effectiveGraceTurns,
      });
    }
    options.onSessionCreated?.(session);
  } catch (error) {
    session.dispose();
    throw error;
  }
  const parentContext = options.inheritContext ? buildParentContext(ctx) : "";
  return executeAgentSession(session, parentContext ? parentContext + prompt : prompt, {
    ...options, maxTurns, graceTurns: effectiveGraceTurns,
  });
}

/** Resource discovery, SDK construction and tool binding shared by new and disk sessions. */
async function constructAgentSession(
  ctx: ExtensionContext,
  agentConfig: AgentConfig,
  systemPrompt: string,
  options: RunOptions & { cwd: string; configCwd: string },
  restoredManager?: SessionManager,
): Promise<AgentSession> {
  const type = agentConfig.name;
  const effectiveCwd = options.cwd;
  const configCwd = options.configCwd;
  const toolNames = agentConfig.builtinToolNames ?? [...BUILTIN_TOOL_NAMES];
  const extensions = options.isolated ? false : agentConfig.extensions;
  const excludeExtensions = options.isolated ? undefined : agentConfig.excludeExtensions;
  const skills = options.isolated ? false : agentConfig.skills;
  // Restored prompts already contain the rendered skills catalogue. SDK always
  // appends cwd to custom prompts, so remove exactly that final suffix once.
  if (restoredManager) {
    const suffix = `\nCurrent working directory: ${effectiveCwd.replace(/\\/g, "/")}`;
    if (systemPrompt.endsWith(suffix)) systemPrompt = systemPrompt.slice(0, -suffix.length);
  }
  const noSkills = !!restoredManager || skills === false || Array.isArray(skills);

  const agentDir = getAgentDir();

  // Extension loading:
  // - true  → all default-discovered extensions
  // - false → none (noExtensions)
  // - string[] → loader-level allowlist. Bare names keep the matching
  //   default-discovered extension; path entries load that extension fresh;
  //   "*" keeps all default-discovered extensions. Excluded extensions never
  //   bind handlers or register tools (their factory still runs once).
  //
  // Suppress AGENTS.md/CLAUDE.md and APPEND_SYSTEM.md — upstream's
  // buildSystemPrompt() re-appends both AFTER systemPromptOverride, which
  // would defeat prompt_mode: replace and isolated: true. Parent context, if
  // wanted, reaches the subagent via prompt_mode: append (parentSystemPrompt
  // is embedded in systemPromptOverride) or inherit_context (conversation).
  // `ext:` selectors from the `tools:` CSV narrow which extension tools surface to
  // the LLM. They do NOT control loading — `extensions:` is the sole authority for
  // which extensions load. `ext:foo` against an extension that `extensions:` excluded
  // is an orphan and warns after reload. `isolated` means no extension tools at all.
  const { extNames, narrowing } = parseExtSelectors(
    options.isolated ? [] : (agentConfig?.extSelectors ?? []),
  );
  // Pinning is empty → identical to the historical noExtensions shortcut.
  // A non-empty pin must discover extensions so observers can bind handlers.
  const pinned = pinnedExtensions;
  const noExtensions = extensions === false && pinned.size === 0;

  const extensionsSpec = Array.isArray(extensions)
    ? parseExtensionsSpec(extensions, configCwd)
    : undefined;
  const keepNames = extensionsSpec?.names ?? new Set<string>();
  // `exclude_extensions:` is a denylist applied AFTER the include set — exclude
  // wins on the tool surface. Load still keeps a pinned name (pin wins loading).
  // Plain canonical names only (case-insensitive). Note: excluded extensions'
  // factories still run once during reload() (see comment above) — exclusion
  // suppresses handler binding and tool registration; it is not a sandbox.
  const excludeNames = new Set((excludeExtensions ?? []).map((n) => n.toLowerCase()));
  const hasExcludes = excludeNames.size > 0;
  // The override filters loaded extensions down to `keepNames` minus `excludeNames`,
  // unioned with the pin set. It's only needed when we're neither loading everything
  // without excludes (`extensions: true` or a `"*"` wildcard) nor nothing (`noExtensions`).
  const loadAll = extensions === true || extensionsSpec?.wildcard === true;
  const additionalExtensionPaths = extensionsSpec?.paths.length ? extensionsSpec.paths : undefined;
  // Pre-filter discovered set, captured by the override — the exclude-typo warning
  // must compare against this, not the surviving set (absence from survivors is
  // an exclude *succeeding*).
  let discoveredNames: Set<string> | undefined;
  const extensionsOverride: ((base: LoadExtensionsResult) => LoadExtensionsResult) | undefined =
    noExtensions || (loadAll && !hasExcludes)
      ? undefined
      : (base) => {
          discoveredNames = new Set(base.extensions.flatMap((e) => extensionCanonicalNames(e.path)));
          return {
            ...base,
            extensions: base.extensions.filter((e) => {
              const canons = extensionCanonicalNames(e.path);
              if (canons.some((n) => pinned.has(n))) return true; // pin wins loading
              if (canons.some((n) => excludeNames.has(n))) return false; // exclude wins otherwise
              return loadAll || canons.some((n) => keepNames.has(n));
            }),
          };
        };

  const loader = new DefaultResourceLoader({
    cwd: configCwd,
    agentDir,
    noExtensions,
    additionalExtensionPaths,
    extensionsOverride,
    noSkills,
    noPromptTemplates: true,
    noThemes: true,
    noContextFiles: true,
    systemPromptOverride: () => systemPrompt,
    appendSystemPromptOverride: () => [],
  });
  await loader.reload();
  if (restoredManager && loader.getExtensions().errors.length) {
    throw new Error(`Subagent restore resource loading failed: ${loader.getExtensions().errors.map((error) => error.path).join(", ")}`);
  }

  // Plain entries in `tools:` are expected to be built-in names (extension tools
  // go through `ext:`), so an unknown name there is unambiguously a typo. Previously
  // this produced a silently broken agent (#75) — pi-mono accepted the bogus name
  // into the allowlist, then dropped it at registration with no signal back.
  if (agentConfig?.builtinToolNames?.length) {
    const knownBuiltins = new Set(BUILTIN_TOOL_NAMES);
    for (const name of agentConfig.builtinToolNames) {
      if (!knownBuiltins.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `tools-error:tool "${name}" requested by agent "${type}" is not a known built-in`,
        });
      }
    }
  }

  // A subagent spawns mid-task, so a bad `extensions:`/`ext:` entry warns rather
  // than aborts. Two distinct misconfigurations to catch:
  //   - `extensions: [foo]` but no extension named foo was discovered (typo or
  //     path that failed to load — path entries fold their canonical name into
  //     `keepNames`, so this covers them too).
  //   - `tools: ext:foo` but foo isn't in the loaded set (because `extensions:`
  //     didn't include it). Since v0.9, `ext:` no longer pulls extensions in;
  //     loading is `extensions:`-authoritative.
  // An exclude_extensions: alongside extensions: false is contradictory — nothing
  // loads, so there is nothing to exclude.
  if (hasExcludes && noExtensions) {
    options.onToolActivity?.({
      type: "end",
      toolName: `extension-error:exclude_extensions has no effect for agent "${type}" — extensions: false loads nothing`,
    });
  }
  // Exclude typo check: compares against the PRE-filter discovered set (an excluded
  // name absent from the surviving set is the exclude working as intended). Also
  // flags path-like and "*" entries — excludes are plain names only.
  // A pinned name that exclude also lists is not a typo: pin keeps it loaded and
  // we warn separately that exclude only hides its tools.
  if (hasExcludes && discoveredNames) {
    for (const name of excludeNames) {
      if (pinned.has(name) && discoveredNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:extension "${name}" is pinned in settings for agent "${type}" — exclude_extensions only hides its tools`,
        });
        continue;
      }
      if (!discoveredNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:exclude_extensions: "${name}" for agent "${type}" did not match any discovered extension`,
        });
      }
    }
  }
  if (keepNames.size > 0 || extNames.size > 0) {
    const survivingNames = new Set(
      loader.getExtensions().extensions.flatMap((e) => extensionCanonicalNames(e.path)),
    );
    for (const name of keepNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: excludeNames.has(name)
            ? `extension-error:extension "${name}" is in both extensions: and exclude_extensions: for agent "${type}" — exclude wins`
            : `extension-error:extension "${name}" requested by agent "${type}" was not loaded`,
        });
      }
    }
    for (const name of extNames) {
      if (!survivingNames.has(name)) {
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:ext:${name} referenced by agent "${type}" but extension "${name}" is not loaded (check extensions:/exclude_extensions:)`,
        });
      }
    }
  }

  // Resolve model: explicit option > config.model > parent model
  const model = options.model ?? resolveDefaultModel(
    ctx.model, ctx.modelRegistry, agentConfig?.model,
  );

  // Resolve thinking level: explicit option > agent config > undefined (inherit)
  const thinkingLevel = options.thinkingLevel ?? agentConfig?.thinking;

  const disallowedSet = agentConfig?.disallowedTools
    ? new Set(agentConfig.disallowedTools)
    : undefined;

  // ─── Tool scoping ───────────────────────────────────────────────────────
  //
  // Some extensions register their tools ASYNCHRONOUSLY, long after the
  // `loader.reload()` above: pi-mcp calls registerTool from `session_start`
  // (once its MCP servers connect), context-mode from `before_agent_start`.
  // That is deliberate on their part — eagerly spawning an MCP bridge during
  // extension discovery orphans child processes on pi's non-agent code paths
  // (--help, config, trust probing).
  //
  // So the tool set cannot be snapshotted here. pi's `allowedToolNames` gates
  // tool *registration* (`_refreshToolRegistry`'s `isAllowedTool`), not merely
  // the active set, and is frozen at construction — a name absent from the
  // snapshot is dropped forever, even once the tool actually registers (#125).
  //
  // Whenever extensions are in play we therefore:
  //   - leave `allowedToolNames` unset, so pi's live gate admits tools whenever
  //     they register;
  //   - express the name-stable, permanent part of the scope (our own
  //     orchestration tools, built-ins the agent didn't ask for, and
  //     `disallowedTools`) as `excludeTools`, which pi re-applies on every
  //     registry refresh;
  //   - enforce `ext:` narrowing on the ACTIVE set via the live `inScope()`
  //     predicate installed after bind — the active set is what the LLM sees,
  //     so a registry tool that is never activated is invisible and uncallable.
  //
  // `noExtensions` (extensions: false / isolated, and no pinned observers)
  // keeps the historical static allowlist: nothing async can appear there, and
  // a hard registry gate is the correct boundary. A non-empty pin takes the
  // live-scoping path so observers can bind; their tools are hidden via pinnedOnly.
  const builtinToolNameSet = new Set(toolNames);

  let sessionTools: string[] | undefined;
  let sessionExcludeTools: string[] | undefined;
  if (noExtensions) {
    sessionTools = toolNames.filter(
      (t) => !EXCLUDED_TOOL_NAMES.includes(t) && !disallowedSet?.has(t),
    );
  } else {
    const denyTools = new Set<string>(EXCLUDED_TOOL_NAMES);
    // Keep only the built-ins the agent asked for — deny the rest.
    for (const name of BUILTIN_TOOL_NAMES) {
      if (!builtinToolNameSet.has(name)) denyTools.add(name);
    }
    if (disallowedSet) {
      for (const name of disallowedSet) denyTools.add(name);
    }
    sessionExcludeTools = [...denyTools];
  }

  const settingsManager = SettingsManager.create(configCwd, agentDir);
  const configuredSessionDir = resolveConfiguredSessionDir(agentConfig?.sessionDir, effectiveCwd);
  const defaultSessionDir = process.env.PI_CODING_AGENT_SESSION_DIR ?? settingsManager.getSessionDir?.();
  const persistSession = agentConfig?.persistSession ?? rememberAgents;
  const sessionManager = restoredManager ?? (persistSession
    ? SessionManager.create(effectiveCwd, configuredSessionDir ?? defaultSessionDir, {
        parentSession: ctx.sessionManager.getSessionFile(),
      })
    : SessionManager.inMemory(effectiveCwd));

  // Pi 0.80.8 replaced createAgentSession's modelRegistry option with
  // modelRuntime, but ExtensionContext still exposes only the registry facade.
  // Pass both so the full supported Pi range retains the parent's providers.
  const parentModelRuntime = (ctx.modelRegistry as unknown as { runtime?: unknown }).runtime;
  // Prefer modelRuntime when the parent registry exposes one (Pi >=0.80.8). Skip null
  // so the options object stays assignable under stricter ModelRuntime typings.
  const sessionOpts: Parameters<typeof createAgentSession>[0] & {
    modelRegistry: ExtensionContext["modelRegistry"];
  } = {
    cwd: effectiveCwd,
    agentDir,
    sessionManager,
    settingsManager,
    modelRegistry: ctx.modelRegistry,
    ...(parentModelRuntime != null ? { modelRuntime: parentModelRuntime as never } : {}),
    model,
    tools: sessionTools,
    resourceLoader: loader,
  };
  if (sessionExcludeTools) {
    sessionOpts.excludeTools = sessionExcludeTools;
  }
  if (thinkingLevel) {
    sessionOpts.thinkingLevel = thinkingLevel;
  }

  const { session, modelFallbackMessage } = await createAgentSession(sessionOpts);

  try {
    if (modelFallbackMessage) throw new Error(`Subagent model restoration failed: ${modelFallbackMessage}`);
    if (!restoredManager) {
      const baseSessionName = agentConfig.name;
      session.setSessionName(
        options.agentId ? `${baseSessionName}#${options.agentId.slice(0, 8)}` : baseSessionName,
      );
    }
    let bindingFailure: string | undefined;

    // session_start initializes extension state and may register more tools.
    await session.bindExtensions({
      onError: (err) => {
        bindingFailure = `Extension binding failed: ${err.extensionPath}`;
        options.onToolActivity?.({
          type: "end",
          toolName: `extension-error:${err.extensionPath}`,
        });
      },
    });
    if (bindingFailure) throw new Error(bindingFailure);

    // The registry is scoped by excludeTools; the live active set still needs
    // ext: narrowing, including tools registered during session_start and later.
    if (!noExtensions) {
      const pinnedOnly = new Set<string>();
      if (pinned.size > 0) {
        for (const extension of loader.getExtensions().extensions) {
          const canons = extensionCanonicalNames(extension.path);
          if (!canons.some((n) => pinned.has(n))) continue;
          const excluded = canons.some((n) => excludeNames.has(n));
          const keptByConfig = !excluded && (loadAll || canons.some((n) => keepNames.has(n)));
          if (!keptByConfig) {
            for (const c of canons) pinnedOnly.add(c);
          }
        }
      }
      installExtensionToolScope(session, {
        loader,
        toolNames,
        disallowedSet,
        extNames,
        narrowing,
        pinnedOnly,
      });
    }

    return session;
  } catch (error) {
    session.dispose();
    throw error;
  }
}

/** Restore only a known session file and its saved construction recipe; never create a replacement. */
export async function restoreAgentSession(
  ctx: ExtensionContext,
  sessionFile: string,
  snapshot: AgentResumeSnapshot,
  options: { pi: ExtensionAPI },
): Promise<AgentSession> {
  validateResumeSnapshot(snapshot);
  for (const cwd of [snapshot.cwd, snapshot.configCwd]) {
    if (!statSync(cwd).isDirectory()) throw new Error(`Subagent resume directory is not a directory: ${cwd}`);
  }
  snapshot = structuredClone(snapshot);
  const validated = validateSessionFile(sessionFile, snapshot.cwd);
  const sessionManager = SessionManager.open(sessionFile);
  if (sessionManager.getSessionId() !== validated.id || sessionManager.getEntries().length !== validated.entryCount) {
    throw new Error("Subagent session changed while opening; refusing a replacement session");
  }
  const context = sessionManager.buildSessionContext();
  if (!context.model?.provider || !context.model.modelId) {
    throw new Error("Subagent session has no saved model; refusing model fallback");
  }
  const { provider, modelId } = context.model;
  const model = ctx.modelRegistry.find(provider, modelId);
  if (!model || model.provider !== provider || model.id !== modelId ||
      !ctx.modelRegistry.getAvailable().some((m) => m.provider === provider && m.id === modelId)) {
    throw new Error(`Subagent session model is unavailable: ${provider}/${modelId}`);
  }
  const thinkingLevel = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change")
    ? context.thinkingLevel as ThinkingLevel : snapshot.thinkingLevel;
  if (!isThinkingLevel(thinkingLevel)) throw new Error("Invalid saved thinking level");
  const session = await constructAgentSession(ctx, snapshot.config, snapshot.systemPrompt, {
    pi: options.pi,
    cwd: snapshot.cwd,
    configCwd: snapshot.configCwd,
    isolated: snapshot.isolated,
    model,
    thinkingLevel,
  }, sessionManager);
  try {
    if (session.model?.provider !== provider || session.model?.id !== modelId || session.thinkingLevel !== thinkingLevel) {
      throw new Error("Subagent session route changed during restoration; refusing fallback");
    }
    if (session.systemPrompt !== snapshot.systemPrompt) {
      throw new Error("Subagent system prompt changed during restoration");
    }
    sessionExecutionLimits.set(session, { maxTurns: snapshot.maxTurns, graceTurns: snapshot.graceTurns });
    return session;
  } catch (error) {
    session.dispose();
    throw error;
  }
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
  return typeof value === "string" && ["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(value);
}

function validateResumeSnapshot(snapshot: AgentResumeSnapshot): void {
  const stringList = (value: unknown) => Array.isArray(value) && value.every((item) => typeof item === "string");
  const selection = (value: unknown) => typeof value === "boolean" || stringList(value);
  if (!snapshot || snapshot.version !== 1) throw new Error("Missing or unsupported subagent resume snapshot");
  const config = snapshot.config;
  if (!config || typeof config.name !== "string" || !config.name || typeof config.description !== "string" ||
      typeof config.systemPrompt !== "string" || !["append", "replace"].includes(config.promptMode) ||
      !selection(config.extensions) || !selection(config.skills) ||
      !stringList(config.builtinToolNames) ||
      (config.disallowedTools !== undefined && !stringList(config.disallowedTools)) ||
      (config.extSelectors !== undefined && !stringList(config.extSelectors)) ||
      (config.excludeExtensions !== undefined && !stringList(config.excludeExtensions)) ||
      typeof snapshot.systemPrompt !== "string" || !snapshot.systemPrompt.trim() ||
      typeof snapshot.cwd !== "string" || !isAbsolute(snapshot.cwd) ||
      typeof snapshot.configCwd !== "string" || !isAbsolute(snapshot.configCwd) ||
      typeof snapshot.model?.provider !== "string" || !snapshot.model.provider ||
      typeof snapshot.model?.modelId !== "string" || !snapshot.model.modelId ||
      !isThinkingLevel(snapshot.thinkingLevel) || typeof snapshot.isolated !== "boolean" ||
      [snapshot.maxTurns, snapshot.graceTurns].some((n) => n !== undefined && (!Number.isSafeInteger(n) || n < 1))) {
    throw new Error("Invalid subagent resume snapshot");
  }
}

function isStoredMessage(message: any): boolean {
  if (!message || typeof message !== "object") return false;
  if (message.role === "bashExecution") return typeof message.command === "string" && typeof message.output === "string";
  if (message.role === "branchSummary" || message.role === "compactionSummary") return typeof message.summary === "string";
  if (!["user", "assistant", "toolResult", "custom", "hookMessage"].includes(message.role)) return false;
  if (typeof message.content === "string") return ["user", "custom", "hookMessage"].includes(message.role);
  return Array.isArray(message.content) && message.content.every((block: any) => {
    if (!block || typeof block !== "object") return false;
    if (block.type === "text") return typeof block.text === "string";
    if (block.type === "thinking") return typeof block.thinking === "string";
    if (block.type === "toolCall") return typeof block.name === "string" && typeof block.id === "string" &&
      block.arguments !== null && typeof block.arguments === "object";
    // Image representation differs across supported SDK versions.
    return block.type === "image" && (typeof block.data === "string" || !!block.source);
  });
}

/** SDK's parser skips malformed lines and open() can create a new session. Guard both before opening. */
function validateSessionFile(sessionFile: string, cwd: string): { id: string; entryCount: number } {
  if (!sessionFile || !statSync(sessionFile).isFile()) throw new Error("Subagent session file is not a readable file");
  const text = readFileSync(sessionFile, "utf8").trim();
  if (!text) throw new Error("Subagent session file is empty");
  let entries: any[];
  try {
    entries = text.split(/\r?\n/).map((line) => JSON.parse(line));
  } catch {
    throw new Error("Subagent session file contains corrupt JSONL");
  }
  const [header] = entries;
  if (!header || header.type !== "session" || ![1, 2, 3].includes(header.version ?? 1) ||
      typeof header.id !== "string" || !header.id || typeof header.timestamp !== "string" ||
      typeof header.cwd !== "string" || !isAbsolute(header.cwd) || resolve(header.cwd) !== resolve(cwd)) {
    throw new Error("Invalid subagent session header or cwd mismatch");
  }
  const ids = new Set<string>();
  const knownTypes = new Set(["message", "model_change", "thinking_level_change", "compaction", "branch_summary",
    "custom", "custom_message", "label", "session_info"]);
  for (const entry of entries.slice(1)) {
    if (!entry || !knownTypes.has(entry.type) || typeof entry.timestamp !== "string" ||
        ((header.version ?? 1) >= 2 && (typeof entry.id !== "string" || !entry.id || ids.has(entry.id) ||
          (entry.parentId !== null && !ids.has(entry.parentId)))) ||
        (entry.type === "message" && !isStoredMessage(entry.message)) ||
        (["custom", "custom_message"].includes(entry.type) && typeof entry.customType !== "string") ||
        (entry.type === "custom_message" && !isStoredMessage({ role: "custom", content: entry.content })) ||
        (entry.type === "branch_summary" && (typeof entry.summary !== "string" || typeof entry.fromId !== "string")) ||
        (entry.type === "model_change" && (typeof entry.provider !== "string" || !entry.provider || typeof entry.modelId !== "string" || !entry.modelId)) ||
        (entry.type === "thinking_level_change" && !isThinkingLevel(entry.thinkingLevel)) ||
        (entry.type === "compaction" && (typeof entry.summary !== "string" || !Number.isFinite(entry.tokensBefore) ||
          (entry.retainedTail !== undefined
            ? !Array.isArray(entry.retainedTail) || !entry.retainedTail.every(isStoredMessage)
            : !ids.has(entry.firstKeptEntryId))))) {
      throw new Error("Corrupt subagent session entry");
    }
    ids.add(entry.id);
  }
  return { id: header.id, entryCount: entries.length - 1 };
}

export type ResumeOptions = Pick<RunOptions,
  "onToolActivity" | "onAssistantUsage" | "onCompaction" | "signal" |
  "maxTurns" | "graceTurns" | "onTextDelta" | "onTurnEnd"
>;

const sessionExecutionLimits = new WeakMap<AgentSession, Pick<ResumeOptions, "maxTurns" | "graceTurns">>();

/** One invocation boundary, regardless of whether the session is new, live or restored. */
async function executeAgentSession(session: AgentSession, prompt: string, options: ResumeOptions): Promise<RunResult> {
  let turnCount = 0;
  const maxTurns = normalizeMaxTurns(options.maxTurns);
  const effectiveGraceTurns = normalizeGraceTurns(options.graceTurns) ?? graceTurns;
  let softLimitReached = false;
  let aborted = false;

  // A turn_end notification is not a promise of another turn: queueing a steer
  // here can leave an internal message stranded after a terminal response (or
  // a terminating tool). Instead decorate the SDK's next-turn context only for
  // this invocation. This neither forces another turn nor touches user queues.
  const previousPrepare = session.agent.prepareNextTurnWithContext;
  const previousLegacyPrepare = session.agent.prepareNextTurn;
  const prepareNextTurn: NonNullable<typeof previousPrepare> = async (turn, signal) => {
    const prior = previousPrepare
      ? await previousPrepare(turn, signal)
      : await previousLegacyPrepare?.(signal);
    if (!softLimitReached) return prior;
    const context = prior?.context ?? turn.context;
    return {
      ...prior,
      context: {
        ...context,
        systemPrompt: `${context.systemPrompt ?? ""}\n\nYou have reached your turn limit. Wrap up immediately — provide your final answer now.`,
      },
    };
  };
  if (maxTurns != null) session.agent.prepareNextTurnWithContext = prepareNextTurn;

  let currentMessageText = "";
  const unsubTurns = session.subscribe((event: AgentSessionEvent) => {
    if (event.type === "turn_end") {
      turnCount++;
      options.onTurnEnd?.(turnCount);
      if (maxTurns != null) {
        if (!softLimitReached && turnCount >= maxTurns) {
          softLimitReached = true;
        } else if (softLimitReached && turnCount >= maxTurns + effectiveGraceTurns) {
          aborted = true;
          void session.abort().catch(() => {});
        }
      }
    }
    if (event.type === "message_start" && event.message.role === "assistant") {
      currentMessageText = "";
    }
    if (event.type === "message_update" && event.assistantMessageEvent.type === "text_delta") {
      currentMessageText += event.assistantMessageEvent.delta;
      options.onTextDelta?.(event.assistantMessageEvent.delta, currentMessageText);
    }
    if (event.type === "tool_execution_start") {
      options.onToolActivity?.({
        type: "start",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
        args: event.args,
      });
    }
    if (event.type === "tool_execution_end") {
      options.onToolActivity?.({
        type: "end",
        toolName: event.toolName,
        toolCallId: event.toolCallId,
      });
    }
    if (event.type === "message_end" && event.message.role === "assistant") {
      const usage = event.message.usage;
      if (usage) options.onAssistantUsage?.(toLifetimeUsage(usage));
    }
    if (event.type === "compaction_end" && !event.aborted && event.result) {
      options.onCompaction?.({ reason: event.reason, tokensBefore: event.result.tokensBefore });
    }
  });

  const collector = collectResponseText(session);
  const cleanupAbort = forwardAbortSignal(session, options.signal);

  // Events remain authoritative across compaction, which replaces the history
  // array. The identity fallback supports sessions that don't stream events.
  const priorMessages = new Set(session.messages);
  try {
    // Abort can arrive while the loader/session/extensions are still initializing,
    // before forwardAbortSignal is installed. Never start a model request after
    // that cancellation has already happened.
    if (options.signal?.aborted) {
      aborted = true;
    } else {
      await session.prompt(prompt);
    }
  } finally {
    unsubTurns();
    collector.unsubscribe();
    cleanupAbort();
    if (session.agent.prepareNextTurnWithContext === prepareNextTurn) {
      session.agent.prepareNextTurnWithContext = previousPrepare;
    }
  }

  const invocation = { messages: collector.messages.length || collector.wasCompacted()
    ? collector.messages : session.messages.filter((message) => !priorMessages.has(message)) };
  const responseText = collector.getText().trim() || getLastAssistantText(invocation);
  return { responseText, session, aborted: aborted || !!options.signal?.aborted, steered: softLimitReached, failure: finalTurnError(invocation) };
}

/**
 * Send a new prompt to an existing session (resume).
 */
export async function resumeAgent(
  session: AgentSession,
  prompt: string,
  options: ResumeOptions = {},
): Promise<{ text: string; failure?: string; aborted?: boolean; steered?: boolean }> {
  const limits = sessionExecutionLimits.get(session);
  const result = await executeAgentSession(session, prompt, {
    ...options,
    maxTurns: options.maxTurns ?? limits?.maxTurns,
    graceTurns: options.graceTurns ?? limits?.graceTurns,
  });
  return { text: result.responseText, failure: result.failure, aborted: result.aborted, steered: result.steered };
}

/**
 * Send a steering message to a running subagent.
 * The message will interrupt the agent after its current tool execution.
 */
export async function steerAgent(
  session: AgentSession,
  message: string,
): Promise<void> {
  await session.steer(message);
}

/**
 * Get the subagent's conversation messages as formatted text.
 */
export function getAgentConversation(session: AgentSession): string {
  const parts: string[] = [];

  for (const msg of session.messages) {
    if (msg.role === "user") {
      const text = typeof msg.content === "string"
        ? msg.content
        : extractText(msg.content);
      if (text.trim()) parts.push(`[User]: ${text.trim()}`);
    } else if (msg.role === "assistant") {
      const textParts: string[] = [];
      const toolCalls: string[] = [];
      for (const c of msg.content) {
        if (c.type === "text" && c.text) textParts.push(c.text);
        else if (c.type === "toolCall") {
          const name = c.name ?? (c as any).toolName ?? "unknown";
          toolCalls.push(`  Tool: ${name}${c.arguments === undefined ? "" : `\n  Arguments: ${JSON.stringify(c.arguments)}`}`);
        }
      }
      if (textParts.length > 0) parts.push(`[Assistant]: ${textParts.join("\n")}`);
      if (toolCalls.length > 0) parts.push(`[Tool Calls]:\n${toolCalls.join("\n")}`);
    } else if (msg.role === "toolResult") {
      const text = extractText(msg.content);
      parts.push(`[Tool Result (${msg.toolName})]: ${text}`);
    }
  }

  return parts.join("\n\n");
}
