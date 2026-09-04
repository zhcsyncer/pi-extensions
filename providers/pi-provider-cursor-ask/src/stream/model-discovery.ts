/**
 * Live model discovery over in-process Node HTTP/2 unary RPCs.
 *
 * Cursor exposes the account's usable models through `GetUsableModels` plus a
 * parameterized-metadata variant. Responses may be raw protobuf or a Connect
 * frame that `decodeConnectUnaryBody` unwraps.
 *
 * Results are memoized per access token: a token hash keys the cache so a
 * re-login or account switch invalidates it without a manual reset.
 */
import { create, fromBinary, toBinary } from "@bufbuild/protobuf";
import { createHash } from "node:crypto";

import { GetUsableModelsRequestSchema, GetUsableModelsResponseSchema } from "../proto/agent_pb.js";
import {
  decodeAvailableModelsResponse,
  encodeAvailableModelsRequest,
  type CursorModelParameter,
  type CursorParameterizedModel,
} from "../client/cursor-wire.js";
import { callUnaryOverH2, UnaryH2TimeoutError } from "../client/h2-unary.js";
import { getCursorAgentUrl } from "./config.js";
import { writeCachedCatalog } from "./model-cache.js";
import { inferCursorContextWindow, inferCursorMaxOutputTokens } from "../models/limits.js";
import { lifecycleLog, reportCursorAnomaly } from "./debug-log.js";

// Re-exported so existing importers of the model-discovery surface keep working.
export {
  DEFAULT_CONTEXT_WINDOW,
  DEFAULT_MAX_OUTPUT_TOKENS,
  inferCursorContextWindow,
  inferCursorMaxOutputTokens,
} from "../models/limits.js";

