/**
 * Cross-extension RPC handlers for the subagents extension.
 *
 * This is an in-process API over pi.events, not a network protocol. It exposes
 * ping, spawn, and stop with per-request reply channels. Protocol v3 extends
 * the existing spawn request with optional caller-supplied role and result
 * ownership fields; ordinary requests that omit them retain the old behavior.
 */

import type { Model } from "@earendil-works/pi-ai";
import type { SpawnOptions } from "./agent-manager.js";
import { type ModelRegistry, resolveModel } from "./model-resolver.js";
import type { InlineAgentConfig } from "./types.js";

/** Minimal event bus interface needed by the RPC handlers. */
export interface EventBus {
  on(event: string, handler: (data: unknown) => void): () => void;
  emit(event: string, data: unknown): void;
}

/** RPC reply envelope — matches pi-mono's RpcResponse shape. */
export type RpcReply<T = void> =
  | { success: true; data?: T }
  | { success: false; error: string };

/** RPC protocol version — bumped when the envelope or method contracts change. */
export const PROTOCOL_VERSION = 3;

/**
 * Spawn options accepted from another in-process extension. Callback and
 * AbortSignal fields remain runtime-internal; cancellation uses the stop RPC.
 */
export type RpcSpawnOptions = Omit<
  SpawnOptions,
  | "description"
  | "model"
  | "signal"
  | "onToolActivity"
  | "onTextDelta"
  | "onSessionCreated"
  | "onTurnEnd"
  | "onAssistantUsage"
  | "onCompaction"
  | "completionDelivery"
> & {
  description?: string;
  model?: string | Model<any>;
};

export interface SpawnRpcRequest {
  requestId: string;
  type: string;
  prompt: string;
  options?: RpcSpawnOptions;
}

/** Minimal AgentManager interface needed by the spawn/stop RPCs. */
export interface SpawnCapable {
  spawn(pi: unknown, ctx: unknown, type: string, prompt: string, options: SpawnOptions): string;
  abort(id: string): boolean;
  abortAndWait?(id: string): Promise<boolean>;
  getMaxConcurrent(): number;
}

export interface RpcSpawnedEvent {
  id: string;
  ctx: unknown;
  options: SpawnOptions;
}

export interface RpcDeps {
  events: EventBus;
  pi: unknown;                    // passed through to manager.spawn
  getCtx: () => unknown | undefined;  // returns current ExtensionContext
  manager: SpawnCapable;
  /** Optional UI hook. Errors here must not turn a successful spawn into an RPC failure. */
  onSpawned?: (event: RpcSpawnedEvent) => void;
}

export interface RpcHandle {
  unsubPing: () => void;
  unsubSpawn: () => void;
  unsubStop: () => void;
}

/**
 * Wire a single RPC handler: listen on `channel`, run `fn(params)`,
 * emit the reply envelope on `channel:reply:${requestId}`.
 */
function handleRpc<P extends { requestId: string }>(
  events: EventBus,
  channel: string,
  fn: (params: P) => unknown | Promise<unknown>,
): () => void {
  return events.on(channel, async (raw: unknown) => {
    const params = raw as P;
    try {
      const data = await fn(params);
      const reply: { success: true; data?: unknown } = { success: true };
      if (data !== undefined) reply.data = data;
      events.emit(`${channel}:reply:${params.requestId}`, reply);
    } catch (err: any) {
      events.emit(`${channel}:reply:${params.requestId}`, {
        success: false, error: err?.message ?? String(err),
      });
    }
  });
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isInheritanceField(value: unknown): value is true | string[] | false {
  return value === true || value === false || isStringArray(value);
}

const THINKING_LEVELS = new Set(["off", "minimal", "low", "medium", "high", "xhigh", "max"]);

function assertInlineAgentConfig(value: unknown, type: string): asserts value is InlineAgentConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("inlineAgentConfig must be an object");
  }

  const config = value as Record<string, unknown>;
  for (const field of ["name", "description", "systemPrompt"] as const) {
    if (typeof config[field] !== "string" || !config[field].trim()) {
      throw new Error(`inlineAgentConfig.${field} must be a non-empty string`);
    }
  }
  if (config.name !== type) {
    throw new Error(`inlineAgentConfig.name must match spawn type "${type}"`);
  }
  if (config.promptMode !== "replace" && config.promptMode !== "append") {
    throw new Error('inlineAgentConfig.promptMode must be "replace" or "append"');
  }
  if (!isInheritanceField(config.extensions)) {
    throw new Error("inlineAgentConfig.extensions must be a boolean or string array");
  }
  if (!isInheritanceField(config.skills)) {
    throw new Error("inlineAgentConfig.skills must be a boolean or string array");
  }
  for (const field of ["builtinToolNames", "extSelectors", "disallowedTools", "excludeExtensions"] as const) {
    if (config[field] !== undefined && !isStringArray(config[field])) {
      throw new Error(`inlineAgentConfig.${field} must be a string array`);
    }
  }
  if (config.displayName !== undefined && (typeof config.displayName !== "string" || !config.displayName.trim())) {
    throw new Error("inlineAgentConfig.displayName must be a non-empty string");
  }
  if (config.maxTurns !== undefined && (!Number.isInteger(config.maxTurns) || (config.maxTurns as number) < 0)) {
    throw new Error("inlineAgentConfig.maxTurns must be a non-negative integer");
  }
  if (config.persistSession !== undefined && typeof config.persistSession !== "boolean") {
    throw new Error("inlineAgentConfig.persistSession must be a boolean");
  }
  if (config.sessionDir !== undefined && typeof config.sessionDir !== "string") {
    throw new Error("inlineAgentConfig.sessionDir must be a string");
  }
  if (config.memory !== undefined && config.memory !== "user" && config.memory !== "project" && config.memory !== "local") {
    throw new Error('inlineAgentConfig.memory must be "user", "project", or "local"');
  }
  for (const field of [
    "model",
    "thinking",
    "inheritContext",
    "runInBackground",
    "isolated",
    "isolation",
    "outputTranscript",
  ] as const) {
    if (field in config) {
      throw new Error(`inlineAgentConfig cannot set ${field}; use spawn options instead`);
    }
  }
}

