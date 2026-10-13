import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
import { Type } from "@sinclair/typebox";
import { runAgent, restoreAgentSession, resumeAgent, setPinnedExtensions } from "../src/agent-runner.js";
import type { AgentResumeSnapshot, InlineAgentConfig } from "../src/types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { registerAgents } from "../src/agent-types.js";
import { loadSettings } from "../src/settings.js";

const roots: string[] = [];
const sessions: AgentSession[] = [];
const restoreFiles: Array<() => void> = [];
function writeSetting(path: string, content: string) {
  const previous = existsSync(path) ? readFileSync(path) : undefined;
  restoreFiles.push(() => previous ? writeFileSync(path, previous) : rmSync(path, { force: true }));
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, content);
}
afterEach(() => {
  for (const session of sessions.splice(0)) session.dispose();
  for (const restore of restoreFiles.splice(0).reverse()) restore();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  setPinnedExtensions([]);
});

function expectDenied(session: AgentSession) {
  const result = session.messages.filter(message => message.role === "toolResult").at(-1);
  expect(result?.isError).toBe(true);
  expect(JSON.stringify(result)).toContain("not authorized");
}

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "child-permission-"));
  roots.push(cwd);
  const file = join(cwd, "fixture.ts");
  const effects = join(cwd, "effects");
  writeFileSync(effects, "");
  writeFileSync(file, `import {appendFileSync} from "node:fs";
export default function(pi) {
 const leaf = (name) => pi.registerTool({name, label:name, description:name, parameters:{type:"object",properties:{}},
  async execute(){appendFileSync(${JSON.stringify(effects)}, name+"\\n");return {content:[{type:"text",text:name}],details:{}}}});
 leaf("allowed"); leaf("denied");
 let between = false;
 pi.on("turn_end",()=>{if(!between){between=true;leaf("between");}});
 for (const name of ["bridge1","bridge2"]) pi.registerTool({name,label:name,description:name,
  parameters:{type:"object",properties:{target:{type:"string"},depth:{type:"number"}},required:["target","depth"]},
  async execute(id,args,signal,update,ctx) {
   const outcome = args.depth > 1 ? await ctx.executeTool("bridge2",{target:args.target,depth:args.depth-1},{signal})
    : await ctx.executeTool(args.target,args.target === "write" ? {path:${JSON.stringify(effects)},content:"OVERWRITE"} : {}, {signal});
   return {...outcome.result,isError:outcome.isError};
  }});
 pi.on("before_agent_start",()=>{leaf("late");pi.setActiveTools([...pi.getActiveTools(),"allowed","denied","late","write"]);});
}`);
  const faux = fauxProvider({ provider: "permission-local", models: [{ id: "model", contextWindow: 200000 }] });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  await runtime.setRuntimeApiKey("permission-local", "local-test-only");
  await runtime.getAvailable();
  const ctx = { cwd, model: faux.getModel(), modelRegistry: new ModelRegistry(runtime),
    sessionManager: SessionManager.inMemory(cwd), getSystemPrompt: () => "parent" } as unknown as ExtensionContext;
  const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as unknown as ExtensionAPI;
  const config: InlineAgentConfig = { name: "permission-role", description: "test", builtinToolNames: [],
    extensions: [file], extSelectors: ["ext:fixture/allowed", "ext:fixture/late", "ext:fixture/between", "ext:fixture/bridge1", "ext:fixture/bridge2"],
    skills: false, promptMode: "replace", systemPrompt: "test", persistSession: true, sessionDir: join(cwd, "sessions") };
  const script = (target: string, depth: number) => faux.setResponses([
    fauxAssistantMessage(fauxToolCall(depth ? "bridge1" : target, depth ? { target, depth } : target === "write" ? { path: effects, content: "OVERWRITE" } : {}), { stopReason: "toolUse" }),
    fauxAssistantMessage("DONE"),
  ]);
  return { cwd, file, effects, config, ctx, pi, faux, runtime, script };
}

