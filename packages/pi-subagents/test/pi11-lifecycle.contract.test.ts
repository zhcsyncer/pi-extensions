import { mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { InMemoryCredentialStore, fauxAssistantMessage, fauxProvider, type Usage } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, SessionManager, AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { AgentManager } from "../src/agent-manager.js";
import { restoreAgentSession, resumeAgent, steerAgent } from "../src/agent-runner.js";
import { UsageReporter } from "../src/usage-reporting.js";
import { toLifetimeUsage } from "../src/usage.js";
import { archiveAgentRecord } from "../src/session-archive.js";
import type { AgentRecord, InlineAgentConfig } from "../src/types.js";

// Expectations come from the frozen R1 contract, not the implementation.
// All provider responses and extension fixtures are local; run via run-isolated.mjs.
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
  for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
const tick = () => new Promise<void>((done) => setImmediate(done));
function usage(cost: number): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
    cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost } };
}
async function fixture(extensionSource?: string) {
  const cwd = mkdtempSync(join(tmpdir(), "pi11-r1-contract-"));
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  const sessionDir = join(cwd, "sessions");
  mkdirSync(sessionDir);
  const faux = fauxProvider({ provider: "r1-offline", models: [{ id: "contract", contextWindow: 128_000, maxTokens: 4096 }] });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: join(cwd, "models"), allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey(faux.getModel().provider, "local-test-only");
  await runtime.refresh({ allowNetwork: false });
  expect(new ModelRegistry(runtime).getAvailable().some(model => model.provider === "r1-offline" && model.id === "contract"),
    "offline provider must be available before exercising product behavior").toBe(true);
  const parent = SessionManager.inMemory(cwd);
  // Deliberately minimal public extension boundary prescribed by the frozen fixture.
  const ctx = { cwd, model: faux.getModel(), modelRegistry: new ModelRegistry(runtime),
    sessionManager: parent, getSystemPrompt: () => "R1" } as unknown as ExtensionContext;
  const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
  let extensions: false | string[] = false;
  if (extensionSource) {
    const path = join(cwd, "contract-extension.ts");
    writeFileSync(path, extensionSource);
    extensions = [path];
  }
  const role: InlineAgentConfig = { name: "r1", description: "contract", builtinToolNames: [],
    extensions, skills: false, promptMode: "replace", systemPrompt: "R1", persistSession: true, sessionDir };
  const managers: AgentManager[] = [];
  cleanup.push(async () => {
    for (const manager of managers) {
      await manager.waitForAll();
    }
  });
  function manager(onStart?: ConstructorParameters<typeof AgentManager>[2]) {
    const value = new AgentManager(undefined, 1, onStart);
    managers.push(value);
    return value;
  }
  function spawn(value: AgentManager, prompt = "first") {
    const id = value.spawn(pi, ctx, "r1", prompt, { description: "R1 contract", model: faux.getModel(),
      thinkingLevel: "off", isBackground: true, inlineAgentConfig: role });
    return id;
  }
  return { cwd, sessionDir, faux, parent, ctx, pi, manager, spawn };
}
async function running(manager: AgentManager, id: string) {
  await expect.poll(() => {
    const record = manager.getRecord(id);
    if (record?.error) throw new Error(`Runner setup failed before contract exercise: ${record.error}`);
    return record?.session;
  }, { timeout: 5000 }).toBeDefined();
  return manager.getRecord(id)!.session!;
}
function reportRecord(cost: number): AgentRecord {
  return { id: "child", type: "r1", description: "contract", status: "completed", toolUses: 0,
    startedAt: 0, completionDelivery: "followUp", compactionCount: 0, lifetimeUsage: toLifetimeUsage({ cost }) };
}
function persistClaim(parent: SessionManager, claim: NonNullable<ReturnType<UsageReporter["claim"]>>) {
  return parent.appendMessage({ role: "toolResult", toolCallId: "parent-call", toolName: "Agent",
    content: [{ type: "text", text: "child finished" }], isError: false, timestamp: 1,
    usage: claim.usage, details: JSON.parse(JSON.stringify({ subagentUsageRollup: claim.subagentUsageRollup })) });
}

