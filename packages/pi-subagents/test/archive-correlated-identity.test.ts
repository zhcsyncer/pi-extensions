import { describe, expect, it } from "vitest";
import { archiveAgentRecord, listArchivedAgents, recordFromArchive } from "../src/session-archive.js";
import type { AgentRecord } from "../src/types.js";

function completedRecord(): AgentRecord {
  return {
    id: "correlated-child", type: "reviewer", description: "Review a change",
    status: "completed", result: "review complete", toolUses: 1,
    startedAt: 100, completedAt: 200, sessionFile: "/sessions/reviewer.jsonl",
    lifetimeUsage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0 },
    compactionCount: 0, completionOwner: "caller", completionDelivery: "steer",
    runGeneration: 3,
  };
}

function roundTrip(record: AgentRecord) {
  // Exercise the actual parent-branch parser after a JSON persistence boundary,
  // not only copying an in-memory object through the serializer.
  const data = JSON.parse(JSON.stringify(archiveAgentRecord(record)));
  const [archive] = listArchivedAgents({
    getBranch: () => [{ type: "custom", customType: "subagents:record", data }],
  });
  return recordFromArchive(archive);
}

describe("archived cross-extension identity", () => {
  it("preserves caller correlation and requested/effective route through persistence and hydration", () => {
    const identity = {
      correlationId: "review:route-42",
      completionOwner: "caller" as const,
      completionDelivery: "steer" as const,
      requestedModel: { provider: "requested-provider", modelId: "requested-model" },
      requestedThinkingLevel: "high" as const,
      effectiveModel: { provider: "effective-provider", modelId: "effective-model" },
      effectiveThinkingLevel: "off" as const,
      runGeneration: 3,
    };
    const restored = roundTrip({ ...completedRecord(), ...identity });
    expect(restored).toMatchObject(identity);
    expect(restored.result).toBe("review complete");
    expect(restored.session).toBeUndefined();
  });

  it("does not fabricate correlated route metadata for older archives", () => {
    const restored = roundTrip({
      ...completedRecord(),
      invocation: { modelName: "display-only-model", thinking: "high" },
    });
    expect(restored.correlationId).toBeUndefined();
    expect(restored.requestedModel).toBeUndefined();
    expect(restored.requestedThinkingLevel).toBeUndefined();
    expect(restored.effectiveModel).toBeUndefined();
    expect(restored.effectiveThinkingLevel).toBeUndefined();
  });
});
