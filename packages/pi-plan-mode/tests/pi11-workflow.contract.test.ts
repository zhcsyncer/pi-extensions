import * as childProcess from "node:child_process";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, readdirSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRequire, syncBuiltinESMExports } from "node:module";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type AgentSession, type ExtensionFactory, type ExtensionUIContext, type Theme,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import planMode from "../extensions/plan-mode.js";

// Independent P1-A integration contract. No trusted native Context7 identity is fabricated.
// The executable and UI choices implement only the public fixture protocol.
const subprocess = vi.hoisted(() => ({ allowed: "" }));
vi.mock("node:child_process", async (original) => {
  const actual = await original<typeof childProcess>();
  const spawnSync = actual.spawnSync;
  const denied = () => { throw new Error("Fixture forbids external execution"); };
  return {
    ...actual, exec: denied, execSync: denied, execFile: denied, execFileSync: denied,
    spawn: denied, fork: denied,
    spawnSync: (...args: Parameters<typeof childProcess.spawnSync>) => {
      if (args[0] !== subprocess.allowed || !subprocess.allowed) return denied();
      return spawnSync(...args);
    },
  };
});

const require = createRequire(import.meta.url);
const nativeProcess = require("node:child_process") as typeof childProcess;
const nativeSpawnSync = nativeProcess.spawnSync;

const markdown = "# Isolated workflow\n\n## Goal\nExercise explicit approval.\n\n## Steps\n1. Implement the agreed change.\n2. Verify the result.\n";
const submit = { title: "Isolated workflow", markdown };
let root: string;
let sessions: AgentSession[];
let sequence = 0;

beforeEach(() => {
  // Also guard external SDK modules, which are outside Vitest's transformed module graph.
  for (const name of ["exec", "execSync", "execFile", "execFileSync", "spawn", "fork"] as const) {
    vi.spyOn(nativeProcess, name).mockImplementation(() => { throw new Error("Fixture forbids external execution"); });
  }
  vi.spyOn(nativeProcess, "spawnSync").mockImplementation((...args: Parameters<typeof childProcess.spawnSync>) => {
    if (args[0] !== subprocess.allowed || !subprocess.allowed) throw new Error("Fixture forbids external execution");
    return nativeSpawnSync(...args);
  });
  for (const module of ["node:http", "node:https"]) {
    const network = require(module);
    for (const method of ["request", "get"]) vi.spyOn(network, method).mockImplementation(() => { throw new Error("Fixture forbids network"); });
  }
  syncBuiltinESMExports();
  root = mkdtempSync(join(tmpdir(), "pi11-plan-workflow-"));
  sessions = [];
  for (const name of ["home", "agent", "work", "sessions"]) mkdirSync(join(root, name));
  vi.stubEnv("HOME", join(root, "home"));
  vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
  vi.stubEnv("XDG_CONFIG_HOME", join(root, "home", "config"));
  subprocess.allowed = join(root, "revdiff");
  vi.stubEnv("REVDIFF_BIN", subprocess.allowed);
  writeFileSync(subprocess.allowed, `#!${process.execPath}\nconst fs = require('node:fs');
const path = require('node:path');
const root = __dirname;
const args = process.argv.slice(2);
fs.appendFileSync(path.join(root, 'reviews.jsonl'), JSON.stringify({args, exitOnAnnotations: process.env.REVDIFF_EXIT_CODE_ON_ANNOTATIONS}) + '\\n');
const mode = fs.readFileSync(path.join(root, 'review-mode'), 'utf8');
if (mode === 'cancel') process.exit(130);
if (mode === 'annotations') {
  fs.writeFileSync(args.find(x => x.startsWith('--output=')).slice(9), 'Please add verification details.\\n');
  process.exit(10);
}
process.exit(0);
`, { mode: 0o755 });
  writeFileSync(join(root, "review-mode"), "clean");
  vi.stubGlobal("fetch", vi.fn(() => { throw new Error("Fixture forbids network"); }));
});

afterEach(async () => {
  for (const session of sessions.reverse()) {
    await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    session.dispose();
  }
  subprocess.allowed = "";
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  vi.restoreAllMocks();
  syncBuiltinESMExports();
  rmSync(root, { recursive: true, force: true });
});

function files(directory: string): Record<string, string> {
  const result: Record<string, string> = {};
  for (const item of readdirSync(directory, { withFileTypes: true })) {
    const path = join(directory, item.name);
    if (item.isDirectory()) Object.assign(result, files(path));
    else result[path] = readFileSync(path).toString("base64");
  }
  return result;
}

