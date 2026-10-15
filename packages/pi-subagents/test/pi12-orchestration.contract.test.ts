import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider, fauxToolCall,
  InMemoryCredentialStore, InMemoryModelsStore, type JsonObject, type ToolResultMessage, type Usage } from "@earendil-works/pi-ai";
import { AgentSession, createAgentSession, createCodemodeExtension, DefaultResourceLoader, initTheme,
  ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";

import subagents from "../src/index.js";

// Independent oracle: approved Pi 1.2 R2 public contract, not product bodies or implementer tests.
// Native codemode is essential here: its persisted outer result owns nested usage.
const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
function put(path: string, content: string) { mkdirSync(join(path, ".."), { recursive: true }); writeFileSync(path, content); }
function gate() { let resolve!: () => void; const promise = new Promise<void>(done => { resolve = done; }); return { promise, resolve }; }
const tick = () => new Promise<void>(done => setImmediate(done));
const text = (result: { content: unknown }) => Array.isArray(result.content)
  ? result.content.filter(b => b.type === "text").map(b => b.text).join("\n") : String(result.content);
const call = (name: string, id: string, args: JsonObject) => fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
const results = (session: AgentSession) => session.messages.filter((m): m is ToolResultMessage => m.role === "toolResult");
const cost = (value: number): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: value, output: 0, cacheRead: 0, cacheWrite: 0, total: value } });