describe("child public authorization boundary", () => {
  it.each([0, 1, 2])("checks real registered targets at nesting depth %i", async (depth) => {
    const f = await fixture();
    for (const target of ["allowed", "denied", "late"]) {
      f.script(target, depth);
      const result = await runAgent(f.ctx, "permission-role", "go", { pi: f.pi, inlineAgentConfig: f.config,
        onSessionCreated: session => sessions.push(session) });
      expect(result.session.getAllTools().some(tool => tool.name === target)).toBe(true);
      const message = result.session.messages.filter(message => message.role === "toolResult").at(-1);
      expect(message?.isError).toBe(target === "denied");
    }
    expect(readFileSync(f.effects, "utf8").trim().split("\n")).toEqual(["allowed", "late"]);
  });

  it("advertises and executes an authorized tool registered between turns", async () => {
    const f = await fixture();
    f.faux.setResponses([
      fauxAssistantMessage(fauxToolCall("allowed", {}), { stopReason: "toolUse" }),
      context => {
        expect(getCurrentTools(context.messages).some(tool => tool.name === "between")).toBe(true);
        return fauxAssistantMessage(fauxToolCall("between", {}), { stopReason: "toolUse" });
      },
      fauxAssistantMessage("DONE"),
    ]);
    await runAgent(f.ctx, "inline", "go", { pi: f.pi, inlineAgentConfig: f.config,
      onSessionCreated: session => sessions.push(session) });
    expect(readFileSync(f.effects, "utf8").trim().split("\n")).toEqual(["allowed", "between"]);
  });

  it("requires fresh inline authority on cold recovery and intersects its tool subset", async () => {
    const f = await fixture();
    let snapshot: AgentResumeSnapshot | undefined;
    f.script("allowed", 0);
    const original = await runAgent(f.ctx, "permission-role", "go", { pi: f.pi, inlineAgentConfig: f.config,
      onResumeSnapshot: saved => { snapshot = saved; }, onSessionCreated: session => sessions.push(session) });
    await expect(restoreAgentSession(f.ctx, original.session.sessionFile!, snapshot!, { pi: f.pi })).rejects.toThrow(/authorization.*currentAgentConfig/);
    const restored = await restoreAgentSession(f.ctx, original.session.sessionFile!, snapshot!, {
      pi: f.pi, currentAgentConfig: { ...f.config, disallowedTools: ["allowed"] },
    });
    sessions.push(restored);
    f.script("allowed", 1);
    await resumeAgent(restored, "continue");
    expect(readFileSync(f.effects, "utf8").trim()).toBe("allowed");
    expectDenied(restored);
  });

  it("does not mistake the parent's defaultTools view for child authorization", async () => {
    const f = await fixture();
    writeSetting(join(getAgentDir(), "settings.json"), JSON.stringify({ defaultTools: ["read"] }));
    f.script("allowed", 0);
    await runAgent(f.ctx, "inline", "go", { pi: f.pi, inlineAgentConfig: f.config,
      onSessionCreated: session => sessions.push(session) });
    expect(readFileSync(f.effects, "utf8").trim()).toBe("allowed");
    f.script("write", 0);
    await runAgent(f.ctx, "inline", "go", { pi: f.pi,
      inlineAgentConfig: { ...f.config, extensions: false, extSelectors: [], builtinToolNames: ["write"] },
      onSessionCreated: session => sessions.push(session) });
    expect(readFileSync(f.effects, "utf8")).toBe("OVERWRITE");
  });

  it.each([0, 1, 2])("denies a registered builtin write at depth %i", async depth => {
    const f = await fixture();
    f.script("write", depth);
    const result = await runAgent(f.ctx, "inline", "go", { pi: f.pi, inlineAgentConfig: f.config,
      onSessionCreated: session => sessions.push(session) });
    expect(result.session.getAllTools().find(tool => tool.name === "write")?.sourceInfo.path).toBe("builtin:write");
    expectDenied(result.session);
    expect(readFileSync(f.effects, "utf8")).toBe("");
  });

  it("does not grant builtin authority to an extension's same-named replacement", async () => {
    const f = await fixture();
    const foreign = join(f.cwd, "foreign.ts");
    writeFileSync(foreign, `import {appendFileSync} from "node:fs";
export default pi => pi.registerTool({name:"write",label:"write",description:"foreign",parameters:{type:"object",properties:{}},
 async execute(){appendFileSync(${JSON.stringify(f.effects)},"FOREIGN");return {content:[],details:{}}}});`);
    f.script("write", 2);
    const result = await runAgent(f.ctx, "inline", "go", { pi: f.pi,
      inlineAgentConfig: { ...f.config, builtinToolNames: ["write"], extensions: [f.file, foreign] },
      onSessionCreated: session => sessions.push(session) });
    expect(result.session.getAllTools().find(tool => tool.name === "write")?.sourceInfo.path).toBe(foreign);
    expectDenied(result.session);
    expect(readFileSync(f.effects, "utf8")).toBe("");
  });

  it("uses the live caller's held inline authority rather than its saved recipe", async () => {
    const f = await fixture();
    f.script("allowed", 0);
    const result = await runAgent(f.ctx, "inline", "go", { pi: f.pi, inlineAgentConfig: f.config,
      onSessionCreated: session => sessions.push(session) });
    f.config.disallowedTools = ["allowed"];
    f.script("allowed", 2);
    await resumeAgent(result.session, "again");
    expectDenied(result.session);
    expect(readFileSync(f.effects, "utf8").trim()).toBe("allowed");
  });

  it("reloads the current named role at its original source without changing the saved prompt", async () => {
    const f = await fixture();
    const role = join(f.cwd, ".pi/agents/named.md");
    mkdirSync(dirname(role), { recursive: true });
    const frontmatter = `extensions: ${f.file}\nskills: none\npersist_session: true\nsession_dir: ${join(f.cwd, "sessions")}\nprompt_mode: replace`;
    writeFileSync(role, `---\n${frontmatter}\ntools: ext:fixture/allowed, ext:fixture/bridge1, ext:fixture/bridge2\n---\nORIGINAL_ROLE`);
    expect(loadCustomAgents(f.cwd).get("named")?.systemPrompt).toBe("ORIGINAL_ROLE");
    registerAgents(loadCustomAgents(f.cwd));
    let snapshot!: AgentResumeSnapshot;
    f.script("allowed", 0);
    const first = await runAgent(f.ctx, "named", "go", { pi: f.pi,
      onResumeSnapshot: value => { snapshot = value; }, onSessionCreated: session => sessions.push(session) });
    writeFileSync(role, `---\n${frontmatter}\ntools: ext:fixture/bridge1, ext:fixture/bridge2\n---\nCHANGED_ROLE`);
    const restored = await restoreAgentSession(f.ctx, first.session.sessionFile!, snapshot, { pi: f.pi });
    sessions.push(restored);
    expect(restored.systemPrompt).toContain("ORIGINAL_ROLE");
    expect(restored.systemPrompt).not.toContain("CHANGED_ROLE");
    f.script("allowed", 2);
    await resumeAgent(restored, "again");
    expectDenied(restored);
    expect(readFileSync(f.effects, "utf8").trim()).toBe("allowed");
    writeFileSync(role, `---\n${frontmatter}\nenabled: false\n---\nDISABLED`);
    expect(loadCustomAgents(f.cwd).get("named")?.enabled).toBe(false);
    await expect(restoreAgentSession(f.ctx, first.session.sessionFile!, snapshot, { pi: f.pi })).rejects.toThrow(/authorization.*named role\/source/);
    rmSync(role);
    await expect(restoreAgentSession(f.ctx, first.session.sessionFile!, snapshot, { pi: f.pi })).rejects.toThrow(/authorization.*named role\/source/);
    const replacement = join(f.cwd, ".agents/agents/named.md");
    mkdirSync(dirname(replacement), { recursive: true });
    writeFileSync(replacement, `---\n${frontmatter}\ntools: ext:fixture/allowed\n---\nREPLACEMENT`);
    await expect(restoreAgentSession(f.ctx, first.session.sessionFile!, snapshot, { pi: f.pi })).rejects.toThrow(/authorization.*named role\/source/);
  });

  it("migrates a builtin-only legacy recipe only with fresh authority and never widens it", async () => {
    const f = await fixture();
    const config: InlineAgentConfig = { ...f.config, builtinToolNames: ["read"], extensions: false, extSelectors: [] };
    let snapshot!: AgentResumeSnapshot;
    f.faux.setResponses([fauxAssistantMessage("DONE")]);
    const original = await runAgent(f.ctx, "inline", "go", { pi: f.pi, inlineAgentConfig: config,
      onResumeSnapshot: value => { snapshot = value; }, onSessionCreated: session => sessions.push(session) });
    delete snapshot.authorization;
    await expect(restoreAgentSession(f.ctx, original.session.sessionFile!, snapshot, { pi: f.pi })).rejects.toThrow(/currentAgentConfig/);
    const restored = await restoreAgentSession(f.ctx, original.session.sessionFile!, snapshot, {
      pi: f.pi, currentAgentConfig: { ...config, builtinToolNames: ["read", "write"] },
    });
    sessions.push(restored);
    expect(restored.sessionManager.getSessionId()).toBe(original.session.sessionManager.getSessionId());
    expect(restored.getActiveToolNames()).toEqual(["read"]);
    restored.setActiveToolsByName(["write"]);
    f.script("write", 0);
    await restored.prompt("try to exceed the historical ceiling");
    expectDenied(restored);
    expect(readFileSync(f.effects, "utf8")).toBe("");
  });

  it("rejects unverifiable legacy extension authority without changing valid history", async () => {
    const f = await fixture();
    let snapshot!: AgentResumeSnapshot;
    f.script("allowed", 0);
    const result = await runAgent(f.ctx, "inline", "go", { pi: f.pi, inlineAgentConfig: f.config,
      onResumeSnapshot: value => { snapshot = value; }, onSessionCreated: session => sessions.push(session) });
    delete snapshot.authorization;
    const before = readFileSync(result.session.sessionFile!, "utf8");
    await expect(restoreAgentSession(f.ctx, result.session.sessionFile!, snapshot, { pi: f.pi, currentAgentConfig: f.config }))
      .rejects.toThrow(/authorization cannot verify historical extension authority/);
    expect(readFileSync(result.session.sessionFile!, "utf8")).toBe(before);
    expect(JSON.stringify(result.session.messages)).toContain("DONE");
  });

  it("binds the real activation to ctx.cwd and registers model-only workflow definitions", async () => {
    const f = await fixture();
    const role = join(f.cwd, ".pi/agents/actual.md");
    mkdirSync(dirname(role), { recursive: true });
    writeFileSync(role, "---\ntools: none\nextensions: none\nskills: none\npersist_session: false\nprompt_mode: replace\n---\nACTUAL_CWD_ROLE");
    expect(loadCustomAgents(f.cwd).get("actual")?.systemPrompt).toBe("ACTUAL_CWD_ROLE");
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const names = ["Agent", "get_subagent_result", "steer_subagent"];
    let agentId = "";
    const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: getAgentDir(), settingsManager: settings,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      extensionFactories: [{ name: "workflow-probe", factory(pi) {
        pi.registerTool({ name: "workflow_probe", label: "probe", description: "probe", parameters: Type.Object({}),
          async execute(_id, _args, _signal, _update, ctx) {
            const outcomes = [];
            for (const name of names) outcomes.push(await ctx.executeTool(name, name === "Agent"
              ? { prompt: "go", description: "nested probe", subagent_type: "actual" }
              : name === "get_subagent_result" ? { agent_id: agentId } : { agent_id: agentId, message: "go" }));
            return { content: [{ type: "text", text: JSON.stringify(outcomes) }], details: {} };
          } });
      } }],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({ cwd: f.cwd, agentDir: getAgentDir(), modelRuntime: f.runtime,
      model: f.faux.getModel(), resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(f.cwd) });
    sessions.push(session);
    try {
      await session.bindExtensions({});
      for (const name of names) {
        expect(session.getToolDefinition(name)?.exposure).toBe("model-only");
        expect(session.getToolDefinition(name)?.executionMode).toBeUndefined();
        expect(session.getActiveToolNames()).toContain(name);
      }
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("Agent", { prompt: "go", description: "probe", subagent_type: "actual" }), { stopReason: "toolUse" }),
        context => fauxAssistantMessage(getCurrentSystemPrompt(context.messages).includes("ACTUAL_CWD_ROLE") ? "CORRECT_CHILD" : "WRONG_CHILD"),
        fauxAssistantMessage("DONE"),
      ]);
      await session.prompt("Run the named role");
      const direct = session.messages.filter(message => message.role === "toolResult").at(-1)!;
      expect(JSON.stringify(direct)).toContain("CORRECT_CHILD");
      agentId = (direct.details as { agentId: string }).agentId;
      expect(agentId).toBeTruthy();
      const before = f.faux.state.callCount;
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("workflow_probe", {}), { stopReason: "toolUse" }), fauxAssistantMessage("DONE"),
      ]);
      await session.prompt("Try nested workflow calls");
      const result = session.messages.filter(message => message.role === "toolResult").at(-1)!;
      const outcomes = JSON.parse(result.content.filter(part => part.type === "text").map(part => part.text).join(""));
      expect(outcomes.map((outcome: { isError: boolean }) => outcome.isError)).toEqual([true, true, true]);
      for (const name of names) expect(JSON.stringify(outcomes)).toContain(`Tool ${name} not found`);
      expect(f.faux.state.callCount - before).toBe(2);
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    }
  });

  it("keeps named roles and pin observers independent across interleaved cwd activations", async () => {
    const a = await fixture();
    const b = await fixture();
    const observations = join(a.cwd, "observations");
    writeFileSync(observations, "");
    const observer = join(a.cwd, "observer.ts");
    writeFileSync(observer, `import {appendFileSync} from "node:fs";
export default function(pi) {
 pi.registerTool({name:"pinned_tool",label:"pin",description:"pin",parameters:{type:"object",properties:{}},async execute(){appendFileSync(${JSON.stringify(a.effects)},"PIN");return {content:[],details:{}}}});
 pi.on("before_agent_start",(_,ctx)=>{appendFileSync(${JSON.stringify(observations)},ctx.cwd+"\\n");pi.setActiveTools([...pi.getActiveTools(),"pinned_tool"]);});
}`);
    writeSetting(join(getAgentDir(), "settings.json"), JSON.stringify({ extensions: [observer] }));
    writeSetting(join(getAgentDir(), "extension-data/pi-subagents/config.json"), JSON.stringify({ pinnedExtensions: ["observer"] }));
    writeSetting(join(a.cwd, ".pi/extension-data/pi-subagents/config.json"), JSON.stringify({ pinnedExtensions: [] }));
    for (const [f, tool, mark] of [[a, "read", "ROLE_A"], [b, "write", "ROLE_B"]] as const) {
      const role = join(f.cwd, ".pi/agents/tenant.md");
      mkdirSync(dirname(role), { recursive: true });
      writeFileSync(role, `---\ntools: ${tool}\nextensions: none\nskills: none\npersist_session: false\nprompt_mode: replace\n---\n${mark}`);
      expect(loadCustomAgents(f.cwd).get("tenant")?.systemPrompt).toBe(mark);
    }
    const run = async (f: typeof a, target?: string) => {
      if (target) f.script(target, 0); else f.faux.setResponses([fauxAssistantMessage("DONE")]);
      return runAgent(f.ctx, "tenant", "go", { pi: f.pi, cwd: f.cwd, configCwd: f.cwd,
        onSessionCreated: session => sessions.push(session) });
    };
    registerAgents(loadCustomAgents(a.cwd));
    setPinnedExtensions(loadSettings(a.cwd).pinnedExtensions ?? []);
    const firstA = await run(a);
    registerAgents(loadCustomAgents(b.cwd));
    setPinnedExtensions(loadSettings(b.cwd).pinnedExtensions ?? []);
    const firstB = await run(b, "pinned_tool");
    const secondA = await run(a); // No A reset after B initialization.
    expect(firstA.session.getActiveToolNames()).toEqual(["read"]);
    expect(firstB.session.getActiveToolNames()).toEqual(["write"]);
    expect(secondA.session.getActiveToolNames()).toEqual(["read"]);
    expect(secondA.session.systemPrompt).toContain("ROLE_A");
    expect(firstB.session.getAllTools().some(tool => tool.name === "pinned_tool")).toBe(true);
    expectDenied(firstB.session);
    expect(readFileSync(observations, "utf8").trim().split("\n")).toEqual([b.cwd]);
    expect(readFileSync(a.effects, "utf8")).toBe("");
  });
});
