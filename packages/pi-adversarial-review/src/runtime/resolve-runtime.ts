import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createEmbeddedReviewRuntime } from "./embedded-runtime.ts";
import {
  PiSubagentRpcV3Client,
  type PiEventBus,
  ReviewRuntimeError,
} from "./rpc-v3-client.ts";
import type {
  ReviewRuntimeCapabilities,
  ReviewSubagentRuntime,
} from "./types.ts";

const DEFAULT_EXTERNAL_PROBE_TIMEOUT_MS = 250;

export interface ResolvedReviewRuntime {
  runtime: ReviewSubagentRuntime;
  capabilities: ReviewRuntimeCapabilities;
  warning?: string;
  dispose(): Promise<void>;
}

interface ProbeableReviewRuntime extends ReviewSubagentRuntime {
  getCapabilities(probeTimeoutMs?: number): Promise<ReviewRuntimeCapabilities>;
  assertNoUnsettledStops?(): void;
}

interface DisposableReviewRuntime extends ReviewSubagentRuntime {
  dispose(): Promise<void>;
}

export interface ResolveReviewRuntimeOptions {
  pi: ExtensionAPI;
  ctx: ExtensionContext;
  events: PiEventBus;
  externalProbeTimeoutMs?: number;
  createExternal?: (events: PiEventBus) => ProbeableReviewRuntime;
  createEmbedded?: () => Promise<DisposableReviewRuntime>;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Pick one runtime before any reviewer is spawned and pin it for the whole run.
 * Runtime failures after this point are route failures and never trigger a
 * second backend, which prevents duplicate reviewer execution.
 */
export async function resolveReviewRuntime(
  options: ResolveReviewRuntimeOptions,
): Promise<ResolvedReviewRuntime> {
  const external = options.createExternal?.(options.events) ??
    new PiSubagentRpcV3Client(options.events);
  let externalError: unknown;
  try {
    const capabilities = await external.getCapabilities(
      options.externalProbeTimeoutMs ?? DEFAULT_EXTERNAL_PROBE_TIMEOUT_MS,
    );
    return {
      runtime: external,
      capabilities,
      dispose: async () => { external.assertNoUnsettledStops?.(); },
    };
  } catch (error) {
    externalError = error;
  }

  let embedded: DisposableReviewRuntime;
  try {
    embedded = await (options.createEmbedded?.() ?? createEmbeddedReviewRuntime({
      pi: options.pi,
      ctx: options.ctx,
    }));
  } catch (error) {
    throw new Error(
      `No usable adversarial-review subagent runtime. External runtime: ${errorText(externalError)} ` +
        `Embedded runtime: ${errorText(error)}`,
    );
  }

  let baseCapabilities: ReviewRuntimeCapabilities;
  try {
    baseCapabilities = await embedded.getCapabilities();
  } catch (error) {
    await embedded.dispose().catch(() => {});
    throw new Error(
      `No usable adversarial-review subagent runtime. External runtime: ${errorText(externalError)} ` +
        `Embedded runtime: ${errorText(error)}`,
    );
  }
  const unavailable = externalError instanceof ReviewRuntimeError &&
    externalError.kind === "unavailable";
  const capabilities: ReviewRuntimeCapabilities = {
    ...baseCapabilities,
    fallbackReason: unavailable ? "unavailable" : "incompatible",
  };
  return {
    runtime: embedded,
    capabilities,
    ...(!unavailable
      ? {
          warning:
            `External Subagents runtime was ignored (${errorText(externalError)}); ` +
            "using the embedded runtime for this review.",
        }
      : {}),
    dispose: () => embedded.dispose(),
  };
}