function normalizeSpawnOptions(type: string, raw: unknown): RpcSpawnOptions {
  if (raw === undefined) return {} as RpcSpawnOptions;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error("spawn options must be an object");
  }

  const serialized = { ...(raw as Record<string, unknown>) };
  // Completion delivery is an internal spawn policy. Detached RPC work keeps
  // AgentManager's followUp default even if an untyped caller sends the field.
  delete serialized.completionDelivery;
  const options = serialized as RpcSpawnOptions;
  if (options.description !== undefined && typeof options.description !== "string") {
    throw new Error("description must be a string");
  }
  if (options.model !== undefined) {
    if (typeof options.model === "string") {
      if (!options.model.trim()) throw new Error("model must be a non-empty string or Model object");
    } else if (
      !options.model ||
      typeof options.model !== "object" ||
      typeof options.model.provider !== "string" ||
      !options.model.provider ||
      typeof options.model.id !== "string" ||
      !options.model.id
    ) {
      throw new Error("model must be a non-empty string or Model object with provider/id");
    }
  }
  if (options.thinkingLevel !== undefined && !THINKING_LEVELS.has(options.thinkingLevel)) {
    throw new Error("thinkingLevel is invalid");
  }
  if (options.maxTurns !== undefined && (!Number.isInteger(options.maxTurns) || options.maxTurns < 0)) {
    throw new Error("maxTurns must be a non-negative integer");
  }
  for (const field of ["isolated", "inheritContext", "isBackground", "bypassQueue"] as const) {
    if (options[field] !== undefined && typeof options[field] !== "boolean") {
      throw new Error(`${field} must be a boolean`);
    }
  }
  if (options.cwd !== undefined && typeof options.cwd !== "string") {
    throw new Error("cwd must be a string");
  }
  if (options.inlineAgentConfig !== undefined) {
    assertInlineAgentConfig(options.inlineAgentConfig, type);
    options.description ??= options.inlineAgentConfig.description;
  }
  if (options.completionOwner !== undefined && options.completionOwner !== "runtime" && options.completionOwner !== "caller") {
    throw new Error('completionOwner must be "runtime" or "caller"');
  }
  if (options.correlationId !== undefined) {
    if (typeof options.correlationId !== "string" || !options.correlationId.trim()) {
      throw new Error("correlationId must be a non-empty string");
    }
    options.correlationId = options.correlationId.trim();
  }
  if (options.completionOwner === "caller") {
    if (options.isBackground !== true) {
      throw new Error('completionOwner="caller" requires isBackground=true');
    }
    if (!options.correlationId) {
      throw new Error('completionOwner="caller" requires correlationId');
    }
  }
  return options;
}

/** Register ping, spawn, and stop handlers. */
export function registerRpcHandlers(deps: RpcDeps): RpcHandle {
  const { events, pi, getCtx, manager } = deps;

  const unsubPing = handleRpc(events, "subagents:rpc:ping", () => {
    return { version: PROTOCOL_VERSION, maxConcurrent: manager.getMaxConcurrent() };
  });

  const unsubSpawn = handleRpc<SpawnRpcRequest>(
    events, "subagents:rpc:spawn", ({ type, prompt, options }) => {
      if (typeof type !== "string" || !type.trim()) throw new Error("spawn type must be a non-empty string");
      if (typeof prompt !== "string" || !prompt.trim()) throw new Error("spawn prompt must be a non-empty string");
      const ctx = getCtx();
      if (!ctx) throw new Error("No active session");

      const normalizedOptions = normalizeSpawnOptions(type, options);
      let managerOptions: SpawnOptions;
      if (typeof normalizedOptions.model === "string") {
        const registry = (ctx as { modelRegistry?: ModelRegistry }).modelRegistry;
        if (!registry) {
          throw new Error(
            `Model override "${normalizedOptions.model}" provided but ctx.modelRegistry is unavailable`,
          );
        }
        const resolved = resolveModel(normalizedOptions.model, registry);
        if (typeof resolved === "string") {
          throw new Error(resolved);
        }
        managerOptions = { ...normalizedOptions, model: resolved } as SpawnOptions;
      } else {
        managerOptions = normalizedOptions as SpawnOptions;
      }

      const id = manager.spawn(pi, ctx, type, prompt, managerOptions);
      try {
        deps.onSpawned?.({ id, ctx, options: managerOptions });
      } catch {
        // UI integration is best-effort; the agent is already running.
      }
      return { id };
    },
  );

  const unsubStop = handleRpc<{ requestId: string; agentId: string }>(
    events, "subagents:rpc:stop", async ({ agentId }) => {
      const stopped = manager.abortAndWait
        ? await manager.abortAndWait(agentId)
        : manager.abort(agentId);
      if (!stopped) throw new Error("Agent not found");
    },
  );

  return { unsubPing, unsubSpawn, unsubStop };
}