describe("R1 public lifecycle contract (Pi 1.1)", () => {
  it("reports handled input without ever putting it into a subsequent provider request", async () => {
    const f = await fixture(`export default (pi) => { pi.on("input", event => event.text === "consume-me" ? {action:"handled"} : undefined); };`);
    const entered = gate(), release = gate();
    const seen: string[] = [];
    f.faux.setResponses([async (context) => {
      seen.push(JSON.stringify(context.messages)); entered.resolve(); await release.promise;
      return fauxAssistantMessage("first done");
    }, (context) => { seen.push(JSON.stringify(context.messages)); return fauxAssistantMessage("second done"); }]);
    const manager = f.manager(), id = f.spawn(manager);
    try {
      const session = await running(manager, id);
      await entered.promise;
      expect.soft(await manager.sendMessage(id, "consume-me")).toBe("handled");
      expect.soft(await steerAgent(session, "consume-me")).toBe("handled");
    } finally { release.resolve(); }
    await manager.waitForResult(id);
    await manager.sendMessage(id, "next", { pi: f.pi, ctx: f.ctx });
    await manager.waitForAll();
    expect(seen.length).toBeGreaterThanOrEqual(2);
    expect(seen.join("\n")).not.toContain("consume-me");
  });

  it("distinguishes SDK queued input and rejects extension commands without replaying them", async () => {
    const f = await fixture(`export default (pi) => { pi.registerCommand("local-only", {description:"fixture", handler:async()=>{}}); };`);
    const entered = gate(), release = gate();
    f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("done"); }, fauxAssistantMessage("steer done")]);
    const manager = f.manager(), id = f.spawn(manager);
    try {
      await running(manager, id); await entered.promise;
      await expect(manager.sendMessage(id, "/local-only")).rejects.toThrow();
      expect(await manager.sendMessage(id, "accepted-once")).toBe("steered");
    } finally { release.resolve(); }
    const record = await manager.waitForResult(id);
    const users = record!.session!.sessionManager.getEntries().filter(e => e.type === "message" && e.message.role === "user");
    expect(users.filter(e => JSON.stringify(e).includes("accepted-once"))).toHaveLength(1);
    expect(users.some(e => JSON.stringify(e).includes("local-only"))).toBe(false);
  });

  it("external cancellation keeps its reservation until the provider actually settles", async () => {
    const f = await fixture();
    const entered = gate(), aborted = gate(), release = gate();
    f.faux.setResponses([async (_context, options) => {
      options?.signal?.addEventListener("abort", aborted.resolve, { once: true });
      entered.resolve(); await release.promise; return fauxAssistantMessage("late");
    }, fauxAssistantMessage("successor")]);
    const starts: string[] = [];
    const manager = f.manager(record => { starts.push(record.id); });
    const id = f.spawn(manager);
    let stop: Promise<boolean> | undefined;
    try {
      await running(manager, id); await entered.promise;
      const successor = f.spawn(manager, "successor");
      let resolved = false;
      stop = manager.abortAndWait(id).then(value => { resolved = true; return value; });
      await aborted.promise; await tick();
      expect(resolved).toBe(false);
      expect(manager.isResultReady(id)).toBe(false);
      expect(starts).not.toContain(successor);
    } finally { release.resolve(); await stop; }
    await manager.waitForAll();
    expect(manager.getRecord(id)?.status).toBe("stopped");
  });

  it("internal settled notification cannot release a still-unsettled prompt reservation", async () => {
    const f = await fixture();
    const entered = gate(), releaseProvider = gate(), tail = gate(), settled = gate();
    const original = AgentSession.prototype.prompt;
    const spy = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(async function (this: AgentSession, ...args) {
      await original.apply(this, args);
      if (args[0] === "first") await tail.promise;
    });
    f.faux.setResponses([async () => { entered.resolve(); await releaseProvider.promise;
      return fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "internal fixture abort" });
    }, fauxAssistantMessage("successor")]);
    const starts: string[] = [];
    const manager = f.manager(record => { starts.push(record.id); });
    const id = f.spawn(manager);
    try {
      const session = await running(manager, id); await entered.promise;
      session.subscribe(event => { if (event.type === "agent_settled") settled.resolve(); });
      const successor = f.spawn(manager, "successor");
      releaseProvider.resolve(); await settled.promise; await tick();
      expect(manager.isResultReady(id)).toBe(false);
      expect(starts).not.toContain(successor);
      tail.resolve();
      await manager.waitForResult(id);
      expect(manager.getRecord(id)?.status).toBe("aborted");
    } finally { releaseProvider.resolve(); tail.resolve(); spy.mockRestore(); }
    await manager.waitForAll();
  });

  it("a resumed generation cannot be overwritten by the prior internal-abort terminal state", async () => {
    const f = await fixture();
    const entered = gate(), release = gate();
    f.faux.setResponses([fauxAssistantMessage("", { stopReason: "aborted", errorMessage: "first generation aborted" }),
      async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("fresh generation"); }]);
    const manager = f.manager(), id = f.spawn(manager);
    await manager.waitForResult(id);
    const previous = manager.getRecord(id)!.runGeneration;
    const delivery = manager.resume(id, "new generation", undefined, { pi: f.pi, ctx: f.ctx, isBackground: true });
    try {
      await Promise.race([entered.promise, delivery.then(() => entered.promise)]);
      expect(manager.getRecord(id)!.runGeneration).toBeGreaterThan(previous!);
      expect(manager.isResultReady(id)).toBe(false);
      await tick();
      expect(manager.getRecord(id)?.status).toBe("running");
    } finally { release.resolve(); await delivery; }
    const final = await manager.waitForResult(id);
    expect(final?.status).toBe("completed");
    expect(final?.result).toContain("fresh generation");
  });

  it("late real old-generation notifications cannot terminate or double-charge a new run", async () => {
    const f = await fixture(`export default pi => { pi.on("message_end", event => event.message.role === "assistant" ?
      {message:{...event.message,usage:event.message.stopReason === "aborted" ? ${JSON.stringify(usage(0.01))} : ${JSON.stringify(usage(0.02))}}} : undefined); };`);
    const entered = gate(), release = gate();
    const held: Array<() => void> = [];
    let delayOld = true;
    const original = AgentSession.prototype.subscribe;
    // Delay actual SDK notifications at its public subscription boundary. No
    // fabricated settlement or usage event, and no private runner callback.
    const spy = vi.spyOn(AgentSession.prototype,"subscribe").mockImplementation(function (this: AgentSession, listener) {
      return original.call(this,event => {
        if (delayOld && (event.type === "agent_settled" || (event.type === "message_end" && event.message.role === "assistant"))) {
          held.push(()=>listener(event));
        } else listener(event);
      });
    });
    f.faux.setResponses([fauxAssistantMessage("old",{stopReason:"aborted",errorMessage:"old generation"}),
      async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("new"); }]);
    const manager = f.manager(), id = f.spawn(manager);
    let delivery: Promise<unknown> | undefined;
    try {
      await manager.waitForResult(id);
      expect(held.length,"the timing fixture must capture real completed notifications").toBeGreaterThan(0);
      delayOld = false;
      delivery = manager.sendMessage(id,"new",{pi:f.pi,ctx:f.ctx});
      await entered.promise;
      for (const deliver of held.splice(0)) deliver();
      await tick();
      expect(manager.getRecord(id)?.status).toBe("running");
      expect(manager.isResultReady(id)).toBe(false);
      release.resolve(); await delivery;
      const record = await manager.waitForResult(id);
      expect(record?.status).toBe("completed");
      expect(record?.lifetimeUsage.cost).toBeCloseTo(0.03,12);
      expect(manager.getRecord(id)?.lifetimeUsage.cost).toBeCloseTo(0.03,12);
    } finally { delayOld=false; release.resolve(); spy.mockRestore(); await delivery; }
  });

  it("counts stable assistant/outer/unknown usage entries once across live collection and archive restore", async () => {
    const f = await fixture(`export default (pi) => {
      pi.registerTool({name:"inner",label:"Inner",description:"offline nested cost",parameters:{type:"object",properties:{}},
        execute:async()=>({content:[{type:"text",text:"nested"}],details:{},usage:${JSON.stringify(usage(0.02))}})});
      pi.registerTool({name:"outer",label:"Outer",description:"offline aggregate",parameters:{type:"object",properties:{}},
        execute:async(_id,_args,_signal,_update,ctx)=>{await ctx.executeTool("inner",{});return {content:[{type:"text",text:"outer"}],details:{},usage:${JSON.stringify(usage(0.01))}};}});
      pi.on("message_end", event => event.message.role === "assistant" ? {message:{...event.message,
        usage:event.message.content.some(b=>b.type==="toolCall") ? ${JSON.stringify(usage(0.01))} : ${JSON.stringify(usage(0))}}} : undefined);
    };`);
    const entered = gate(), release = gate();
    f.faux.setResponses([fauxAssistantMessage([{type:"toolCall",id:"outer-call",name:"outer",arguments:{}}], {stopReason:"toolUse"}),
      async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("done"); }, fauxAssistantMessage("restored"), fauxAssistantMessage("new cost")]);
    const manager = f.manager(), id = f.spawn(manager);
    let session!: AgentSession;
    try {
      session = await running(manager, id); await entered.promise;
      session.sessionManager.appendUsage("future-unknown-kind", "r1-offline", "contract", usage(0.02));
    } finally { release.resolve(); }
    const record = (await manager.waitForResult(id))!;
    const source = session.sessionManager.getEntries();
    const assistant = source.filter(e => e.type === "message" && e.message.role === "assistant");
    const outer = source.find(e => e.type === "message" && e.message.role === "toolResult" && e.message.toolName === "outer");
    // Fixture checks establish actual SDK persisted evidence, not a synthetic event sum.
    expect(assistant.some(e => e.type === "message" && e.message.role === "assistant" && e.message.usage.cost.total === 0.01)).toBe(true);
    expect(outer?.type === "message" && outer.message.role === "toolResult" && outer.message.usage?.cost.total).toBeCloseTo(0.03, 12);
    expect(source.filter(e => e.type === "message" && e.message.role === "toolResult")).toHaveLength(1);
    expect.soft(record.lifetimeUsage.cost).toBeCloseTo(0.06, 12);
    expect.soft(manager.getRecord(id)?.lifetimeUsage.cost).toBeCloseTo(0.06, 12);
    f.parent.appendCustomEntry("subagents:record", archiveAgentRecord(record));
    const restoredManager = f.manager();
    await restoredManager.resume(id, "restore", undefined, {pi:f.pi,ctx:f.ctx,isBackground:true});
    await restoredManager.waitForResult(id);
    const restored = restoredManager.getRecord(id)!;
    expect.soft(restored.lifetimeUsage.cost).toBeCloseTo(0.06, 12);
    expect(restored.session!.sessionManager.getSessionId()).toBe(session.sessionManager.getSessionId());
    expect(restored.session!.sessionManager.getEntries().filter(e => source.some(old => old.id === e.id))).toHaveLength(source.length);
    restored.session!.sessionManager.appendCompaction("summary of old records", null, 100, { cumulativeCost:0.06 }, true);
    restored.session!.sessionManager.branchWithSummary(restored.session!.sessionManager.getLeafId(), "newly generated branch summary", undefined, true, usage(0.02));
    await restoredManager.sendMessage(id, "collect new record", {pi:f.pi,ctx:f.ctx});
    await restoredManager.waitForResult(id);
    expect(restoredManager.getRecord(id)?.lifetimeUsage.cost).toBeCloseTo(0.08, 12);
  });

  it.each(["normal", "retain-none"] as const)("restores %s history with the original session identity", async kind => {
    const f = await fixture(); f.faux.setResponses([fauxAssistantMessage("original"), fauxAssistantMessage("restored")]);
    const manager = f.manager(), id = f.spawn(manager);
    const record = await manager.waitForResult(id);
    expect(record?.error, "runner must reach the restore fixture").toBeUndefined();
    expect(record?.resumeSnapshot).toBeDefined();
    const original = record!.session!;
    if (kind === "retain-none") original.sessionManager.appendCompaction("retained summary", null, 100);
    const restored = await restoreAgentSession(f.ctx, record!.sessionFile!, record!.resumeSnapshot!, { pi: f.pi });
    cleanup.push(() => restored.dispose());
    expect(restored.sessionManager.getSessionId()).toBe(original.sessionManager.getSessionId());
    const result = await resumeAgent(restored, "continue");
    expect(result.failure).toBeUndefined();
    expect(result.text).toContain("restored");
  });

  it.each(["json", "missing-reference", "forward-reference", "cwd", "duplicate-id"] as const)("fails closed on %s without creating a replacement session", async fault => {
    const f = await fixture(); f.faux.setResponses([fauxAssistantMessage("original")]);
    const manager = f.manager(), id = f.spawn(manager);
    const record = await manager.waitForResult(id);
    expect(record?.error, "runner must reach the corruption fixture").toBeUndefined();
    expect(record?.resumeSnapshot).toBeDefined();
    const copyDir = join(f.cwd, "corrupt"); mkdirSync(copyDir);
    const file = join(copyDir, "copy.jsonl");
    const entries = readFileSync(record!.sessionFile!, "utf8").trim().split("\n").map(line => JSON.parse(line));
    if (fault === "cwd") entries[0].cwd = join(f.cwd, "different-workspace");
    if (fault === "missing-reference") entries.at(-1).parentId = "missing-entry";
    if (fault === "forward-reference") entries[1].parentId = entries.at(-1).id;
    if (fault === "duplicate-id") entries.at(-1).id = entries[1].id;
    const raw = entries.map(e => JSON.stringify(e)).join("\n") + (fault === "json" ? "\n{broken-json\n" : "\n");
    writeFileSync(file, raw);
    const before = readdirSync(copyDir);
    await expect(restoreAgentSession(f.ctx, file, record!.resumeSnapshot!, { pi: f.pi })).rejects.toThrow();
    expect(readdirSync(copyDir)).toEqual(before);
    expect(readFileSync(file, "utf8")).toBe(raw);
  });
});

