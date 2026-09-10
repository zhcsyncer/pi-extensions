import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AgentManager } from "../src/agent-manager.js";
import { restoreAgentSession, resumeAgent, runAgent } from "../src/agent-runner.js";
import { archiveAgentRecord } from "../src/session-archive.js";
import type { AgentRecord, AgentResumeSnapshot } from "../src/types.js";

vi.mock("../src/agent-runner.js", () => ({
  runAgent: vi.fn(),
  resumeAgent: vi.fn(),
  restoreAgentSession: vi.fn(),
}));
vi.mock("../src/worktree.js", () => ({
  createWorktree: vi.fn(),
  cleanupWorktree: vi.fn(() => ({ hasChanges: false })),
  isWorktreeIsolationEnabled: vi.fn(() => true),
  pruneWorktrees: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

// Only advance microtasks: prompt completion, SDK delivery and reconstruction
// remain controlled by explicit gates, never wall-clock sleeps.
async function flush() {
  for (let i = 0; i < 20; i++) await Promise.resolve();
}

/** SDK-like queue: steer accepts, but only the model loop consumes messages.
 * A late steer after the core's final queue check stays stranded until clearQueue
 * and a new prompt. Thus a spy being called cannot masquerade as delivery.
 */
class SessionQueue {
  isStreaming = false;
  active = 0;
  maximumActive = 0;
  accepted: string[] = [];
  prompts: string[] = [];
  private steering: string[] = [];
  private followUps: string[] = [];
  deliveryGate?: ReturnType<typeof deferred<void>>;
  deliveryFailure?: Error;
  dispose = vi.fn();
  sessionManager = { getSessionFile: () => "/sessions/child.jsonl" };
  steer = vi.fn(async (message: string) => {
    if (this.deliveryGate) await this.deliveryGate.promise;
    if (this.deliveryFailure) throw this.deliveryFailure;
    this.steering.push(message);
  });
  getSteeringMessages = () => [...this.steering];
  getFollowUpMessages = () => [...this.followUps];
  clearQueue = vi.fn(() => {
    const queued = { steering: this.steering, followUp: this.followUps };
    this.steering = [];
    this.followUps = [];
    return queued;
  });

  begin(prompt: string) {
    this.maximumActive = Math.max(this.maximumActive, ++this.active);
    if (this.active !== 1) throw new Error("concurrent session.prompt");
    this.isStreaming = true;
    this.prompts.push(prompt);
    this.accepted.push(prompt);
  }

  consume() {
    this.accepted.push(...this.steering, ...this.followUps);
    this.steering = [];
    this.followUps = [];
  }
}

type Outcome = { failure?: string; aborted?: boolean; steered?: boolean };
class PromptControl {
  done = deferred<any>();
  started = false;
  coreChecked = false;
  ended = false;
  constructor(
    readonly kind: "first" | "resume",
    readonly session: SessionQueue,
    readonly prompt: string,
    readonly options: any,
  ) {}

  start() {
    this.started = true;
    if (this.kind === "first") {
      this.options.onResumeSnapshot?.(snapshot);
      this.options.onSessionCreated?.(this.session);
    }
    this.session.begin(this.prompt);
  }

  // Model core has checked for queued messages but AgentSession may still
  // report streaming until its agent_end handler runs.
  coreIdleCheck() {
    if (!this.coreChecked) this.session.consume();
    this.coreChecked = true;
  }

  idle() {
    this.coreIdleCheck();
    this.session.isStreaming = false;
    if (!this.ended) this.session.active--;
    this.ended = true;
  }

  finish(outcome: Outcome = {}) {
    this.idle();
    const text = `answer: ${this.session.accepted.join(" | ")}`;
    this.done.resolve(this.kind === "first"
      ? { responseText: text, session: this.session, aborted: false, steered: false, ...outcome }
      : { text, ...outcome });
  }

  fail(message: string) {
    this.idle();
    this.done.reject(new Error(message));
  }
}

const snapshot: AgentResumeSnapshot = {
  version: 1,
  config: {
    name: "general-purpose", description: "test", systemPrompt: "Help.",
    extensions: false, skills: false, promptMode: "replace",
  },
  systemPrompt: "Help.",
  cwd: "/tmp",
  configCwd: "/tmp",
  model: { provider: "test", modelId: "test" },
  thinkingLevel: "off",
  isolated: true,
  maxTurns: 7,
  graceTurns: 2,
};
const pi = {} as any;
const ctx = { cwd: "/tmp", sessionManager: { getBranch: () => [] } } as any;

let managers: AgentManager[];
let calls: PromptControl[];
let delayFirstStart: boolean;
let onComplete: ReturnType<typeof vi.fn>;
let onStart: ReturnType<typeof vi.fn>;
let onCompact: ReturnType<typeof vi.fn>;

function manager(limit = 1, options: ConstructorParameters<typeof AgentManager>[4] = {}) {
  const value = new AgentManager(onComplete, limit, onStart, onCompact, options);
  managers.push(value);
  return value;
}
function spawn(m: AgentManager, prompt = "first", extra: Record<string, unknown> = {}) {
  return m.spawn(pi, ctx, "general-purpose", prompt, {
    description: prompt, isBackground: true, ...extra,
  });
}
async function completed(m: AgentManager, outcome: Outcome = {}) {
  const id = spawn(m);
  calls.at(-1)!.finish(outcome);
  await m.waitForAll();
  return id;
}
function expectAnswer(record: AgentRecord, messages: string[]) {
  expect(record.status).toBe("completed");
  expect(record.result).toBe(`answer: ${messages.join(" | ")}`);
  expect(record.error).toBeUndefined();
}
function parentBranch(record: AgentRecord) {
  const archive = archiveAgentRecord(record)!;
  expect(archive).toBeDefined();
  return {
    ...ctx,
    sessionManager: {
      getBranch: () => [{ type: "custom", customType: "subagents:record", data: archive }],
    },
  } as any;
}

beforeEach(() => {
  vi.resetAllMocks();
  managers = [];
  calls = [];
  delayFirstStart = false;
  onComplete = vi.fn();
  onStart = vi.fn();
  onCompact = vi.fn();
  vi.mocked(runAgent).mockImplementation((_ctx, _type, prompt, options) => {
    const call = new PromptControl("first", new SessionQueue(), prompt, options);
    calls.push(call);
    if (!delayFirstStart) call.start();
    return call.done.promise;
  });
  vi.mocked(resumeAgent).mockImplementation((session, prompt, options) => {
    const call = new PromptControl("resume", session as unknown as SessionQueue, prompt, options);
    calls.push(call);
    call.start();
    return call.done.promise;
  });
});
afterEach(() => {
  for (const m of managers) m.dispose();
});

describe("follow-up lifecycle — shared execution ownership", () => {
  it("retains the previous report after a queued continuation is stopped, including disk-only lookup", async () => {
    const m = manager();
    const id = await completed(m);
    const previous = m.getRecord(id)!.result;
    spawn(m, "occupy the only slot");
    const active = calls.at(-1)!;
    await m.resume(id, "continue later", undefined, { isBackground: true });
    expect(m.getRecord(id)?.status).toBe("queued");
    expect(m.abort(id)).toBe(true);
    const stopped = m.getRecord(id)!;
    expect(stopped.status).toBe("stopped");
    expect(stopped.result).toBeUndefined();
    expect(stopped.previousResult).toBe(previous);
    const parent = parentBranch(stopped);
    const restarted = manager();
    expect(restarted.getRecordOrArchive(id, parent)?.previousResult).toBe(previous);
    await expect(restarted.sendMessage(id, "do not restart", { pi, ctx: parent })).rejects.toThrow(/explicitly retry/);
    active.finish();
    await m.waitForAll();
  });

  it.each([{ steered: false }, { steered: true }])("automatically resumes a successful terminal run (%j) in the background", async (outcome) => {
    const m = manager();
    const id = await completed(m, outcome);
    const record = m.getRecord(id)!;
    const oldController = record.abortController;
    const generation = record.runGeneration!;
    record.resultConsumed = true;
    record.groupId = "old-group";

    await expect(m.sendMessage(id, "next")).resolves.toBe("resumed");
    expect(record).toMatchObject({
      status: "running", isBackground: true, resultConsumed: false, runGeneration: generation + 1,
    });
    expect(record.groupId).toBeUndefined();
    expect(record.completedAt).toBeUndefined();
    expect(record.result).toBeUndefined();
    expect(record.abortController).not.toBe(oldController);
    expect(calls[1].options.signal).toBe(record.abortController!.signal);
    expect(calls[1].options.signal.aborted).toBe(false);
    expect(onComplete).toHaveBeenCalledTimes(1);

    calls[1].finish();
    await m.waitForAll();
    expectAnswer(record, ["first", "next"]);
    expect(record.resultConsumed).toBe(false);
    expect(calls[1].session.prompts).toEqual(["first", "next"]);
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("uses one FIFO concurrency budget for resumed work and first runs", async () => {
    const m = manager();
    const id = await completed(m);
    const blocker = spawn(m, "blocker");
    await expect(m.resume(id, "resume queued", undefined, { isBackground: true })).resolves.toBe(m.getRecord(id));
    const fresh = spawn(m, "new queued");
    expect(m.getRecord(id)?.status).toBe("queued");
    expect(m.getRecord(fresh)?.status).toBe("queued");
    expect(calls.map((c) => c.prompt)).toEqual(["first", "blocker"]);
    await expect(m.sendMessage(id, "extra queued")).resolves.toBe("queued");
    const waited = vi.fn();
    const all = m.waitForAll().then(waited);

    calls[1].finish();
    await flush();
    expect(m.getRecord(blocker)?.status).toBe("completed");
    expect(calls.map((c) => c.prompt)).toEqual(["first", "blocker", "resume queued"]);
    expect(m.getRecord(fresh)?.status).toBe("queued");
    expect(waited).not.toHaveBeenCalled();
    calls[2].finish();
    await flush();
    // A queued follow-up must be consumed before this record releases its slot.
    const lastResume = calls.at(-1)!;
    expect(lastResume.session).toBe(calls[0].session);
    expect(lastResume.prompt).toBe("extra queued");
    expect(m.getRecord(fresh)?.status).toBe("queued");
    lastResume.finish();
    await flush();
    expect(calls.at(-1)!.prompt).toBe("new queued");
    expect(waited).not.toHaveBeenCalled();
    calls.at(-1)!.finish();
    await all;
    expectAnswer(m.getRecord(id)!, ["first", "resume queued", "extra queued"]);
    expectAnswer(m.getRecord(fresh)!, ["new queued"]);
    expect(onStart).toHaveBeenCalledTimes(4);
    expect(onComplete).toHaveBeenCalledTimes(4);
  });

  it("foreground resume waits and bypasses the occupied background slot", async () => {
    const m = manager();
    const id = await completed(m);
    spawn(m, "blocker");
    const returned = vi.fn();
    const resumed = m.resume(id, "foreground").then(returned);
    expect(calls.at(-1)!.prompt).toBe("foreground");
    await flush();
    expect(returned).not.toHaveBeenCalled();
    calls[2].finish();
    await resumed;
    expectAnswer(m.getRecord(id)!, ["first", "foreground"]);
    expect(m.getRecord(id)?.resultConsumed).toBe(true);
    expect(m.getRecord(id)?.isBackground).toBe(false);
    calls[1].finish();
    await m.waitForAll();
  });

  it("abortAndWait and waitForAll wait for the resumed execution, not the old completed promise", async () => {
    const m = manager();
    const id = await completed(m);
    await m.resume(id, "resume", undefined, { isBackground: true });
    const aborted = vi.fn();
    const waited = vi.fn();
    const stopping = m.abortAndWait(id).then(aborted);
    const all = m.waitForAll().then(waited);
    await flush();
    expect(m.getRecord(id)?.status).toBe("stopped");
    expect(calls[1].options.signal.aborted).toBe(true);
    expect(aborted).not.toHaveBeenCalled();
    expect(waited).not.toHaveBeenCalled();
    // Even a non-cooperative runner returning success must not undo stop.
    calls[1].finish();
    await Promise.all([stopping, all]);
    expect(aborted).toHaveBeenCalledWith(true);
    expect(m.getRecord(id)?.status).toBe("stopped");
    expect(m.getRecord(id)?.result).toBe("answer: first | resume");
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("forwards foreground resume cancellation and permits an explicit retry after stop", async () => {
    const m = manager();
    const id = await completed(m);
    const parent = new AbortController();
    const resumed = m.resume(id, "cancel me", parent.signal);
    parent.abort();
    expect(calls[1].options.signal.aborted).toBe(true);
    calls[1].finish({ aborted: true });
    await resumed;
    expect(m.getRecord(id)?.status).toBe("stopped");
    await expect(m.sendMessage(id, "not authorized")).rejects.toThrow(/Agent.*resume/i);
    const retry = m.resume(id, "explicit retry");
    expect(calls[2].options.signal.aborted).toBe(false);
    calls[2].finish();
    await retry;
    expectAnswer(m.getRecord(id)!, ["first", "cancel me", "explicit retry"]);
  });

  it("stopping a queued resume settles waiters without executing its prompt", async () => {
    const m = manager();
    const id = await completed(m);
    spawn(m, "blocker");
    await m.resume(id, "never run", undefined, { isBackground: true });
    await expect(m.abortAndWait(id)).resolves.toBe(true);
    calls[1].finish();
    await m.waitForAll();
    expect(calls.map((c) => c.prompt)).toEqual(["first", "blocker"]);
    expect(m.getRecord(id)?.status).toBe("stopped");
  });

  it("accounts resumed tool usage, lifetime usage, compaction and terminal callbacks", async () => {
    const m = manager();
    const id = await completed(m);
    await m.sendMessage(id, "accounted resume");
    const options = calls[1].options;
    options.onToolActivity({ type: "start", toolName: "read", toolCallId: "t1" });
    options.onToolActivity({ type: "end", toolName: "read", toolCallId: "t1" });
    options.onAssistantUsage({ input: 13, output: 7, cacheRead: 11, cacheWrite: 2 });
    options.onCompaction({ reason: "overflow", tokensBefore: 999 });
    const cleanup = vi.fn();
    m.getRecord(id)!.outputCleanup = cleanup;
    calls[1].finish();
    await m.waitForAll();
    expect(m.getRecord(id)).toMatchObject({
      toolUses: 1, compactionCount: 1,
      lifetimeUsage: { input: 13, output: 7, cacheRead: 11, cacheWrite: 2 },
    });
    expectAnswer(m.getRecord(id)!, ["first", "accounted resume"]);
    expect(onStart).toHaveBeenCalledTimes(2);
    expect(onComplete).toHaveBeenCalledTimes(2);
    expect(onCompact).toHaveBeenCalledExactlyOnceWith(m.getRecord(id), { reason: "overflow", tokensBefore: 999 });
    expect(cleanup).toHaveBeenCalledOnce();
  });
});

describe("follow-up lifecycle — delivery and completion races", () => {
  it("retains messages during first-session startup until the model actually consumes them", async () => {
    delayFirstStart = true;
    const m = manager();
    const id = spawn(m);
    await expect(m.sendMessage(id, "during startup")).resolves.toBe("queued");
    expect(calls[0].session.accepted).toEqual([]);
    calls[0].start();
    await flush();
    calls[0].finish();
    await m.waitForAll();
    expectAnswer(m.getRecord(id)!, ["first", "during startup"]);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("retains messages while a first run is queued behind another agent", async () => {
    const m = manager();
    spawn(m, "blocker");
    const id = spawn(m, "queued first");
    await expect(m.sendMessage(id, "queued instruction")).resolves.toBe("queued");
    calls[0].finish();
    await flush();
    calls[1].finish();
    await m.waitForAll();
    expectAnswer(m.getRecord(id)!, ["queued first", "queued instruction"]);
  });

  it("repeated messages during a streaming resume steer one prompt without replaying consumed messages", async () => {
    const m = manager();
    const id = await completed(m);
    await m.sendMessage(id, "resume");
    await expect(m.sendMessage(id, "steer one")).resolves.toBe("steered");
    await expect(m.sendMessage(id, "steer two")).resolves.toBe("steered");
    expect(calls).toHaveLength(2);
    calls[1].finish();
    await m.waitForAll();
    expectAnswer(m.getRecord(id)!, ["first", "resume", "steer one", "steer two"]);
    expect(calls[1].session.prompts).toEqual(["first", "resume"]);
    expect(calls[1].session.maximumActive).toBe(1);
    expect(calls[1].session.getSteeringMessages()).toEqual([]);
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("continues a message arriving after isStreaming becomes false but before the first promise settles", async () => {
    const m = manager();
    const id = spawn(m);
    calls[0].idle();
    await expect(m.sendMessage(id, "at completion")).resolves.toBe("queued");
    expect(calls).toHaveLength(1);
    expect(onComplete).not.toHaveBeenCalled();
    calls[0].finish();
    await flush();
    expect(calls[1].prompt).toBe("at completion");
    expect(m.getRecord(id)?.status).toBe("running");
    expect(onComplete).not.toHaveBeenCalled();
    calls[1].finish();
    await m.waitForAll();
    expectAnswer(m.getRecord(id)!, ["first", "at completion"]);
    expect(calls[0].session.maximumActive).toBe(1);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("recovers a stranded SDK steer after the core idle check, including delayed steer acceptance", async () => {
    const m = manager();
    const id = spawn(m);
    const session = calls[0].session;
    session.deliveryGate = deferred<void>();
    calls[0].coreIdleCheck();
    const delivery = m.sendMessage(id, "late SDK steer");
    calls[0].finish();
    await flush();
    expect(onComplete).not.toHaveBeenCalled();
    expect(calls).toHaveLength(1);
    session.deliveryGate.resolve();
    await expect(delivery).resolves.toBe("steered");
    await flush();
    expect(calls[1].prompt).toBe("late SDK steer");
    expect(session.getSteeringMessages()).toEqual([]);
    expect(session.clearQueue).toHaveBeenCalledOnce();
    calls[1].finish();
    await m.waitForAll();
    expectAnswer(m.getRecord(id)!, ["first", "late SDK steer"]);
    expect(session.maximumActive).toBe(1);
    expect(onComplete).toHaveBeenCalledOnce();
  });
});

describe("follow-up lifecycle — failure is not retry authorization", () => {
  it.each(["reject", "failure", "aborted"] as const)("does not auto-restart after %s even with an accepted pending follow-up", async (kind) => {
    const m = manager();
    const id = spawn(m);
    calls[0].idle();
    await m.sendMessage(id, "must not restart");
    if (kind === "reject") calls[0].fail("provider rejected");
    else calls[0].finish(kind === "failure" ? { failure: "provider failed" } : { aborted: true });
    await m.waitForAll();
    expect(m.getRecord(id)?.status).toBe(kind === "aborted" ? "aborted" : "error");
    await expect(m.sendMessage(id, "still unauthorized")).rejects.toThrow(/Agent.*resume/i);
    expect(calls).toHaveLength(1);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it("a rejected SDK steer is observable and cannot turn into a clean completion or auto-retry", async () => {
    const m = manager();
    const id = spawn(m);
    calls[0].session.deliveryFailure = new Error("template expansion failed");
    await expect(m.sendMessage(id, "bad message")).rejects.toThrow("template expansion failed");
    calls[0].finish();
    await m.waitForAll();
    expect(m.getRecord(id)).toMatchObject({ status: "error", error: expect.stringContaining("template expansion failed") });
    expect(calls).toHaveLength(1);
    expect(onComplete).toHaveBeenCalledOnce();
  });

  it.each(["reject", "failure"] as const)("allows an explicit retry after resumed %s and clears stale failure/result", async (kind) => {
    const m = manager();
    const id = await completed(m);
    await m.sendMessage(id, "failed resume");
    if (kind === "reject") calls[1].fail("resume rejected");
    else calls[1].finish({ failure: "resume failed" });
    await m.waitForAll();
    expect(m.getRecord(id)?.status).toBe("error");
    await expect(m.sendMessage(id, "unauthorized")).rejects.toThrow(/Agent.*resume/i);
    const retry = m.resume(id, "explicit retry");
    expect(m.getRecord(id)?.error).toBeUndefined();
    expect(m.getRecord(id)?.result).toBeUndefined();
    calls[2].finish();
    await retry;
    expectAnswer(m.getRecord(id)!, ["first", "failed resume", "explicit retry"]);
    expect(onComplete).toHaveBeenCalledTimes(3);
  });

  it("a late resumed rejection cannot overwrite an explicit stop", async () => {
    const m = manager();
    const id = await completed(m);
    await m.sendMessage(id, "resume");
    const stopping = m.abortAndWait(id);
    calls[1].fail("late rejection");
    await stopping;
    expect(m.getRecord(id)?.status).toBe("stopped");
    expect(onComplete).toHaveBeenCalledTimes(2);
  });
});

describe("follow-up lifecycle — terminal delivery barriers", () => {
  it.each(["stop", "reject"] as const)("waits for delayed SDK acceptance on %s and discards it before explicit retry", async (kind) => {
    const m = manager();
    const id = spawn(m);
    const session = calls[0].session;
    session.deliveryGate = deferred<void>();
    calls[0].coreIdleCheck();
    const delivery = m.sendMessage(id, "old deferred instruction");
    const settled = vi.fn();
    const execution = m.getRecord(id)!.promise!.then(settled);
    if (kind === "stop") {
      m.abort(id);
      expect(session.clearQueue).toHaveBeenCalledOnce();
      calls[0].finish();
    } else {
      calls[0].fail("provider rejected");
    }
    await flush();
    expect.soft(settled).not.toHaveBeenCalled();
    expect.soft(onComplete).not.toHaveBeenCalled();
    expect(session.getSteeringMessages()).toEqual([]);

    // Acceptance occurs AFTER stop's first clearQueue, not before it.
    session.deliveryGate.resolve();
    await delivery;
    await execution;
    expect(m.getRecord(id)?.status).toBe(kind === "stop" ? "stopped" : "error");
    expect.soft(session.getSteeringMessages()).toEqual([]);
    if (kind === "stop") expect.soft(session.clearQueue.mock.calls.length).toBeGreaterThanOrEqual(2);
    expect(onComplete).toHaveBeenCalledOnce();

    const retry = m.resume(id, "explicit retry");
    calls[1].finish();
    await retry;
    expectAnswer(m.getRecord(id)!, ["first", "explicit retry"]);
    expect(session.accepted).not.toContain("old deferred instruction");
    expect(session.maximumActive).toBe(1);
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it.each(["failure", "aborted", "reject"] as const)("discards both SDK and manager-pending queues after %s", async (kind) => {
    const m = manager();
    const id = spawn(m);
    const session = calls[0].session;
    calls[0].coreIdleCheck();
    await m.sendMessage(id, "old SDK instruction");
    calls[0].idle();
    await m.sendMessage(id, "old pending instruction");
    expect(session.getSteeringMessages()).toEqual(["old SDK instruction"]);
    expect(m.getRecord(id)?.pendingSteers).toEqual(["old pending instruction"]);
    if (kind === "reject") calls[0].fail("provider rejected");
    else calls[0].finish(kind === "failure" ? { failure: "provider failed" } : { aborted: true });
    await m.waitForAll();
    expect(m.getRecord(id)?.status).toBe(kind === "aborted" ? "aborted" : "error");
    expect.soft(session.getSteeringMessages()).toEqual([]);
    expect.soft(m.getRecord(id)?.pendingSteers ?? []).toEqual([]);
    expect(calls).toHaveLength(1);

    const retry = m.resume(id, "clean retry");
    calls[1].finish();
    await flush();
    // Finish an incorrectly replayed continuation as well, so a failure reports
    // actual stale delivery instead of hanging on the test's own prompt gate.
    if (calls.length > 2) calls[2].finish();
    await retry;
    expectAnswer(m.getRecord(id)!, ["first", "clean retry"]);
    expect(session.prompts).toEqual(["first", "clean retry"]);
    expect(onComplete).toHaveBeenCalledTimes(2);
  });
});

describe("follow-up lifecycle — result waiters", () => {
  it("waitForResult waits actual settlement after a resumed record is already marked stopped", async () => {
    const m = manager();
    const id = await completed(m);
    await m.sendMessage(id, "resume");
    m.abort(id);
    const observed = vi.fn();
    const waiting = m.waitForResult(id).then(() => observed({
      status: m.getRecord(id)?.status,
      result: m.getRecord(id)?.result,
    }));
    await flush();
    expect(observed).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    calls[1].finish();
    await waiting;
    expect(observed).toHaveBeenCalledExactlyOnceWith({ status: "stopped", result: "answer: first | resume" });
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("waitForResult follows the next generation synchronously created by onComplete", async () => {
    const m = manager();
    const id = spawn(m);
    let followUp: Promise<string> | undefined;
    onComplete.mockImplementation((record: AgentRecord) => {
      if (record.id === id && record.runGeneration === 1) {
        followUp = m.sendMessage(id, "from completion callback");
      }
    });
    const observed = vi.fn();
    const waiting = m.waitForResult(id).then(() => observed({
      generation: m.getRecord(id)?.runGeneration,
      status: m.getRecord(id)?.status,
      result: m.getRecord(id)?.result,
    }));
    calls[0].finish();
    await flush();
    await expect(followUp).resolves.toBe("resumed");
    expect(m.getRecord(id)?.runGeneration).toBe(2);
    expect(calls[1].prompt).toBe("from completion callback");
    expect(observed).not.toHaveBeenCalled();
    expect(onComplete).toHaveBeenCalledTimes(1);
    calls[1].finish();
    await waiting;
    expect(observed).toHaveBeenCalledExactlyOnceWith({
      generation: 2, status: "completed", result: "answer: first | from completion callback",
    });
    expect(onComplete).toHaveBeenCalledTimes(2);
  });
});

describe("follow-up lifecycle — acceptance before admission", () => {
  it.each([false, true])("onAccepted observes the proposed queued resume before admission (busy=%s)", async (busy) => {
    const accepted: { generation?: number; status: string; starts: number }[] = [];
    const m = manager(1, {
      onAccepted: (record: AgentRecord) => {
        if ((record.runGeneration ?? 1) > 1) accepted.push({
          generation: record.runGeneration, status: record.status, starts: calls.length,
        });
      },
    });
    const id = await completed(m);
    if (busy) spawn(m, "blocker");
    await m.resume(id, "accepted resume", undefined, { isBackground: true });
    expect(accepted).toEqual([{ generation: 2, status: "queued", starts: busy ? 2 : 1 }]);
    expect(m.getRecord(id)?.status).toBe(busy ? "queued" : "running");
    if (busy) {
      expect(calls).toHaveLength(2);
      calls[1].finish();
      await flush();
    }
    calls.at(-1)!.finish();
    await m.waitForAll();
    expectAnswer(m.getRecord(id)!, ["first", "accepted resume"]);
    expect(accepted).toHaveLength(1);
    expect(onComplete).toHaveBeenCalledTimes(busy ? 3 : 2);
  });

  it("a throwing onAccepted leaves the prior completed record and generation untouched", async () => {
    let rejectAcceptance = true;
    const m = manager(1, {
      onAccepted: (record: AgentRecord) => {
        if ((record.runGeneration ?? 1) > 1 && rejectAcceptance) throw new Error("acceptance persistence failed");
      },
    });
    const id = await completed(m);
    const record = m.getRecord(id)!;
    record.resultConsumed = true;
    record.groupId = "previous-group";
    const before = { ...record };
    await expect(m.resume(id, "not accepted", undefined, { isBackground: true }))
      .rejects.toThrow("acceptance persistence failed");
    expect(m.getRecord(id)).toBe(record);
    expect(record).toEqual(before);
    expect(calls).toHaveLength(1);
    expect(onStart).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledOnce();
    expect(m.hasRunning()).toBe(false);
    await m.waitForAll();

    rejectAcceptance = false;
    const retry = m.resume(id, "accepted retry");
    expect(record.runGeneration).toBe(before.runGeneration! + 1);
    calls[1].finish();
    await retry;
    expectAnswer(record, ["first", "accepted retry"]);
    expect(onComplete).toHaveBeenCalledTimes(2);
  });
});

describe("follow-up lifecycle — archive reconstruction", () => {
  it.each(["clearCompleted", "new manager"] as const)("restores an archived conversation after %s without a new first run", async (mode) => {
    const original = manager();
    const id = await completed(original);
    const parent = parentBranch(original.getRecord(id)!);
    const oldSession = calls[0].session;
    original.clearCompleted();
    expect(oldSession.dispose).toHaveBeenCalledOnce();
    const m = mode === "new manager" ? manager() : original;
    const restored = new SessionQueue();
    restored.accepted.push("first"); // persisted conversation returned by runner reconstruction
    vi.mocked(restoreAgentSession).mockResolvedValue(restored as any);
    const hydrated = m.getRecordOrArchive(id, parent)!;
    expect(hydrated).toMatchObject({ id, status: "completed", result: "answer: first" });
    expect(hydrated.session).toBeUndefined();
    expect(restoreAgentSession).not.toHaveBeenCalled();

    await expect(m.sendMessage(id, "from archive", { pi, ctx: parent })).resolves.toBe("resumed");
    await flush();
    expect(restoreAgentSession).toHaveBeenCalledOnce();
    expect(calls[1].session).toBe(restored);
    calls[1].finish();
    await m.waitForAll();
    expectAnswer(m.getRecord(id)!, ["first", "from archive"]);
    expect(m.getRecord(id)?.session).toBe(restored);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("does not reconstruct an archived session until its background slot is available", async () => {
    const m = manager();
    const id = await completed(m);
    const parent = parentBranch(m.getRecord(id)!);
    m.clearCompleted();
    spawn(m, "blocker");
    const restored = new SessionQueue();
    restored.accepted.push("first");
    vi.mocked(restoreAgentSession).mockResolvedValue(restored as any);
    await m.sendMessage(id, "restore queued", { pi, ctx: parent });
    expect(m.getRecord(id)?.status).toBe("queued");
    expect(restoreAgentSession).not.toHaveBeenCalled();
    calls[1].finish();
    await flush();
    expect(restoreAgentSession).toHaveBeenCalledOnce();
    calls[2].finish();
    await m.waitForAll();
    expectAnswer(m.getRecord(id)!, ["first", "restore queued"]);
  });

  it("concurrent archived messages share one reconstruction and one active prompt", async () => {
    const original = manager();
    const id = await completed(original);
    const parent = parentBranch(original.getRecord(id)!);
    const m = manager();
    const restore = deferred<any>();
    vi.mocked(restoreAgentSession).mockReturnValue(restore.promise);
    const messages = await Promise.all([
      m.sendMessage(id, "restore first", { pi, ctx: parent }),
      m.sendMessage(id, "restore second", { pi, ctx: parent }),
    ]);
    expect(messages).toEqual(["resumed", "queued"]);
    expect(restoreAgentSession).toHaveBeenCalledOnce();
    expect(resumeAgent).not.toHaveBeenCalled();
    const restored = new SessionQueue();
    restored.accepted.push("first");
    restore.resolve(restored);
    await flush();
    calls[1].finish();
    await flush();
    expect(calls[2].prompt).toBe("restore second");
    calls[2].finish();
    await m.waitForAll();
    expectAnswer(m.getRecord(id)!, ["first", "restore first", "restore second"]);
    expect(restored.maximumActive).toBe(1);
    expect(restoreAgentSession).toHaveBeenCalledOnce();
    expect(runAgent).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledTimes(2);
  });

  it("records reconstruction rejection without falling back to runAgent or silently retrying", async () => {
    const original = manager();
    const id = await completed(original);
    const parent = parentBranch(original.getRecord(id)!);
    const m = manager();
    vi.mocked(restoreAgentSession).mockRejectedValue(new Error("session file missing"));
    await m.sendMessage(id, "restore", { pi, ctx: parent });
    await m.waitForAll();
    expect(m.getRecord(id)).toMatchObject({ status: "error", error: "session file missing" });
    await expect(m.sendMessage(id, "again", { pi, ctx: parent })).rejects.toThrow(/Agent.*resume/i);
    expect(runAgent).toHaveBeenCalledOnce();
    expect(resumeAgent).not.toHaveBeenCalled();
    expect(restoreAgentSession).toHaveBeenCalledOnce();
    expect(onComplete).toHaveBeenCalledTimes(2);
  });
});
