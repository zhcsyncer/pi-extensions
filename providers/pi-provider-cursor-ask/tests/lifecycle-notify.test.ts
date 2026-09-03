import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { setCursorNotifySink } from "../src/stream/debug-log.js";
import { __testInternals } from "../src/stream/native-core.js";

const originalLifecycleLog = process.env.PI_CURSOR_LIFECYCLE_LOG;

function rebuildInput() {
  return {
    requestId: "req-1",
    bridgeKey: "bridge-key",
    convKey: "conv-key",
    modelId: "composer-2",
    decision: {
      kind: "rebuild_full_history" as const,
      hadStoredCheckpoint: true,
      conversationId: "conv-1",
      completedTurns: [],
      inFlightTurn: { userText: "hi", steps: [] },
      toolResults: [],
      blobStore: new Map<string, Uint8Array>(),
      wrappedText: "hi",
      rebuildReason: "stale_checkpoint" as const,
    },
  };
}

async function readLifecycleEvents(file: string): Promise<Array<Record<string, unknown>>> {
  return vi.waitFor(async () => {
    const text = await readFile(file, "utf8").catch(() => "");
    const lines = text
      .trim()
      .split("\n")
      .filter(Boolean)
      .map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(lines.length).toBeGreaterThan(0);
    return lines;
  });
}

describe("cursor lifecycle notify", () => {
  let dir: string;
  let logFile: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "pi-cursor-lifecycle-"));
    logFile = join(dir, "lifecycle.jsonl");
    process.env.PI_CURSOR_LIFECYCLE_LOG = logFile;
    setCursorNotifySink(undefined);
  });

  afterEach(async () => {
    setCursorNotifySink(undefined);
    if (originalLifecycleLog === undefined) delete process.env.PI_CURSOR_LIFECYCLE_LOG;
    else process.env.PI_CURSOR_LIFECYCLE_LOG = originalLifecycleLog;
    await rm(dir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("persists rebuild_full_history to the lifecycle file without JSON on stderr", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);

    __testInternals.logFullHistoryRebuild("native.rebuild_full_history", rebuildInput());

    const events = await readLifecycleEvents(logFile);
    const rebuild = events.find((event) => event.event === "rebuild_full_history");
    expect(rebuild).toMatchObject({
      event: "rebuild_full_history",
      reason: "stale_checkpoint",
      modelId: "composer-2",
      convKey: "conv-key",
    });
    expect(warn).not.toHaveBeenCalled();
    expect(error).not.toHaveBeenCalled();
  });

  it("notifies a short human message for rebuild when a sink is registered", () => {
    const notify = vi.fn();
    setCursorNotifySink(notify);

    __testInternals.logFullHistoryRebuild("native.rebuild_full_history", rebuildInput());

    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(
      "Cursor rebuilt conversation history (stale_checkpoint)",
      "warning",
    );
  });
});
