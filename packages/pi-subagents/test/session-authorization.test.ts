import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, getAgentDir, ModelRegistry, ModelRuntime, SessionManager, SettingsManager, type AgentSession, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { fileURLToPath } from "node:url";
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
 pi.on("before_agent_start",()=>{leaf("late");pi.setActiveTools([...pi.getActiveTools(),"allowed","denied","late","write","edit"]);});
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
    fauxAssistantMessage(fauxToolCall(depth ? "bridge1" : target, depth ? { target, depth } : target === "write" ? { path: effects, content: "OVERWRITE" }
      : target === "edit" ? { path: effects, oldText: "ORIGINAL", newText: "MUTATED" } : {}), { stopReason: "toolUse" }),
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

  it("restores a saved inline definition and prefers a supplied current definition", async () => {
    const f = await fixture();
    let snapshot: AgentResumeSnapshot | undefined;
    f.script("allowed", 0);
    const original = await runAgent(f.ctx, "permission-role", "go", { pi: f.pi, inlineAgentConfig: f.config,
      onResumeSnapshot: saved => { snapshot = saved; }, onSessionCreated: session => sessions.push(session) });
    const saved = await restoreAgentSession(f.ctx, original.session.sessionFile!, snapshot!, { pi: f.pi });
    sessions.push(saved);
    expect(saved.getActiveToolNames()).toContain("allowed");
    const restored = await restoreAgentSession(f.ctx, original.session.sessionFile!, snapshot!, {
      pi: f.pi, currentAgentConfig: { ...f.config, disallowedTools: ["allowed"] },
    });
    sessions.push(restored);
    f.script("allowed", 1);
    await resumeAgent(restored, "continue");
    expect(readFileSync(f.effects, "utf8").trim()).toBe("allowed");
    expectDenied(restored);
  });

  it.each(["live", "cold"])("applies newly allowed registered tools without inheriting old denies (%s)", async kind => {
    const f = await fixture();
    let snapshot!: AgentResumeSnapshot;
    const config = { ...f.config, disallowedTools: ["allowed"] };
    f.faux.setResponses([fauxAssistantMessage("DONE")]);
    const first = await runAgent(f.ctx, "inline", "go", { pi: f.pi, inlineAgentConfig: config,
      onResumeSnapshot: value => { snapshot = value; }, onSessionCreated: session => sessions.push(session) });
    const current = { ...config, disallowedTools: [], extSelectors: ["ext:fixture/allowed", "ext:fixture/denied"] };
    const session = kind === "live" ? first.session
      : await restoreAgentSession(f.ctx, first.session.sessionFile!, snapshot, { pi: f.pi, currentAgentConfig: current });
    if (kind === "cold") sessions.push(session);
    for (const target of ["allowed", "denied"]) {
      f.script(target, 0);
      await resumeAgent(session, "use the current grant", { currentAgentConfig: current });
    }
    expect(readFileSync(f.effects, "utf8").trim().split("\n")).toEqual(["allowed", "denied"]);
  });

  it.each([false, true])("resolves memory capability after deny (write denied=%s)", async denied => {
    const f = await fixture();
    writeFileSync(f.effects, "ORIGINAL");
    f.script("edit", 0);
    const result = await runAgent(f.ctx, "inline", "go", { pi: f.pi,
      inlineAgentConfig: { ...f.config, builtinToolNames: ["write"], disallowedTools: denied ? ["write"] : [], memory: "project" },
      onSessionCreated: session => sessions.push(session) });
    expect(result.session.getAllTools().some(tool => tool.name === "edit")).toBe(true);
    if (denied) expectDenied(result.session);
    else expect(result.session.messages.filter(message => message.role === "toolResult").at(-1)?.isError).toBe(false);
    expect(readFileSync(f.effects, "utf8")).toBe(denied ? "ORIGINAL" : "MUTATED");
    expect(result.session.getActiveToolNames()).toContain("read");
    expect(result.session.getActiveToolNames().includes("edit")).toBe(!denied);
  });

  it.each([[false, "live"], [false, "cold"], [true, "live"], [true, "cold"]] as const)(
    "preserves the explicit isolated request and applies current isolation (explicit=%s, %s resume)", async (historicalIsolated, kind) => {
      const f = await fixture();
      const role = join(f.cwd, ".pi/agents/isolation.md");
      mkdirSync(dirname(role), { recursive: true });
      const definition = (isolated: boolean) => `---\ntools: none\nextensions: ${f.file}\nskills: none\nisolated: ${isolated}\npersist_session: true\nsession_dir: ${join(f.cwd, "sessions")}\nprompt_mode: replace\n---\nISOLATION_ROLE`;
      writeFileSync(role, definition(historicalIsolated));
      // The observer really stays registered and reactivates itself each prompt;
      // this is an execution denial, not an unknown-tool result.
      writeSetting(join(getAgentDir(), "settings.json"), JSON.stringify({ extensions: [f.file] }));
      writeSetting(join(getAgentDir(), "extension-data/pi-subagents/config.json"), JSON.stringify({ pinnedExtensions: ["fixture"] }));
      let snapshot!: AgentResumeSnapshot;
      f.faux.setResponses([fauxAssistantMessage("DONE")]);
      const first = await runAgent(f.ctx, "isolation", "go", { pi: f.pi, isolated: historicalIsolated,
        onResumeSnapshot: value => { snapshot = value; }, onSessionCreated: session => sessions.push(session) });
      writeFileSync(role, definition(!historicalIsolated));
      const session = kind === "live" ? first.session
        : await restoreAgentSession(f.ctx, first.session.sessionFile!, snapshot, { pi: f.pi });
      if (kind === "cold") sessions.push(session);
      expect(session.getAllTools().some(tool => tool.name === "allowed")).toBe(true);
      f.script("allowed", 0);
      await resumeAgent(session, "try the extension");
      expectDenied(session);
      expect(readFileSync(f.effects, "utf8")).toBe("");
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

  it("reloads the current named role by name without changing the saved prompt", async () => {
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
    await expect(restoreAgentSession(f.ctx, first.session.sessionFile!, snapshot, { pi: f.pi })).rejects.toThrow(/authorization.*named role/);
    rmSync(role);
    await expect(restoreAgentSession(f.ctx, first.session.sessionFile!, snapshot, { pi: f.pi })).rejects.toThrow(/authorization.*named role/);
    const replacement = join(f.cwd, ".agents/agents/named.md");
    mkdirSync(dirname(replacement), { recursive: true });
    writeFileSync(replacement, `---\n${frontmatter}\ntools: ext:fixture/allowed\n---\nREPLACEMENT`);
    const moved = await restoreAgentSession(f.ctx, first.session.sessionFile!, snapshot, { pi: f.pi });
    sessions.push(moved);
    f.script("allowed", 0);
    await resumeAgent(moved, "use the current role");
    expect(readFileSync(f.effects, "utf8").trim().split("\n")).toEqual(["allowed", "allowed"]);
  });

  it("widens a current-version inline task using its supplied current definition", async () => {
    const f = await fixture();
    const config: InlineAgentConfig = { ...f.config, builtinToolNames: ["read"], extensions: false, extSelectors: [] };
    let snapshot!: AgentResumeSnapshot;
    f.faux.setResponses([fauxAssistantMessage("DONE")]);
    const original = await runAgent(f.ctx, "inline", "go", { pi: f.pi, inlineAgentConfig: config,
      onResumeSnapshot: value => { snapshot = value; }, onSessionCreated: session => sessions.push(session) });
    const restored = await restoreAgentSession(f.ctx, original.session.sessionFile!, snapshot, {
      pi: f.pi, currentAgentConfig: { ...config, builtinToolNames: ["read", "write"] },
    });
    sessions.push(restored);
    expect(restored.sessionManager.getSessionId()).toBe(original.session.sessionManager.getSessionId());
    expect(restored.getActiveToolNames()).toEqual(["read", "write"]);
    f.script("write", 0);
    await resumeAgent(restored, "use the new grant");
    expect(readFileSync(f.effects, "utf8")).toBe("OVERWRITE");
  });

  it("loads newly permitted extensions on current-version named cold recovery", async () => {
    const f = await fixture();
    const role = join(f.cwd, ".pi/agents/legacy.md");
    mkdirSync(dirname(role), { recursive: true });
    const base = `skills: none\npersist_session: true\nsession_dir: ${join(f.cwd, "sessions")}\nprompt_mode: replace`;
    writeFileSync(role, `---\n${base}\ntools: read\nextensions: none\n---\nLEGACY_ORIGINAL`);
    let snapshot!: AgentResumeSnapshot;
    f.faux.setResponses([fauxAssistantMessage("DONE")]);
    const first = await runAgent(f.ctx, "legacy", "go", { pi: f.pi,
      onResumeSnapshot: value => { snapshot = value; }, onSessionCreated: session => sessions.push(session) });
    expect(snapshot.config.source).toBe("project");
    writeFileSync(role, `---\n${base}\ntools: read, write, ext:fixture/allowed\nextensions: ${f.file}\n---\nCURRENT_ROLE`);
    const calls = f.faux.state.callCount;
    await expect(resumeAgent(first.session, "load new extension live")).rejects.toThrow(/not loaded in this live session/);
    expect(f.faux.state.callCount).toBe(calls);
    const restored = await restoreAgentSession(f.ctx, first.session.sessionFile!, snapshot, { pi: f.pi });
    sessions.push(restored);
    expect(restored.sessionManager.getSessionId()).toBe(first.session.sessionManager.getSessionId());
    expect(restored.systemPrompt).toBe(first.session.systemPrompt);
    expect(restored.model?.id).toBe(first.session.model?.id);
    expect(restored.getActiveToolNames()).toEqual(expect.arrayContaining(["read", "write", "allowed"]));
    for (const target of ["write", "allowed"]) {
      expect(restored.getAllTools().some(tool => tool.name === target)).toBe(true);
      f.script(target, 0);
      await resumeAgent(restored, "use the current permissions");
      expect(restored.messages.filter(message => message.role === "toolResult").at(-1)?.isError).toBe(false);
    }
    expect(readFileSync(f.effects, "utf8")).toBe("OVERWRITEallowed\n");
    writeFileSync(role, `---\n${base}\ntools: read\nextensions: none\nenabled: false\n---\nDISABLED`);
    await expect(restoreAgentSession(f.ctx, first.session.sessionFile!, snapshot, { pi: f.pi })).rejects.toThrow(/authorization.*named role/);
    rmSync(role);
    await expect(restoreAgentSession(f.ctx, first.session.sessionFile!, snapshot, { pi: f.pi })).rejects.toThrow(/authorization.*named role/);
  });

  it("rejects missing role identity without guessing authority or changing valid history", async () => {
    const f = await fixture();
    let snapshot!: AgentResumeSnapshot;
    f.script("allowed", 0);
    const result = await runAgent(f.ctx, "inline", "go", { pi: f.pi, inlineAgentConfig: f.config,
      onResumeSnapshot: value => { snapshot = value; }, onSessionCreated: session => sessions.push(session) });
    delete snapshot.authorization;
    const before = readFileSync(result.session.sessionFile!, "utf8");
    await expect(restoreAgentSession(f.ctx, result.session.sessionFile!, snapshot, { pi: f.pi, currentAgentConfig: f.config }))
      .rejects.toThrow(/no supported role identity/);
    expect(readFileSync(result.session.sessionFile!, "utf8")).toBe(before);
    expect(JSON.stringify(result.session.messages)).toContain("DONE");
  });

  it("binds the real activation to ctx.cwd and keeps workflow tools directly callable", async () => {
    const f = await fixture();
    const role = join(f.cwd, ".pi/agents/actual.md");
    mkdirSync(dirname(role), { recursive: true });
    writeFileSync(role, "---\ndisplay_name: Local Friendly\ndescription: LOCAL_ROLE_DESCRIPTION\ntools: none\nextensions: none\nskills: none\npersist_session: false\nprompt_mode: replace\n---\nACTUAL_CWD_ROLE");
    writeSetting(join(f.cwd, ".pi/extension-data/pi-subagents/config.json"), JSON.stringify({
      worktreeIsolation: true, schedulingEnabled: false, disableDefaultAgents: true,
    }));
    expect(loadCustomAgents(f.cwd).get("actual")?.systemPrompt).toBe("ACTUAL_CWD_ROLE");
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const names = ["Agent", "get_subagent_result", "steer_subagent"];
    const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: getAgentDir(), settingsManager: settings,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    const { session } = await createAgentSession({ cwd: f.cwd, agentDir: getAgentDir(), modelRuntime: f.runtime,
      model: f.faux.getModel(), resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(f.cwd) });
    sessions.push(session);
    try {
      await session.bindExtensions({});
      const agentTool = session.getToolDefinition("Agent")!;
      expect(agentTool).toHaveProperty("parameters.properties.isolation");
      expect(agentTool).not.toHaveProperty("parameters.properties.schedule");
      expect(agentTool.parameters).toMatchObject({ properties: {
        subagent_type: { description: expect.stringContaining("Available types: actual.") },
      } });
      expect(agentTool.description).toContain("LOCAL_ROLE_DESCRIPTION");
      for (const name of names) {
        expect(session.getToolDefinition(name)?.exposure ?? "direct").toBe("direct");
        expect(session.getToolDefinition(name)?.executionMode).toBeUndefined();
        expect(session.getActiveToolNames()).toContain(name);
      }
      f.faux.setResponses([
        context => {
          const advertised = getCurrentTools(context.messages).find(tool => tool.name === "Agent");
          expect(advertised).toHaveProperty("parameters.properties.isolation");
          expect(advertised).not.toHaveProperty("parameters.properties.schedule");
          expect(advertised?.description).toContain("LOCAL_ROLE_DESCRIPTION");
          return fauxAssistantMessage(fauxToolCall("Agent", { prompt: "go", description: "probe", subagent_type: "actual", isolation: "off" }), { stopReason: "toolUse" });
        },
        context => fauxAssistantMessage(getCurrentSystemPrompt(context.messages).includes("ACTUAL_CWD_ROLE") ? "CORRECT_CHILD" : "WRONG_CHILD"),
        fauxAssistantMessage("DONE"),
      ]);
      await session.prompt("Run the named role");
      const direct = session.messages.filter(message => message.role === "toolResult").at(-1)!;
      expect(JSON.stringify(direct)).toContain("CORRECT_CHILD");
      const details = direct.details as { agentId: string; displayName: string; tags?: string[] };
      expect(details.displayName).toBe("Local Friendly");
      expect(details.tags ?? []).not.toContain("twin");
      expect(details.agentId).toBeTruthy();
    } finally {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    }
  });

  it.each([false, true])("distinguishes role-default isolation from an effective explicit Agent request across cold recovery (%s)", async explicit => {
    const f = await fixture();
    const role = join(f.cwd, ".pi/agents/public-isolation.md");
    mkdirSync(dirname(role), { recursive: true });
    const definition = (isolated: boolean) => `---\ntools: ext:fixture/allowed\nextensions: ${f.file}\nskills: none\nisolated: ${isolated}\npersist_session: true\nsession_dir: ${join(f.cwd, "children")}\nprompt_mode: replace\n---\nPUBLIC_ROLE`;
    writeFileSync(role, definition(true));
    const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
    const open = async (file?: string) => {
      const loader = new DefaultResourceLoader({ cwd: f.cwd, agentDir: getAgentDir(), settingsManager: settings,
        noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
        additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))] });
      await loader.reload();
      expect(loader.getExtensions().errors).toEqual([]);
      const { session } = await createAgentSession({ cwd: f.cwd, agentDir: getAgentDir(), modelRuntime: f.runtime,
        model: f.faux.getModel(), resourceLoader: loader, settingsManager: settings,
        sessionManager: file ? SessionManager.open(file) : SessionManager.create(f.cwd, join(f.cwd, "parents")) });
      await session.bindExtensions({});
      return session;
    };
    const close = async (session: AgentSession) => {
      await session.waitForIdle();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
    };
    let parent = await open();
    try {
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("Agent", { prompt: "first", description: "isolation source", subagent_type: "public-isolation", ...(explicit ? { isolated: true } : {}) }), { stopReason: "toolUse" }),
        context => {
          expect(getCurrentTools(context.messages).some(tool => tool.name === "allowed")).toBe(false);
          return fauxAssistantMessage("FIRST_DONE");
        },
        fauxAssistantMessage("PARENT_DONE"),
      ]);
      await parent.prompt("start named isolated role");
      const first = parent.messages.filter(message => message.role === "toolResult").at(-1)!;
      expect(first.isError).toBe(false);
      const id = (first.details as { agentId: string }).agentId;
      expect(id).toBeTruthy();
      const file = parent.sessionFile!;
      await close(parent);
      writeFileSync(role, definition(false));
      parent = await open(file);
      f.faux.setResponses([
        fauxAssistantMessage(fauxToolCall("Agent", { resume: id, prompt: "use current extension", description: "cold resume", subagent_type: "public-isolation" }), { stopReason: "toolUse" }),
        context => {
          expect(getCurrentTools(context.messages).some(tool => tool.name === "allowed")).toBe(!explicit);
          return fauxAssistantMessage(fauxToolCall("allowed", {}), { stopReason: "toolUse" });
        },
        fauxAssistantMessage("RESUMED"), fauxAssistantMessage("PARENT_DONE"),
      ]);
      await parent.prompt("resume after changing the role");
      expect(readFileSync(f.effects, "utf8")).toBe(explicit ? "" : "allowed\n");
    } finally { await close(parent); }
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