async function fixture(manager = SessionManager.create(join(root, "work"), join(root, "sessions"))) {
  const faux = fauxProvider();
  const runtime = await ModelRuntime.create({
    authPath: join(root, "agent", "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "agent", "models-cache.json"), refreshOnCreate: false,
    allowModelNetwork: false,
  });
  runtime.registerNativeProvider(faux.provider);
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  const observations = { bridge: 0, leaf: 0, unknown: 0, custom: 0, nestedWorkflowCalls: 0, callable: [] as string[], decisions: [] as string[], errors: [] as string[] };
  let decision: string | undefined = "Approve Plan";
  // A synthetic read-only parent uses an existing allowed name, not execute_script.
  // No policy is patched: both the parent and its nested leaf traverse actual SDK hooks.
  const bridge: ExtensionFactory = (pi) => {
    pi.on("tool_call", (event) => {
      if (event.parentToolCallId && ["submit_plan", "complete_plan"].includes(event.toolName)) observations.nestedWorkflowCalls++;
    });
    pi.registerTool({
      name: "read", label: "Fixture read bridge", description: "Offline nested-call test carrier",
      parameters: Type.Object({ target: Type.String(), args: Type.Any() }),
      async execute(_id, input, _signal, _update, ctx) {
        observations.bridge++;
        observations.callable = ctx.tools.map(tool => tool.name);
        const outcome = await ctx.executeTool(input.target, input.args);
        return { content: [{ type: "text", text: JSON.stringify(outcome) }], details: outcome };
      },
    });
    for (const name of ["find", "resolve-library-id", "query-docs", "mcp__unverified__query_docs", "ordinary_fixture"]) {
      pi.registerTool({
        name, label: name, description: "Offline fixture leaf", parameters: Type.Object({}),
        async execute() {
          if (name.startsWith("mcp__")) observations.unknown++;
          else observations.leaf++;
          return { content: [{ type: "text", text: "offline leaf reached" }], details: { reached: true } };
        },
      });
    }
  };
  const loader = new DefaultResourceLoader({
    cwd: join(root, "work"), agentDir: join(root, "agent"), settingsManager: settings,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: [bridge, planMode],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({
    cwd: join(root, "work"), agentDir: join(root, "agent"), resourceLoader: loader,
    modelRuntime: runtime, model: faux.getModel(), settingsManager: settings, sessionManager: manager,
    noTools: "builtin",
  });
  sessions.push(session);
  const theme = new Proxy({}, { get: () => (...args: string[]) => args.at(-1) ?? "" }) as Theme;
  const noop = () => {};
  const ui: ExtensionUIContext = {
    theme, select: async (title, options) => {
      observations.decisions.push(title);
      expect(title).toBe("Plan review finished. Choose an explicit decision:");
      expect(options).toEqual(["Approve Plan", "Keep planning", "Cancel review"]);
      return decision;
    },
    custom: async (factory) => {
      observations.custom++;
      return await new Promise((resolve, reject) => {
        // Execute the production factory and its binary invocation; only done settles approval UI.
        const tui = { stop: noop, start: noop, requestRender: noop };
        Promise.resolve(factory(tui as Parameters<typeof factory>[0], theme,
          {} as Parameters<typeof factory>[2], resolve)).catch(reject);
      });
    },
    confirm: async () => false, input: async () => undefined, editor: async () => undefined,
    notify: noop, onTerminalInput: () => noop, setStatus: noop, setWorkingMessage: noop,
    setWorkingVisible: noop, setWorkingIndicator: noop, setHiddenThinkingLabel: noop,
    setWidget: noop, setFooter: noop, setHeader: noop, setTitle: noop, pasteToEditor: noop,
    setEditorText: noop, getEditorText: () => "", addAutocompleteProvider: noop,
    setEditorComponent: noop, getEditorComponent: () => undefined,
    getAllThemes: () => [], getTheme: () => undefined, setTheme: () => ({ success: true }),
    getToolsExpanded: () => false, setToolsExpanded: noop,
  };
  await session.bindExtensions({ mode: "tui", uiContext: ui, onError: (error) => observations.errors.push(JSON.stringify(error)) });
  expect(observations.errors).toEqual([]);
  expect(session.getToolDefinition("read")?.label).toBe("Fixture read bridge");
  async function call(name: string, args: Parameters<typeof fauxToolCall>[1]) {
    const id = `workflow-${++sequence}`;
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall(name, args, { id })),
      ...Array.from({ length: 4 }, () => fauxAssistantMessage("Fixture turn finished.")),
    ]);
    await session.prompt("Perform the scripted offline contract call.");
    await session.waitForIdle();
    const result = session.messages.find(message => message.role === "toolResult" && message.toolCallId === id);
    expect(result, `Missing actual SDK result for ${name}`).toBeDefined();
    if (!result || result.role !== "toolResult") throw new Error("Missing tool result");
    expect(observations.errors).toEqual([]);
    return result;
  }
  return {
    session, manager, call, observations,
    choose: (value: string | undefined) => { decision = value; },
    planning: () => session.prompt("/plan on"),
    normal: () => session.prompt("/plan off"),
    state: () => manager.getEntries().filter(entry => entry.type === "custom"),
    artifacts: () => Object.fromEntries(Object.entries(files(root)).filter(([path]) => path !== manager.getSessionFile())),
    reviews: () => existsSync(join(root, "reviews.jsonl"))
      ? readFileSync(join(root, "reviews.jsonl"), "utf8").trim().split("\n").map(line => JSON.parse(line)) : [],
  };
}

