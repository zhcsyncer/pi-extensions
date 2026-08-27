import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import {
  ADVERSARIAL_REVIEW_DISPATCH_TYPE,
  buildReviewDispatchEntry,
  publishReviewDispatch,
  renderReviewDispatchEntry,
} from "../src/output/run-transcript.ts";
import type { FrozenReviewInput, ReviewerRoute } from "../src/types.ts";

function route(ordinal: number): ReviewerRoute {
  const provider = `provider-${ordinal}`;
  const modelId = `model-${ordinal}`;
  return {
    key: `${provider}/${modelId}@high`,
    model: { provider, id: modelId, reasoning: true, secret: "omit" } as unknown as Model<any>,
    provider,
    modelId,
    thinking: "high",
    thinkingSource: "user",
    ordinal,
  };
}

function frozenInput(): FrozenReviewInput {
  return {
    runId: "run-123",
    target: {
      mode: "base",
      description: "base origin/main ... HEAD plus local changes",
      root: "/repo",
      headSha: "a".repeat(40),
      baseSha: "b".repeat(40),
      statusSha256: "c".repeat(64),
      targetSha256: "d".repeat(64),
      changedFiles: ["src/a.ts", "src/b.ts"],
    },
    inputSize: { bytes: 61_440, lines: 824 },
    inputSha256: "e".repeat(64),
    reviewerCwd: "/tmp/review",
    inputPath: "/tmp/review/input.md",
    charterSource: "builtin",
    charterSha256: "f".repeat(64),
    limitedContext: [],
    recheck: async () => ({ stale: false, changed: [] }),
    cleanup: async () => {},
  };
}

describe("review dispatch transcript", () => {
  it("serializes the frozen target and routes without model objects", () => {
    const entry = buildReviewDispatchEntry({
      frozenInput: frozenInput(),
      routes: [route(0), route(1)],
      refuteRequested: true,
      refuterRoute: route(2),
      gating: "weighted",
      capabilities: { protocolVersion: 3, backend: "external-v3", maxConcurrent: 4 },
      persistRouteSessions: true,
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
    });

    expect(entry).toMatchObject({
      status: "dispatched",
      runId: "run-123",
      input: { bytes: 61_440, lines: 824, files: 2 },
      requestedRoutes: [{ key: "provider-0/model-0@high" }, { key: "provider-1/model-1@high" }],
      refuterRoute: { key: "provider-2/model-2@high" },
      runtime: { backend: "external-v3", maxConcurrent: 4, persistRouteSessions: true },
    });
    expect(JSON.stringify(entry)).not.toContain('"model":');
    expect(JSON.stringify(entry)).not.toContain("secret");
  });

  it("renders a readable compact boundary and expanded dispatch details", () => {
    const entry = buildReviewDispatchEntry({
      frozenInput: frozenInput(),
      routes: [route(0), route(1)],
      refuteRequested: false,
      gating: "strict",
      capabilities: { protocolVersion: 3, backend: "embedded", maxConcurrent: 2 },
      startedAt: new Date("2026-01-01T00:00:00.000Z"),
    });
    const theme = { fg: (_color: string, text: string) => text } as any;
    const collapsed = renderReviewDispatchEntry(entry, { expanded: false }, theme)
      .render(140).join("\n");
    const expanded = renderReviewDispatchEntry(entry, { expanded: true }, theme)
      .render(140).join("\n");

    expect(collapsed).toContain("Adversarial review dispatched · 2 reviewers · strict");
    expect(collapsed).toContain("Target · base origin/main ... HEAD plus local changes");
    expect(collapsed).toContain("Ctrl+O details");
    expect(expanded).toContain("Input · 60.0 KiB · 824 lines · 2 files");
    expect(expanded).toContain("Runtime · embedded · max concurrent 2 · route sessions memory-only");
    expect(expanded).toContain("provider-0/model-0@high");
    expect(expanded).toContain("Refute · disabled");
  });

  it("appends one non-model-context dispatch entry and reports persistence failures", () => {
    const entry = buildReviewDispatchEntry({
      frozenInput: frozenInput(),
      routes: [route(0), route(1)],
      refuteRequested: false,
      gating: "weighted",
      capabilities: { protocolVersion: 3, backend: "external-v3", maxConcurrent: 4 },
      startedAt: new Date(),
    });
    const appendEntry = vi.fn();

    expect(publishReviewDispatch({ appendEntry } as unknown as ExtensionAPI, entry)).toBeUndefined();
    expect(appendEntry).toHaveBeenCalledWith(ADVERSARIAL_REVIEW_DISPATCH_TYPE, entry);

    const failure = publishReviewDispatch({
      appendEntry: () => { throw new Error("session closed"); },
    } as unknown as ExtensionAPI, entry);
    expect(failure).toContain("session closed");
  });
});