async function fixture(onBlockedCodemodeResult?: () => void) {
  const cwd = mkdtempSync(join(tmpdir(), "pi12-orchestration-")), agentDir = join(cwd, "agent");
  cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
  mkdirSync(agentDir);
  const prior = process.env.PI_CODING_AGENT_DIR; process.env.PI_CODING_AGENT_DIR = agentDir;
  cleanup.push(() => { if (prior === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = prior; });
  put(join(cwd, ".pi/extensions/effects.ts"), `import {appendFileSync} from 'node:fs'; import {join} from 'node:path';
export default pi => { for (const name of ['old_tool','new_tool','charged_tool']) pi.registerTool({name,label:name,description:'contract effect',
 parameters:{type:'object',properties:{}},execute:async(_id,_args,_signal,_update,ctx)=>{
 appendFileSync(join(ctx.cwd,'effects.jsonl'),JSON.stringify({name})+'\\n');
 return {content:[{type:'text',text:'EXECUTED '+name}],details:{},...(name==='charged_tool'?{usage:${JSON.stringify(cost(0.02))}}:{})};}}); };`);
  function role(tools = "ext:effects/old_tool", isolated?: boolean) {
    put(join(cwd, ".pi/agents/worker.md"), `---\ndescription: Current named worker\ntools: "${tools}"\nextensions: [effects]\n${isolated === undefined ? "" : `isolated: ${isolated}\n`}skills: false\npersist_session: true\nsession_dir: ${JSON.stringify(join(cwd, "children"))}\nprompt_mode: replace\n---\nORIGINAL TASK INTENT\n`);
  }
  role(); put(join(cwd, "read.txt"), "NEW BUILTIN AUTHORITY");
  const faux = fauxProvider({ provider: "r2-native-offline", models: [{ id: "contract", contextWindow: 128000, maxTokens: 4096 }] });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(),
    modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
  runtime.registerNativeProvider(faux.provider); await runtime.setRuntimeApiKey("r2-native-offline", "fixture-only");
  await runtime.refresh({ allowNetwork: false });
  const children = new Set<AgentSession>();
  // Observe real public sessions without replacing their prompt/event behavior.
  const original = AgentSession.prototype.prompt;
  const observer = vi.spyOn(AgentSession.prototype, "prompt").mockImplementation(function (this: AgentSession, ...args) {
    if (this.sessionManager.getSessionDir() === join(cwd, "children")) children.add(this);
    return original.apply(this, args);
  });
  cleanup.push(() => observer.mockRestore());
  const parents: AgentSession[] = [];
  const closedParents = new Set<AgentSession>();
  async function closeParent(session: AgentSession) {
    if (closedParents.has(session)) return;
    closedParents.add(session);
    try {
      await session.abort();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally { session.dispose(); }
  }
  cleanup.push(async () => {
    for (const session of parents) await closeParent(session);
    for (const session of children) { await session.abort(); session.dispose(); }
  });
  async function parent(file?: string) {
    const settingsManager = SettingsManager.inMemory({ packages: [], defaultTools: ["+codemode"], compaction: { enabled: false }, retry: { enabled: false } });
    const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager,
      extensionFactories: [api => {
        // Observe VM completion before Subagents can hold the root result for
        // unfinished host calls. This hook neither changes nor delays results.
        api.on("tool_result", event => {
          if (event.toolName === "codemode" && event.toolCallId === "blocked") onBlockedCodemodeResult?.();
        });
      }, subagents, createCodemodeExtension({ mode: "on", models: false })], noSkills: true, noThemes: true,
      noPromptTemplates: true, noContextFiles: true });
    await loader.reload(); expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({ cwd, agentDir, settingsManager, resourceLoader: loader, modelRuntime: runtime,
      model: faux.getModel(), thinkingLevel: "off", sessionManager: file ? SessionManager.open(file) : SessionManager.create(cwd, join(cwd, "parents")) });
    initTheme("dark", false); const errors: unknown[] = [];
    await session.bindExtensions({ onError: error => { errors.push(error); } }); expect(errors).toEqual([]);
    expect(session.getActiveToolNames()).toContain("codemode"); parents.push(session); return session;
  }
  function prepare(session: AgentSession, name: string, args: JsonObject, id: string) {
    let first = true;
    session.agent.streamFunction = model => {
      const message = first ? call(name, id, args) : fauxAssistantMessage("parent settled"); first = false;
      message.provider = model.provider; message.model = model.id; message.api = model.api;
      const stream = createAssistantMessageEventStream();
      stream.push({ type: "done", reason: message.stopReason as "stop" | "toolUse", message }); stream.end(message); return stream;
    };
  }
  async function invoke(session: AgentSession, name: string, args: JsonObject, id: string) {
    prepare(session, name, args, id); await session.prompt("execute independent public contract");
    const result = results(session).find(r => r.toolCallId === id); expect(result).toBeDefined(); return result!;
  }
  const script = (session: AgentSession, code: string, id: string) => invoke(session, "codemode", { code }, id);
  const input = (prompt: string, background = false) => ({ subagent_type: "worker", description: "independent contract", prompt, run_in_background: background });
  function archives(session: AgentSession) {
    return session.sessionManager.getEntries().filter(e => e.type === "custom" && e.customType === "subagents:record")
      .map(e => (e as { data: { id: string; status: string; sessionFile?: string } }).data);
  }
  const effects = () => { try { return readFileSync(join(cwd, "effects.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)); } catch { return []; } };
  return { cwd, faux, role, parent, closeParent, children, prepare, invoke, script, input, archives, effects };
}

describe("Pi 1.2 native codemode orchestration", () => {
  it("batches background Agent calls, persists IDs and follows up the same children after parent reload", async () => {
    const f = await fixture(), parent = await f.parent();
    const nativeControl = await f.script(parent, "text(await tools.read({path:'read.txt'}));", "native-control");
    expect(nativeControl.isError).toBe(false); expect(text(nativeControl)).toContain("NEW BUILTIN AUTHORITY");
    f.faux.setResponses([fauxAssistantMessage("FIRST CHILD"), fauxAssistantMessage("SECOND CHILD")]);
    const launch = await f.script(parent, `const launched=await Promise.all([tools.Agent(${JSON.stringify(f.input("first", true))}),tools.Agent(${JSON.stringify(f.input("second", true))})]); store('launches',launched); text(launched);`, "batch");
    expect(launch.isError, text(launch)).toBe(false);
    await expect.poll(() => new Set(f.archives(parent).map(r => r.id)).size).toBe(2);
    const ids = [...new Set(f.archives(parent).map(r => r.id))];
    for (const id of ids) expect(text(launch)).toContain(id);
    const collected = await f.script(parent, `text(await Promise.all(${JSON.stringify(ids)}.map(agent_id=>tools.get_subagent_result({agent_id,wait:true}))));`, "collect");
    expect(collected.isError).toBe(false); expect(text(collected)).toContain("FIRST CHILD"); expect(text(collected)).toContain("SECOND CHILD");
    const path = parent.sessionFile!; await f.closeParent(parent); const reopened = await f.parent(path);
    const stored = await f.script(reopened, "text(load('launches'));", "stored-ids");
    for (const id of ids) expect(text(stored)).toContain(id);
    f.faux.setResponses([fauxAssistantMessage("FOLLOWUP SAME CHILD")]);
    const follow = await f.script(reopened, `text(await tools.steer_subagent({agent_id:${JSON.stringify(ids[0])},message:'followup'})); text(await tools.get_subagent_result({agent_id:${JSON.stringify(ids[0])},wait:true}));`, "follow");
    expect(follow.isError).toBe(false); expect(text(follow)).toContain("FOLLOWUP SAME CHILD");
    expect(new Set(f.archives(reopened).map(r => r.id))).toEqual(new Set(ids));
  });

  it.each(["direct", "native"] as const)("%s foreground cancellation waits for the controlled child to settle", async path => {
    const entered = gate(), aborted = gate(), release = gate(), vmEnded = gate();
    const phases: string[] = [];
    const f = await fixture(() => { phases.push("root-codemode-tool_result"); vmEnded.resolve(); });
    const parent = await f.parent();
    const unsubscribe = parent.subscribe(event => {
      if (event.type === "tool_execution_end") phases.push(`tool_execution_end:${event.toolName}:${event.toolCallId}`);
    });
    f.faux.setResponses([async (_context, options) => {
      options?.signal?.addEventListener("abort", () => { phases.push("child-abort"); aborted.resolve(); }, { once: true });
      phases.push("child-entered"); entered.resolve(); await release.promise;
      phases.push("child-provider-settled");
      return fauxAssistantMessage("late output must not be called successful");
    }]);
    const input = f.input("blocked foreground");
    f.prepare(parent, path === "direct" ? "Agent" : "codemode", path === "direct" ? input : { code: `text(await tools.Agent(${JSON.stringify(input)}));` }, "blocked");
    const pending = parent.prompt("run blocked child"); let stop: Promise<void> | undefined;
    try {
      await Promise.race([entered.promise, pending.then(() => {
        const result = results(parent).find(r => r.toolCallId === "blocked");
        expect(result?.isError, result ? text(result) : "call ended without child entry").toBe(false);
      })]);
      expect(f.children.size).toBe(1);
      let stopped = false;
      stop = parent.abort().then(() => { phases.push("parent-abort-resolved"); stopped = true; });
      await expect.poll(() => [...f.children][0].agent.state.isStreaming).toBe(true);
      if (path === "native") await Promise.all([vmEnded.promise, aborted.promise]);
      else await Promise.race([aborted.promise, stop]);
      await tick();
      expect(stopped, `do not settle the outer foreground call while the child provider is blocked; phases=${JSON.stringify(phases)}`).toBe(false);
      expect(f.archives(parent).some(r => r.status === "completed")).toBe(false);
    } finally {
      phases.push("child-release"); release.resolve(); await stop; await pending;
      unsubscribe(); console.log("PUBLIC_CANCELLATION_PHASES", JSON.stringify({ path, phases }));
    }
    expect([...f.children].every(s => !s.agent.state.isStreaming)).toBe(true);
    expect(new Set(f.archives(parent).map(r => r.id)).size, "cancelled child must remain tracked").toBe(1);
    expect(f.archives(parent).at(-1)!.status).toMatch(/stopped|aborted/);
  });

  it.each(["direct", "native"] as const)("%s cancelled result wait preserves the acknowledged managed background task", async path => {
    const f = await fixture(), parent = await f.parent(), entered = gate(), release = gate();
    let childAborted = false;
    f.faux.setResponses([async (_context, options) => {
      options?.signal?.addEventListener("abort", () => { childAborted = true; }, { once: true });
      entered.resolve(); await release.promise; return fauxAssistantMessage("BACKGROUND SETTLED");
    }]);
    let waiting: Promise<void> | undefined;
    try {
      const launch = await f.invoke(parent, "Agent", f.input("managed waiter control", true), "wait-launch");
      expect(launch.isError).toBe(false); await entered.promise;
      // The public launch result includes the stable ID before the terminal archive exists.
      const id = (launch.details as { agentId: string }).agentId;
      expect(id).toBeTypeOf("string"); expect(text(launch)).toContain(id);
      let reached = false;
      const off = parent.subscribe(event => { if (event.type === "tool_execution_start" && event.toolName === "get_subagent_result") reached = true; });
      f.prepare(parent, path === "native" ? "codemode" : "get_subagent_result", path === "native"
        ? { code: `text(await tools.get_subagent_result({agent_id:${JSON.stringify(id)},wait:true}));` }
        : { agent_id: id, wait: true }, "cancel-wait");
      waiting = parent.prompt("wait until cancelled");
      try {
        await expect.poll(() => reached || results(parent).some(r => r.toolCallId === "cancel-wait")).toBe(true);
        const early = results(parent).find(r => r.toolCallId === "cancel-wait");
        expect(early, early ? text(early) : "wait must remain pending").toBeUndefined();
        await parent.abort(); await waiting;
        expect(childAborted).toBe(false); expect([...f.children][0].agent.state.isStreaming).toBe(true);
      } finally { off(); }
      release.resolve();
      const result = await f.invoke(parent, "get_subagent_result", { agent_id: id, wait: true }, "after-cancel");
      expect(result.isError).toBe(false); expect(text(result)).toContain("BACKGROUND SETTLED");
      expect(f.archives(parent).some(r => r.id === id && r.status === "completed")).toBe(true);
    } finally { release.resolve(); await waiting; }
  });

  it("child execution still excludes recursive Agent/get/steer", async () => {
    const f = await fixture(), parent = await f.parent();
    f.faux.setResponses([call("old_tool", "positive", {}), call("Agent", "recursive-agent", f.input("forbidden grandchild")),
      call("get_subagent_result", "recursive-get", { agent_id: "not-authorized", wait: true }),
      call("steer_subagent", "recursive-steer", { agent_id: "not-authorized", message: "forbidden" }), fauxAssistantMessage("EXCLUSIONS CHECKED")]);
    const result = await f.invoke(parent, "Agent", f.input("check child exclusions"), "exclusions");
    expect(result.isError).toBe(false); expect(f.children.size).toBe(1);
    const child = [...f.children][0];
    expect(results(child).find(r => r.toolCallId === "positive")?.isError).toBe(false);
    for (const id of ["recursive-agent", "recursive-get", "recursive-steer"]) expect(results(child).find(r => r.toolCallId === id)?.isError).toBe(true);
    expect(new Set(f.archives(parent).map(r => r.id)).size).toBe(1); expect(f.effects()).toEqual([{ name: "old_tool" }]);
  });

  it("script failure does not orphan or roll back an acknowledged background task", async () => {
    const f = await fixture(), parent = await f.parent(), entered = gate(), release = gate();
    f.faux.setResponses([async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("MANAGED AFTER SCRIPT FAILURE"); }]);
    try {
      const result = await f.script(parent, `text(await tools.Agent(${JSON.stringify(f.input("background survives", true))})); throw new Error('intentional script failure');`, "failed-script");
      expect(result.isError).toBe(true); expect(text(result)).toContain("intentional script failure");
      await expect.poll(() => f.children.size).toBe(1); await entered.promise;
      release.resolve();
      await expect.poll(() => f.archives(parent).length).toBeGreaterThan(0);
      const id = f.archives(parent).at(-1)!.id; expect(text(result)).toContain(id);
      const get = await f.invoke(parent, "get_subagent_result", { agent_id: id, wait: true }, "managed-result");
      expect(get.isError).toBe(false); expect(text(get)).toContain("MANAGED AFTER SCRIPT FAILURE");
    } finally { release.resolve(); }
  });

  it.each(["live", "cold"] as const)("%s same-version named resume grants newly registered tools and revokes old authority", async mode => {
    const f = await fixture(); let parent = await f.parent();
    f.faux.setResponses([call("old_tool", "old-positive", {}), fauxAssistantMessage("original done")]);
    const first = await f.invoke(parent, "Agent", f.input("initial role"), "initial");
    expect(first.isError).toBe(false); expect(f.effects()).toEqual([{ name: "old_tool" }]);
    const id = f.archives(parent).at(-1)!.id, original = [...f.children][0], identity = original.sessionId;
    expect(original.getToolDefinition("new_tool"), "new authority changes no resource loading").toBeDefined();
    expect(original.getAllTools().find(t => t.name === "read")?.sourceInfo?.path).toBe("builtin:read");
    f.role("read, ext:effects/new_tool");
    if (mode === "cold") { const file = parent.sessionFile!; await f.closeParent(parent); original.dispose(); parent = await f.parent(file); }
    f.faux.setResponses([call("new_tool", "new-positive", {}), call("read", "new-builtin", { path: "read.txt" }),
      call("old_tool", "revoked", {}), fauxAssistantMessage("current authority done")]);
    const resumed = await f.invoke(parent, "Agent", { ...f.input("continue current role"), resume: id }, "resume");
    expect(resumed.isError).toBe(false);
    const child = [...f.children].at(-1)!; expect(child.sessionId).toBe(identity);
    if (mode === "cold") expect(child).not.toBe(original);
    expect(child.systemPrompt).toContain("ORIGINAL TASK INTENT");
    expect.soft(results(child).find(r => r.toolCallId === "new-positive")?.isError, "new extension grant must execute").toBe(false);
    const builtin = results(child).find(r => r.toolCallId === "new-builtin")!;
    expect.soft(builtin.isError, "new builtin grant must execute").toBe(false); expect.soft(text(builtin)).toContain("NEW BUILTIN AUTHORITY");
    expect(results(child).find(r => r.toolCallId === "revoked")?.isError).toBe(true);
    expect.soft(f.effects()).toEqual([{ name: "old_tool" }, { name: "new_tool" }]);
    for (const name of ["Agent", "get_subagent_result", "steer_subagent"]) expect(child.getCallableToolNames()).not.toContain(name);
  });

  it.each(["role-default", "explicit-task"] as const)("cold resume distinguishes %s isolation from current named authority", async isolation => {
    const f = await fixture(); f.role("ext:effects/old_tool", true);
    let parent = await f.parent();
    f.faux.setResponses([call("old_tool", "initial-isolation", {}), fauxAssistantMessage("ISOLATED ORIGINAL")]);
    const initialInput = { ...f.input("preserve original task"), ...(isolation === "explicit-task" ? { isolated: true } : {}) };
    const first = await f.invoke(parent, "Agent", initialInput, "isolated-start");
    expect(first.isError).toBe(false);
    expect(f.children.size).toBe(1);
    const original = [...f.children][0];
    expect(results(original).find(r => r.toolCallId === "initial-isolation")?.isError).toBe(true);
    expect(original.getToolDefinition("old_tool")).toBeUndefined();
    expect(f.effects()).toEqual([]);
    const id = f.archives(parent).at(-1)!.id;
    const identity = original.sessionId, cwd = original.sessionManager.getCwd(), prompt = original.systemPrompt;
    const model = { provider: original.model!.provider, id: original.model!.id };
    const file = parent.sessionFile!;
    await f.closeParent(parent); original.dispose();
    // Cold reconstruction may load a newly permitted extension. This does not
    // require hot resource loading or change the first-call isolation priority.
    f.role("ext:effects/old_tool", false);
    parent = await f.parent(file);
    f.faux.setResponses([call("old_tool", "after-isolation-change", {}), fauxAssistantMessage("CURRENT ROLE CHECKED")]);
    // Deliberately omit isolated here: an explicit task constraint must survive
    // persistence, while the old role default must not become such a constraint.
    const resumed = await f.invoke(parent, "Agent", { ...f.input("continue saved task"), resume: id }, "isolated-resume");
    expect(resumed.isError).toBe(false);
    const child = [...f.children].at(-1)!;
    expect(child).not.toBe(original); expect(child.sessionId).toBe(identity);
    expect(child.sessionManager.getCwd()).toBe(cwd); expect(cwd).toBe(f.cwd);
    expect(child.systemPrompt).toBe(prompt);
    expect({ provider: child.model!.provider, id: child.model!.id }).toEqual(model);
    expect(new Set(f.archives(parent).map(r => r.id))).toEqual(new Set([id]));
    const attempted = results(child).find(r => r.toolCallId === "after-isolation-change");
    expect(attempted).toBeDefined();
    const remainsIsolated = isolation === "explicit-task";
    expect.soft(attempted!.isError).toBe(remainsIsolated);
    expect(f.effects()).toEqual(remainsIsolated ? [] : [{ name: "old_tool" }]);
    if (!remainsIsolated) expect(text(attempted!)).toContain("EXECUTED old_tool");
  });

  it.each(["direct", "native"] as const)("%s reports persisted child toolResult and standalone usage once, including parent restore", async path => {
    const f = await fixture(); f.role("ext:effects/charged_tool"); let parent = await f.parent();
    const entered = gate(), release = gate();
    const initialTotal = path === "native" ? 0.07 : 0.05;
    const finalTotal = path === "native" ? 0.09 : 0.07;
    f.faux.setResponses([call("charged_tool", "charged", {}), async () => { entered.resolve(); await release.promise; return fauxAssistantMessage("ACCOUNTED CHILD"); }]);
    const pending = path === "native"
      ? f.script(parent, `text(await tools.charged_tool({})); text(await tools.Agent(${JSON.stringify(f.input("charged child"))}));`, "charged-root")
      : f.invoke(parent, "Agent", f.input("charged child"), "charged-root");
    let first: ToolResultMessage;
    try {
      // Fail promptly at the real script rejection on the old model-only baseline.
      await Promise.race([entered.promise, pending.then(r => { expect(r.isError, text(r)).toBe(false); })]);
      expect(f.children.size).toBe(1);
      const child = [...f.children][0];
      child.sessionManager.appendUsage("contract-standalone", "r2-native-offline", "contract", cost(0.03));
      const entries = child.sessionManager.getEntries();
      expect(entries.some(e => e.type === "usage" && e.usage.cost.total === 0.03)).toBe(true);
      expect(results(child).find(r => r.toolCallId === "charged")?.usage?.cost.total).toBeCloseTo(0.02, 12);
    } finally { release.resolve(); }
    first = await pending; expect(first.isError).toBe(false); expect(first.usage?.cost.total).toBeCloseTo(initialTotal, 12);
    function persistedReceipts(toolCallId: string) {
      const entry = parent.sessionManager.getEntries().find(e => e.type === "message" &&
        e.message.role === "toolResult" && e.message.toolCallId === toolCallId);
      expect(entry?.type).toBe("message");
      return entry?.type === "message" && entry.message.role === "toolResult"
        ? (entry.message.details as { subagentUsageRollups?: unknown[] }).subagentUsageRollups : undefined;
    }
    if (path === "native") {
      expect.soft(persistedReceipts("charged-root")).toEqual([expect.objectContaining({
        version: 1, reportedUsage: expect.objectContaining({ cost: expect.objectContaining({ total: 0.05 }) }),
        cumulative: expect.objectContaining({ cost: 0.05 }),
      })]);
    }
    const rootReceipts = results(parent).filter(r => (r.usage?.cost.total ?? 0) > 0);
    expect(rootReceipts).toHaveLength(1); expect(rootReceipts[0].toolName).toBe(path === "native" ? "codemode" : "Agent");
    const id = f.archives(parent).at(-1)!.id;
    // Public stats include standalone usage as well as message receipts. A mixed
    // codemode receipt must retain its parent-owned cost, without an extra charge.
    const total = () => parent.getSessionStats().cost;
    expect(total()).toBeCloseTo(initialTotal, 12);
    for (const phase of ["live", "restored"] as const) {
      if (phase === "restored") { const file = parent.sessionFile!; await f.closeParent(parent); parent = await f.parent(file); }
      expect(total()).toBeCloseTo(initialTotal, 12);
      const get = path === "native"
        ? await f.script(parent, `text(await tools.get_subagent_result({agent_id:${JSON.stringify(id)},wait:true}));`, `repeat-${phase}`)
        : await f.invoke(parent, "get_subagent_result", { agent_id: id, wait: true }, `repeat-${phase}`);
      expect(get.isError).toBe(false); expect(text(get)).toContain("ACCOUNTED CHILD");
      expect(get.usage?.cost.total ?? 0).toBe(0); expect(total()).toBeCloseTo(initialTotal, 12);
    }
    // A later same-version continuation adds a real tool receipt, not an old cumulative snapshot.
    f.faux.setResponses([call("charged_tool", "charged-again", {}), fauxAssistantMessage("NEW DELTA")]);
    const resume = { ...f.input("one new tool receipt"), resume: id };
    const next = path === "native"
      ? await f.script(parent, `text(await tools.Agent(${JSON.stringify(resume)}));`, "new-delta")
      : await f.invoke(parent, "Agent", resume, "new-delta");
    if (path === "native") {
      expect.soft(persistedReceipts("new-delta")).toEqual([expect.objectContaining({
        version: 1, agentId: id,
        reportedUsage: expect.objectContaining({ cost: expect.objectContaining({ total: expect.closeTo(0.02, 12) }) }),
        cumulative: expect.objectContaining({ cost: 0.07 }),
      })]);
    }
    expect(next.isError).toBe(false); expect(next.usage?.cost.total).toBeCloseTo(0.02, 12); expect(total()).toBeCloseTo(finalTotal, 12);
  });
});
