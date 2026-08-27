import { describe, expect, it, vi } from "vitest";
import {
  resolveReviewRuntime,
  type ResolveReviewRuntimeOptions,
} from "../src/runtime/resolve-runtime.ts";
import { ReviewRuntimeError } from "../src/runtime/rpc-v3-client.ts";
import type {
  ReviewAgentStartedEvent,
  ReviewAgentTerminalEvent,
  ReviewRuntimeCapabilities,
  ReviewSubagentRuntime,
  SpawnReviewAgentInput,
} from "../src/runtime/types.ts";

class FakeRuntime implements ReviewSubagentRuntime {
  readonly dispose = vi.fn(async () => {});
  readonly assertNoUnsettledStops = vi.fn();
  readonly spawn = vi.fn(async (_input: SpawnReviewAgentInput) => ({ agentId: "agent" }));
  readonly stop = vi.fn(async () => {});
  readonly getCapabilities = vi.fn(async (_timeout?: number): Promise<ReviewRuntimeCapabilities> => ({
    protocolVersion: 3,
    maxConcurrent: 4,
    backend: "external-v3",
  }));

  onStarted(_handler: (event: ReviewAgentStartedEvent) => void): () => void {
    return () => {};
  }

  onTerminal(_handler: (event: ReviewAgentTerminalEvent) => void): () => void {
    return () => {};
  }
}

function options(
  external: FakeRuntime,
  embeddedFactory: () => Promise<FakeRuntime>,
): ResolveReviewRuntimeOptions {
  return {
    pi: {} as any,
    ctx: {} as any,
    events: { emit: vi.fn(), on: vi.fn(() => () => {}) },
    createExternal: () => external,
    createEmbedded: embeddedFactory,
  };
}

describe("resolveReviewRuntime", () => {
  it("prefers a compatible external runtime and never constructs embedded", async () => {
    const external = new FakeRuntime();
    const createEmbedded = vi.fn(async () => new FakeRuntime());

    const resolved = await resolveReviewRuntime(options(external, createEmbedded));

    expect(resolved.runtime).toBe(external);
    expect(resolved.capabilities).toEqual({
      protocolVersion: 3,
      maxConcurrent: 4,
      backend: "external-v3",
    });
    expect(external.getCapabilities).toHaveBeenCalledWith(250);
    expect(createEmbedded).not.toHaveBeenCalled();
    await resolved.dispose();
    expect(external.assertNoUnsettledStops).toHaveBeenCalledOnce();
    expect(external.dispose).not.toHaveBeenCalled();
  });

  it("silently uses embedded when no external extension responds", async () => {
    const external = new FakeRuntime();
    external.getCapabilities.mockRejectedValueOnce(
      new ReviewRuntimeError("subagents:rpc:ping timed out.", "unavailable"),
    );
    const embedded = new FakeRuntime();
    embedded.getCapabilities.mockResolvedValueOnce({
      protocolVersion: 3,
      maxConcurrent: 2,
      backend: "embedded",
    });

    const resolved = await resolveReviewRuntime(options(external, async () => embedded));

    expect(resolved.runtime).toBe(embedded);
    expect(resolved.warning).toBeUndefined();
    expect(resolved.capabilities).toEqual({
      protocolVersion: 3,
      maxConcurrent: 2,
      backend: "embedded",
      fallbackReason: "unavailable",
    });
    await resolved.dispose();
    expect(embedded.dispose).toHaveBeenCalledOnce();
  });

  it("warns and uses embedded when an installed runtime is incompatible", async () => {
    const external = new FakeRuntime();
    external.getCapabilities.mockRejectedValueOnce(
      new ReviewRuntimeError("Expected protocol 3", "incompatible"),
    );
    const embedded = new FakeRuntime();
    embedded.getCapabilities.mockResolvedValueOnce({
      protocolVersion: 3,
      maxConcurrent: 3,
      backend: "embedded",
    });

    const resolved = await resolveReviewRuntime(options(external, async () => embedded));

    expect(resolved.warning).toContain("Expected protocol 3");
    expect(resolved.warning).toContain("using the embedded runtime");
    expect(resolved.capabilities.fallbackReason).toBe("incompatible");
  });

  it("never migrates work after a compatible external backend was selected", async () => {
    const external = new FakeRuntime();
    external.spawn.mockRejectedValueOnce(new Error("provider failed"));
    const createEmbedded = vi.fn(async () => new FakeRuntime());
    const resolved = await resolveReviewRuntime(options(external, createEmbedded));

    await expect(resolved.runtime.spawn({} as SpawnReviewAgentInput)).rejects.toThrow(
      "provider failed",
    );
    expect(createEmbedded).not.toHaveBeenCalled();
  });

  it("fails with both diagnostics and disposes a broken embedded runtime", async () => {
    const external = new FakeRuntime();
    external.getCapabilities.mockRejectedValueOnce(
      new ReviewRuntimeError("external broken", "incompatible"),
    );
    const embedded = new FakeRuntime();
    embedded.getCapabilities.mockRejectedValueOnce(new Error("embedded broken"));

    await expect(resolveReviewRuntime(options(external, async () => embedded))).rejects.toThrow(
      /External runtime: external broken Embedded runtime: embedded broken/u,
    );
    expect(embedded.dispose).toHaveBeenCalledOnce();
  });
});