export async function callCursorUnaryRpc(options: {
  accessToken: string;
  rpcPath: string;
  requestBody: Uint8Array;
  url?: string;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<{ body: Uint8Array; exitCode: number; timedOut: boolean }> {
  try {
    const result = await callUnaryOverH2({
      accessToken: options.accessToken,
      rpcPath: options.rpcPath,
      requestBody: options.requestBody,
      url: options.url,
      timeoutMs: options.timeoutMs ?? 5_000,
      signal: options.signal,
    });
    const ok = result.status >= 200 && result.status < 300;
    return { body: result.body, exitCode: ok ? 0 : 1, timedOut: false };
  } catch (error) {
    const timedOut = options.signal?.aborted === true || error instanceof UnaryH2TimeoutError;
    return { body: new Uint8Array(0), exitCode: 1, timedOut };
  }
}

export interface CursorModel {
  id: string;
  name: string;
  reasoning: boolean;
  contextWindow: number;
  maxTokens: number;
  requestedModelId?: string;
  parameters?: CursorModelParameter[];
  requiresMaxMode?: boolean;
  requestedMaxMode?: boolean;
  supportsImages?: boolean;
}

let cachedModels: { tokenHash: string; models: CursorModel[]; expiresAt: number } | null = null;

let cachedParameterizedModels: {
  tokenHash: string;
  models: CursorParameterizedModel[];
  expiresAt: number;
} | null = null;

/** Model list cache TTL: 5 minutes. Re-fetches on token change or TTL expiry. */
const MODEL_CACHE_TTL_MS = 5 * 60 * 1000;

function tokenCacheHash(apiKey: string): string {
  return createHash("sha256").update(apiKey).digest("hex").slice(0, 16);
}

export async function getCursorModels(
  apiKey: string,
  options?: { signal?: AbortSignal },
): Promise<CursorModel[]> {
  const tokenHash = tokenCacheHash(apiKey);
  if (cachedModels?.tokenHash === tokenHash && Date.now() < cachedModels.expiresAt)
    return cachedModels.models;
  try {
    const requestPayload = create(GetUsableModelsRequestSchema, {});
    const requestBody = toBinary(GetUsableModelsRequestSchema, requestPayload);
    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: "/agent.v1.AgentService/GetUsableModels",
      requestBody,
      url: getCursorAgentUrl(),
      signal: options?.signal,
    });
    if (!response.timedOut && response.exitCode === 0 && response.body.length > 0) {
      let decoded: any = null;
      try {
        decoded = fromBinary(GetUsableModelsResponseSchema, response.body);
      } catch {
        // Try Connect framing after plain protobuf decode fails.
        const body = decodeConnectUnaryBody(response.body);
        if (body) {
          try {
            decoded = fromBinary(GetUsableModelsResponseSchema, body);
          } catch {
            decoded = null;
          }
        }
      }
      if (decoded?.models?.length) {
        const models = normalizeCursorModels(decoded.models);
        if (models.length > 0) {
          cachedModels = { tokenHash, models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
          return models;
        }
      }
    }
  } catch (err) {
    if (options?.signal?.aborted) return [];
    reportCursorAnomaly(
      "model_discovery_failed",
      "Cursor model discovery failed",
      { message: err instanceof Error ? err.message : String(err) },
      { level: "error", stderrIfNoSink: true },
    );
    return [];
  }
  if (options?.signal?.aborted) return [];
  reportCursorAnomaly(
    "model_discovery_failed",
    "Cursor model discovery failed",
    { reason: "no_models" },
    { level: "warning", stderrIfNoSink: true },
  );
  return [];
}

function decodeConnectUnaryBody(payload: Uint8Array): Uint8Array | null {
  if (payload.length < 5) return null;
  let offset = 0;
  while (offset + 5 <= payload.length) {
    const flags = payload[offset]!;
    const view = new DataView(
      payload.buffer,
      payload.byteOffset + offset,
      payload.byteLength - offset,
    );
    const messageLength = view.getUint32(1, false);
    const frameEnd = offset + 5 + messageLength;
    if (frameEnd > payload.length) return null;
    if ((flags & 0b0000_0001) !== 0) return null;
    if ((flags & 0b0000_0010) === 0) return payload.subarray(offset + 5, frameEnd);
    offset = frameEnd;
  }
  return null;
}

export async function getCursorParameterizedModels(
  apiKey: string,
  options?: { signal?: AbortSignal },
): Promise<CursorParameterizedModel[]> {
  const tokenHash = tokenCacheHash(apiKey);
  if (
    cachedParameterizedModels?.tokenHash === tokenHash &&
    Date.now() < cachedParameterizedModels.expiresAt
  )
    return cachedParameterizedModels.models;
  try {
    const response = await callCursorUnaryRpc({
      accessToken: apiKey,
      rpcPath: "/aiserver.v1.AiService/AvailableModels",
      requestBody: encodeAvailableModelsRequest(),
      signal: options?.signal,
    });
    if (response.timedOut || response.exitCode !== 0 || response.body.length === 0) return [];
    const body = decodeConnectUnaryBody(response.body) ?? response.body;
    const models = decodeAvailableModelsResponse(body);
    cachedParameterizedModels = { tokenHash, models, expiresAt: Date.now() + MODEL_CACHE_TTL_MS };
    return models;
  } catch (err) {
    if (options?.signal?.aborted) return [];
    lifecycleLog("model_discovery_failed", {
      kind: "parameterized",
      message: err instanceof Error ? err.message : String(err),
    });
    return [];
  }
}

export interface CursorCatalog {
  rawModels: CursorModel[];
  parameterizedModels: CursorParameterizedModel[];
}

/**
 * Run both discovery RPCs and persist the result for the next process.
 *
 * This is the only path that writes the cross-process catalog cache, so a
 * partial failure (one RPC empty) still records whatever did come back rather
 * than leaving the next launch on the bundled fallback list.
 */
export async function discoverCursorCatalog(
  apiKey: string,
  options?: { signal?: AbortSignal },
): Promise<CursorCatalog> {
  const [rawModels, parameterizedModels] = await Promise.all([
    getCursorModels(apiKey, options),
    getCursorParameterizedModels(apiKey, options),
  ]);
  if (rawModels.length > 0 || parameterizedModels.length > 0) {
    writeCachedCatalog({ tokenHash: tokenCacheHash(apiKey), rawModels, parameterizedModels });
  }
  return { rawModels, parameterizedModels };
}

function normalizeCursorModels(models: readonly unknown[]): CursorModel[] {
  const byId = new Map<string, CursorModel>();
  for (const model of models) {
    const m = model as any;
    const id = m?.modelId?.trim?.();
    if (!id) continue;
    const name = m.displayName || m.displayNameShort || m.displayModelId || id;
    byId.set(id, {
      id,
      name,
      reasoning: Boolean(m.thinkingDetails),
      contextWindow: inferCursorContextWindow(id, name),
      maxTokens: inferCursorMaxOutputTokens(id, name),
    });
  }
  return [...byId.values()].sort((a, b) => a.id.localeCompare(b.id));
}
