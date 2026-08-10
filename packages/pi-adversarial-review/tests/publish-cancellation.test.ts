import { readFile, rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import type { Model } from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  buildReviewFreezeCancellationAudit,
  publishReviewFreezeCancellation,
} from "../src/output/publish-cancellation.ts";
import type { ReviewerRoute } from "../src/types.ts";

const roots: string[] = [];
const originalExitCode = process.exitCode;

function route(ordinal: number): ReviewerRoute {
  const provider = `provider-${ordinal}`;
  const modelId = `model-${ordinal}`;
  return {
    key: `${provider}/${modelId}@high`,
    model: { provider, id: modelId, reasoning: true } as Model<any>,
    provider,
    modelId,
    thinking: "high",
    thinkingSource: "user",
    ordinal,
  };
}

afterEach(async () => {
  process.exitCode = originalExitCode;
  vi.restoreAllMocks();
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("pre-freeze cancellation publishing", () => {
  it("fails loud in JSON mode and atomically persists the minimal cancellation audit", async () => {
    const agentDir = mkdtempSync(path.join(tmpdir(), "pi-adversarial-cancel-audit-"));
    roots.push(agentDir);
    const entries: Array<{ type: string; details: unknown }> = [];
    const pi = {
      appendEntry: (type: string, details: unknown) => entries.push({ type, details }),
    } as unknown as ExtensionAPI;
    const stderr = vi.spyOn(console, "error").mockImplementation(() => {});
    const audit = buildReviewFreezeCancellationAudit({
      target: { mode: "range", fromRef: "from", toRef: "to" },
      preflight: {
        selection: "explicit",
        fetchStatus: "not-needed",
        inputBytes: 123,
        inputLines: 9,
      },
      requestedRoutes: [route(0), route(1)],
      refuteRequested: true,
      refuterRoute: route(2),
      gating: "strict",
      startedAt: new Date("2026-03-01T01:02:03.000Z"),
      cancelledAt: new Date("2026-03-01T01:02:04.000Z"),
    });

    const published = publishReviewFreezeCancellation({
      pi,
      mode: "json",
      audit,
      sessionId: "session-1",
      cwd: "/repo",
      agentDir,
    });

    expect(process.exitCode).toBe(1);
    expect(stderr).toHaveBeenCalledWith(
      "Adversarial review: cancelled while freezing input; no reviewer was started.",
    );
    expect(entries).toEqual([{ type: "adversarial-review-cancellation", details: audit }]);
    expect(published.auditPath).toBeDefined();
    const record = JSON.parse(await readFile(published.auditPath!, "utf8"));
    expect(record).toMatchObject({
      version: 1,
      kind: "cancellation",
      mode: "json",
      sessionId: "session-1",
      cwd: "/repo",
      payload: audit,
    });
    expect(record.payload).not.toHaveProperty("inputSha256");
    expect(record.payload).not.toHaveProperty("routeResults");
  });
});