type Harness = Awaited<ReturnType<typeof fixture>>;
function identity(result: Awaited<ReturnType<Harness["call"]>>) {
  expect(result.isError, JSON.stringify(result)).toBe(false);
  expect(result.details).toMatchObject({ planId: expect.any(String), revision: expect.any(Number) });
  const { planId, revision } = result.details as { planId: string; revision: number };
  return { planId, revision };
}
const completion = (id: { planId: string; revision: number }) => ({ ...id, summary: "Implemented isolated plan", verification: ["Offline contract passed"] });

describe.sequential("P1-A public workflow through SDK 1.1", () => {
  it.each(["submit_plan", "complete_plan"])("keeps %s sequential and marks its actual registered definition model-only", async (name) => {
    const h = await fixture();
    const definition = h.session.getToolDefinition(name);
    expect(definition).toBeDefined();
    expect(definition?.executionMode).toBe("sequential");
    expect(definition?.exposure).toBe("model-only");
  });

  it("direct submit runs revdiff, requires explicit approval and completes only the exact approved revision", async () => {
    const h = await fixture();
    const ordinary = h.session.getActiveToolNames().sort();
    await h.planning();
    const result = await h.call("submit_plan", submit);
    const id = identity(result);
    expect(h.observations.custom).toBe(1);
    expect(h.observations.decisions).toHaveLength(1);
    expect(h.reviews()).toEqual([{ args: ["--only", expect.any(String), expect.stringMatching(/^--output=/)], exitOnAnnotations: "true" }]);
    expect(h.reviews()[0].args[1].startsWith(`${root}/`)).toBe(true);
    expect(readFileSync(h.reviews()[0].args[1], "utf8")).toBe(markdown);
    expect(h.session.getActiveToolNames().filter(name => name !== "complete_plan").sort()).toEqual(ordinary);
    const wrong = await h.call("complete_plan", completion({ ...id, revision: id.revision + 1 }));
    expect(wrong.isError).toBe(true);
    const done = await h.call("complete_plan", completion(id));
    expect(done.isError).toBe(false);
    expect(done.details).toMatchObject(id);
    expect(h.observations.custom).toBe(1);
    expect(h.session.getActiveToolNames().sort()).toEqual(ordinary);
  });

  it("compares an immutable revision and rejects completion of the older unapproved revision", async () => {
    const h = await fixture();
    await h.planning();
    h.choose("Keep planning");
    const first = identity(await h.call("submit_plan", submit));
    const firstPath = h.reviews()[0].args[1];
    h.choose("Approve Plan");
    const revisedMarkdown = `${markdown}\n## Verification\nRun the isolated contract.\n`;
    const approved = identity(await h.call("submit_plan", { ...submit, planId: first.planId, markdown: revisedMarkdown }));
    expect(approved).toEqual({ planId: first.planId, revision: first.revision + 1 });
    const review = h.reviews()[1];
    expect(review).toEqual({ args: ["--compare-old", firstPath, "--compare-new", expect.any(String), "--word-diff", expect.stringMatching(/^--output=/)], exitOnAnnotations: "true" });
    expect(readFileSync(firstPath, "utf8")).toBe(markdown);
    expect(readFileSync(review.args[3], "utf8")).toBe(revisedMarkdown);
    expect((await h.call("complete_plan", completion(first))).isError).toBe(true);
    const completed = await h.call("complete_plan", completion(approved));
    expect(completed.isError).toBe(false);
    expect(completed.details).toMatchObject(approved);
  });

  it.each(["Keep planning", "Cancel review", undefined])("clean review with choice %s never grants implementation or completion", async (choice) => {
    const h = await fixture();
    await h.planning();
    const planningTools = h.session.getActiveToolNames().sort();
    h.choose(choice);
    const id = identity(await h.call("submit_plan", submit));
    expect(h.reviews()).toHaveLength(1);
    expect(h.observations.decisions).toHaveLength(1);
    expect(h.session.getActiveToolNames().sort()).toEqual(planningTools);
    expect((await h.call("complete_plan", completion(id))).isError).toBe(true);
  });

  it("cancelled revdiff skips approval and does not enable completion", async () => {
    const h = await fixture();
    await h.planning();
    const planningTools = h.session.getActiveToolNames().sort();
    writeFileSync(join(root, "review-mode"), "cancel");
    const result = await h.call("submit_plan", submit);
    expect(h.reviews()).toHaveLength(1);
    expect(h.observations.decisions).toHaveLength(0);
    expect(h.session.getActiveToolNames().sort()).toEqual(planningTools);
    const id = identity(result);
    expect((await h.call("complete_plan", completion(id))).isError).toBe(true);
  });

  it.each(["submit_plan", "complete_plan"])("SDK refuses nested %s before UI, artifacts or state, with a live allowed parent/leaf control", async (target) => {
    const h = await fixture();
    await h.planning();
    if (target === "submit_plan") h.choose("Keep planning");
    const id = identity(await h.call("submit_plan", submit));
    const positive = await h.call("read", { target: "find", args: {} });
    expect(positive.isError).toBe(false);
    expect(positive.details).toMatchObject({ isError: false });
    expect(h.observations.bridge).toBe(1);
    expect(h.observations.leaf).toBe(1);
    expect(h.session.getToolDefinition(target)).toBeDefined();
    expect(h.session.getActiveToolNames()).toContain(target);
    const before = { state: h.state(), artifacts: h.artifacts(), reviews: h.reviews(), custom: h.observations.custom, decisions: [...h.observations.decisions] };
    const result = await h.call("read", { target, args: target === "submit_plan" ? { ...submit, planId: id.planId } : completion(id) });
    expect(h.observations.bridge).toBe(2);
    expect.soft(result.details).toMatchObject({ isError: true });
    expect.soft(h.observations.callable).not.toContain(target);
    expect.soft(h.observations.nestedWorkflowCalls).toBe(0);
    expect.soft({ state: h.state(), artifacts: h.artifacts(), reviews: h.reviews(), custom: h.observations.custom, decisions: h.observations.decisions }).toEqual(before);
  });

  it("preserves ordinary/legacy REST tools and denies unverified MCP even when explicitly activated", async () => {
    const h = await fixture();
    const ordinary = h.session.getActiveToolNames().sort();
    await h.planning();
    for (const name of ["find", "resolve-library-id", "query-docs"]) {
      expect((await h.call(name, {})).isError).toBe(false);
    }
    h.session.setActiveToolsByName([...h.session.getActiveToolNames(), "mcp__unverified__query_docs"]);
    expect((await h.call("mcp__unverified__query_docs", {})).isError).toBe(true);
    expect(h.observations.unknown).toBe(0);
    await h.normal();
    expect(h.session.getActiveToolNames().sort()).toEqual(ordinary);
  });

  it("reload, tree navigation and reopening the persisted session restore planning and ordinary tools", async () => {
    const h = await fixture();
    const ordinary = h.session.getActiveToolNames().sort();
    await h.planning();
    h.choose("Keep planning");
    const id = identity(await h.call("submit_plan", submit));
    const planningLeaf = h.manager.getLeafId()!;
    const planningTools = h.session.getActiveToolNames().sort();
    await h.normal();
    expect(h.session.getActiveToolNames().sort()).toEqual(ordinary);
    await h.session.reload();
    expect(h.session.getActiveToolNames().sort()).toEqual(ordinary);
    await h.session.navigateTree(planningLeaf, { summarize: false });
    expect(h.session.getActiveToolNames().sort()).toEqual(planningTools);
    // Persist a finalized turn on the selected branch before reopening the JSONL file.
    expect((await h.call("find", {})).isError).toBe(false);
    const path = h.manager.getSessionFile()!;
    expect(existsSync(path)).toBe(true);
    await h.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    h.session.dispose();
    sessions = sessions.filter(session => session !== h.session);
    const restored = await fixture(SessionManager.open(path));
    expect(restored.session.getActiveToolNames().sort()).toEqual(planningTools);
    expect((await restored.call("complete_plan", completion(id))).isError).toBe(true);
    await restored.normal();
    expect(restored.session.getActiveToolNames().sort()).toEqual(ordinary);
  });
});