describe("R1 parent branch watermarks", () => {
  it("reports 0.06 independently on A/B, then only 0.02 on return to A at lifetime 0.08", () => {
    const parent = SessionManager.inMemory();
    const fork = parent.appendMessage({ role: "user", content: "before reports", timestamp: 1 });
    const reporter = new UsageReporter();
    const record = reportRecord(0.06);
    const a = reporter.claim(record, parent)!;
    expect(a.usage.cost.total).toBeCloseTo(0.06, 12);
    const aLeaf = persistClaim(parent, a);
    expect(reporter.claim(record, parent)).toBeUndefined();
    parent.branch(fork);
    const b = reporter.claim(record, parent)!;
    expect(b?.usage.cost.total).toBeCloseTo(0.06, 12);
    persistClaim(parent, b);
    record.lifetimeUsage = toLifetimeUsage({ cost: 0.08 });
    parent.branch(aLeaf);
    const delta = reporter.claim(record, parent)!;
    expect(delta?.usage.cost.total).toBeCloseTo(0.02, 12);
    persistClaim(parent, delta);
    expect(new UsageReporter().claim(record, parent)).toBeUndefined();
    expect(record.lifetimeUsage.cost).toBeCloseTo(0.08, 12);
  });

  it("does not move confirmed watermarks backwards when an older archive reappears", () => {
    const parent = SessionManager.inMemory();
    parent.appendMessage({ role: "user", content: "parent", timestamp: 1 });
    const reporter = new UsageReporter();
    persistClaim(parent, reporter.claim(reportRecord(0.08), parent)!);
    expect(reporter.claim(reportRecord(0.06), parent)).toBeUndefined();
    expect(new UsageReporter().claim(reportRecord(0.08), parent)).toBeUndefined();
    expect(reporter.claim(reportRecord(0.10), parent)?.usage.cost.total).toBeCloseTo(0.02, 12);
  });
});
