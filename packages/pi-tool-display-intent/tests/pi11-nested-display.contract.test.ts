import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test, { type TestContext } from "node:test";
import { Type } from "typebox";
import {
  createAgentSession, createCodemodeExtension, DefaultResourceLoader, initTheme, ModelRuntime,
  SessionManager, SettingsManager, ToolExecutionComponent,
  type AgentSessionEvent, type CodemodeToolDetails, type ExtensionFactory, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai/providers/faux";
import type { ToolResultMessage } from "@earendil-works/pi-ai";
import { TuiMainScreen, stripTerminalSequences } from "@earendil-works/pi-tui";
import {
  AggregateProjection, patchAggregateToolExecutions, registerAggregateProjectionEvents, restoreAggregateToolExecutions,
} from "../src/aggregate-activity.ts";
import { buildDetailModel } from "../src/detail-viewer-model.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "../src/types.ts";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { AggregateTerminal } from "./helpers/aggregate-terminal.ts";

// Independent D3 contracts. Only SDK declarations, the frozen task, public observer
// signatures and generic fixtures inform these cases; no producer/probe fixtures.
const ROOT = "contract-root";
const PARTIAL = /partial|incomplete|omitt|truncat|limit|部分|不完整|省略|截断|上限/i;
const UNKNOWN = /unknown|unavailable|not (?:recorded|saved)|missing|未知|未(?:记录|保存)|缺失/i;
const ERROR = /error|fail|失败|错误|✗|✕|×/i;
const CANCELLED = /cancelled|canceled|取消|⊘/i;
const utf8 = (value: unknown) => Buffer.byteLength(JSON.stringify(value), "utf8");
const textResult = (text: string) => ({ content: [{ type: "text" as const, text }], details: undefined });
const plain = (component: ToolExecutionComponent, width = 160) => component.render(width).map(stripTerminalSequences).join("\n");

function gate() {
  let release!: () => void;
  const promise = new Promise<void>(resolve => { release = resolve; });
  return { promise, release };
}

function tool(name: string, execute: ToolDefinition["execute"], parameters = Type.Object({})): ToolDefinition {
  return { name, label: name, description: name, parameters, execute, executionMode: "parallel" };
}

class ObservedTUI extends TuiMainScreen {
  requests = 0;
  override requestRender(force?: boolean) { this.requests++; super.requestRender(force); }
}

async function fixture(t: TestContext, options: {
  layout?: "individual" | "aggregate";
  display?: boolean;
  codemode?: boolean;
  sessionFile?: string;
  tools?: ToolDefinition[];
  factories?: ExtensionFactory[];
} = {}) {
  initTheme("dark", false);
  const provider = fauxProvider({ provider: "d3-offline", models: [{ id: "scripted" }], tokensPerSecond: Infinity });
  let projection = new AggregateProjection();
  const config = { ...DEFAULT_TOOL_DISPLAY_CONFIG, toolCallLayout: options.layout ?? "aggregate" };
  // Same isolated resource setup as the generic display-session helper, with a real
  // SessionManager.open boundary for history instead of replacing agent.messages.
  const cwd = mkdtempSync(join(tmpdir(), "pi-d3-contract-"));
  const agentDir = join(cwd, "agent");
  const settingsManager = SettingsManager.inMemory({ packages: [],
    defaultTools: options.codemode === false ? [] : ["+codemode"],
    compaction: { enabled: false, keepRecentTokens: 64, reserveTokens: 128 }, retry: { enabled: false },
  });
  const errors: unknown[] = [];
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [
      ...(options.display === false ? [] : [(pi => registerToolDisplayOverrides(pi, () => config)) as ExtensionFactory]),
      pi => { for (const definition of options.tools ?? []) pi.registerTool(definition); },
      ...(options.codemode === false ? [] : [createCodemodeExtension({ models: true })]),
      pi => {
        pi.registerProvider(provider.provider);
        projection = new AggregateProjection();
        registerAggregateProjectionEvents(pi, projection, { getConfig: () => config });
      },
      ...options.factories ?? [],
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "models-cache"), allowModelNetwork: false, refreshOnCreate: false });
  const { session } = await createAgentSession({ cwd, agentDir, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager: options.sessionFile ? SessionManager.open(options.sessionFile, join(cwd, "sessions"), cwd) : SessionManager.inMemory(cwd) });
  const h = {
    cwd, session,
    renderers(name: string) { return session.extensionRunner.resolveToolRenderers(name, () => session.getToolDefinition(name)); },
    async close() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose(); rmSync(cwd, { recursive: true, force: true });
      assert.deepEqual(errors, []);
    },
  };
  await session.bindExtensions({ onError: error => errors.push(error) });
  await h.session.setModel(provider.getModel());
  const events: AgentSessionEvent[] = [];
  const ui = new ObservedTUI(new AggregateTerminal());
  const components = new Map<string, ToolExecutionComponent>();
  const unsubscribe = h.session.subscribe(event => {
    // Snapshot real events before their mutable streaming payloads can change.
    events.push(structuredClone(event));
    if (event.type === "tool_execution_start" && !event.parentToolCallId) {
      const component = new ToolExecutionComponent(event.toolName, event.toolCallId, event.args,
        { showImages: false }, h.renderers(event.toolName), ui, h.cwd);
      component.setArgsComplete();
      component.markExecutionStarted();
      component.setExpanded(true);
      components.set(event.toolCallId, component);
    }
    if (event.type === "tool_execution_update" && !event.parentToolCallId) {
      components.get(event.toolCallId)?.updateResult({ ...event.partialResult, isError: false }, true);
    }
    if (event.type === "message_start" && event.message.role === "toolResult") {
      const { toolCallId, content, details, isError, durationMs } = event.message;
      // nestedCalls deliberately is NOT smuggled into renderer content/details.
      components.get(toolCallId)?.updateResult({ content, details, isError, durationMs }, false);
    }
  });
  t.after(async () => { unsubscribe(); await h.session.abort(); projection.dispose(); await h.close(); });
  return {
    ...h, provider, events, components, ui,
    get projection() { return projection; },
    async run(code: string, name = "codemode", args: Parameters<typeof fauxToolCall>[1] = { code }) {
      provider.setResponses([
        fauxAssistantMessage(fauxToolCall(name, args, { id: ROOT }), { stopReason: "toolUse" }),
        fauxAssistantMessage("Offline run finished."),
      ]);
      await h.session.prompt("Execute the offline contract fixture.");
    },
    root() {
      const results = h.session.messages.filter((m): m is ToolResultMessage<CodemodeToolDetails> => m.role === "toolResult");
      assert.equal(results.length, 1, "fixture: nested calls must not become top-level transcript results");
      return results[0];
    },
    component() { const c = components.get(ROOT); assert.ok(c, "fixture: real root component exists"); return c; },
    restoredComponent(result: ToolResultMessage, code: string) {
      const c = new ToolExecutionComponent(result.toolName, result.toolCallId, { code }, { showImages: false },
        h.renderers(result.toolName), ui, h.cwd);
      c.setArgsComplete(); c.markExecutionStarted();
      c.updateResult({ content: result.content, details: result.details, isError: result.isError, durationMs: result.durationMs });
      c.setExpanded(true); c.invalidate();
      return c;
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function starts(h: Fixture) {
  return h.events.filter((e): e is Extract<AgentSessionEvent, { type: "tool_execution_start" }> => e.type === "tool_execution_start");
}
function count(h: Fixture) {
  const view = h.projection.getViewForGroup(ROOT);
  assert.ok(view, "the real root has an aggregate view");
  return view.callCount;
}
function parallelTree(hold = gate()) {
  const ready = gate();
  let entered = 0;
  const leaf: ToolDefinition["execute"] = async (_id, _args, _signal, onUpdate) => {
    onUpdate?.(textResult("leaf is running"));
    if (++entered === 5) ready.release();
    await hold.promise;
    return textResult("CHILD_RESULT_NOT_PERSISTED");
  };
  const tools = [
    tool("leaf_left", leaf), tool("leaf_right", leaf), tool("direct_child", leaf),
    ...["left", "right"].map(side => tool(`branch_${side}`, async (_id, _args, _signal, _update, ctx) => {
      await Promise.all([ctx.executeTool(`leaf_${side}`, {}), ctx.executeTool(`leaf_${side}`, {})]);
      return textResult("branch finished");
    })),
    tool("never_executed", async () => { throw new Error("unreachable source ran"); }),
  ];
  const code = `if (false) await tools.never_executed({});\nawait Promise.all([tools.branch_left({}), tools.branch_right({}), tools.direct_child({})]); return "ROOT_ONLY_OUTPUT";`;
  return { tools, code, ready: ready.promise, release: hold.release };
}

for (const display of [false, true]) {
  test(`D3 ${display ? "display" : "SDK control"}: real parallel parent chains and one aggregate root`, { timeout: 20_000 }, async t => {
    const tree = parallelTree();
    t.after(tree.release);
    const h = await fixture(t, { display, tools: tree.tools });
    const running = h.run(tree.code);
    await tree.ready;
    // Let already emitted execution events reach extension observers, without a timed sleep.
    await new Promise<void>(resolve => setImmediate(resolve));
    const actual = starts(h);
    assert.equal(actual.length, 8, "fixture: one root and seven actual descendants");
    assert.equal(actual.filter(e => !e.parentToolCallId).length, 1);
    assert.equal(new Set(actual.map(e => e.toolCallId)).size, 8);
    for (const child of actual.filter(e => e.parentToolCallId)) {
      const parent = actual.find(e => e.toolCallId === child.parentToolCallId);
      assert.ok(parent, "fixture: a direct parent, not a guessed root, exists");
      assert.ok(child.toolCallId.startsWith(`${parent.toolCallId}/`));
      if (child.toolName.startsWith("leaf_")) assert.match(parent.toolName, /^branch_/);
    }
    assert.ok(!actual.some(e => e.toolName === "never_executed"));
    const progress = h.events.filter(e => e.type === "tool_execution_update" && e.toolCallId === ROOT);
    assert.ok(progress.some(e => {
      if (e.type !== "tool_execution_update") return false;
      const running = (e.partialResult.details as CodemodeToolDetails)?.calls.filter(c => c.status === "running") ?? [];
      return running.length >= 2 && new Set(running.map(c => c.id)).size < running.length;
    }), "fixture: simultaneous native placeholders really share IDs; they are not execution identities");
    const liveCount = display ? count(h) : undefined;
    tree.release(); await running;
    const root = h.root();
    assert.equal(root.isError, false);
    assert.equal(root.nestedCalls?.calls.length, 7);
    assert.equal(root.details?.calls.length, 3, "native direct progress and persisted descendants are distinct sources");
    assert.ok(root.nestedCalls?.calls.every(c => !("content" in c) && !("parentToolCallId" in c)));
    const nestedEvents = h.events.filter(e => (e.type === "tool_execution_update" || e.type === "tool_execution_end") && e.parentToolCallId);
    assert.ok(nestedEvents.some(e => e.type === "tool_execution_update"));
    assert.equal(nestedEvents.filter(e => e.type === "tool_execution_end").length, 7);
    for (const event of nestedEvents) {
      if (event.type === "tool_execution_update" || event.type === "tool_execution_end") {
        assert.equal(event.parentToolCallId, actual.find(start => start.toolCallId === event.toolCallId)?.parentToolCallId);
      }
    }
    if (!display) return;
    await t.test("live count does not count descendants or duplicate placeholders", () => assert.equal(liveCount, 1));
    await t.test("final count does not add details.calls and nestedCalls", () => assert.equal(count(h), 1));
    await t.test("expanded root reveals actual grandchildren", () => {
      const output = plain(h.component());
      assert.match(output, /leaf_left/); assert.match(output, /leaf_right/);
      assert.doesNotMatch(output.split("\n").filter(line => !line.includes("tools.")).join("\n"), /never_executed/);
    });
    await t.test("rebuild agrees with live root identity", () => {
      h.projection.rebuild(h.session.sessionManager.getBranch(), h.session.messages);
      assert.equal(count(h), 1);
    });
  });
}

for (const scenario of ["caught", "outer-failure", "cancel"] as const) {
  test(`D3 truthful state: ${scenario}`, { timeout: 20_000 }, async t => {
    const entered = gate();
    const h = await fixture(t, { layout: "individual", tools: [
      tool("successful_child", async () => textResult("ok")),
      // The word cancelled is deliberately in an ordinary failure, not an abort signal.
      tool("failed_child", async () => { throw new Error("cancelled is a data label, not cancellation"); }),
      tool("waiting_child", async (_id, _args, signal) => {
        entered.release();
        await new Promise<void>(resolve => {
          if (signal?.aborted) resolve(); else signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        throw new Error("fixture stopped");
      }),
    ] });
    const code = scenario === "cancel" ? "await tools.successful_child({}); await tools.waiting_child({});"
      : `await Promise.allSettled([tools.successful_child({}), tools.failed_child({})]); ${scenario === "outer-failure" ? 'throw new Error("outer failure");' : 'return "script recovered";'}`;
    const running = h.run(code);
    if (scenario === "cancel") { await entered.promise; await h.session.abort(); }
    await running;
    const root = h.root();
    assert.equal(root.isError, scenario !== "caught", "fixture: authoritative outer outcome");
    const calls = root.details?.calls ?? [];
    assert.equal(calls.find(c => c.name === "successful_child")?.status, "ok");
    const badName = scenario === "cancel" ? "waiting_child" : "failed_child";
    assert.equal(calls.find(c => c.name === badName)?.status, scenario === "cancel" ? "cancelled" : "error");
    await t.test("visible child state is not replaced by the root outcome", () => {
      const lines = plain(h.component()).split("\n");
      const line = lines.find(l => l.includes(badName) && !l.includes("tools."));
      assert.ok(line, `missing actual ${badName}`);
      // A name such as failed_child is not itself evidence of an error state.
      const state = line.replace(badName, "").split("cancelled is a data label")[0];
      assert.match(state, scenario === "cancel" ? CANCELLED : ERROR);
      if (scenario !== "cancel") assert.doesNotMatch(state, CANCELLED);
    });
  });
}

function classifierFactory(): ExtensionFactory {
  return pi => pi.registerProvider("d3-classifier", {
    apiKey: "offline-fixture", // Local implementation below; no transport or account.
    models: [{ type: "classifier", id: "labels", name: "Offline labels", api: "d3-classify",
      baseUrl: "http://127.0.0.1", input: ["text"], contextWindow: 4096,
      cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
    classifiers: { "d3-classify": { classify: async () => ({
      provider: "d3-classifier", model: "labels", api: "d3-classify", timestamp: Date.now(), answers: { yes: { type: "bool", probability: 1 } },
      stopReason: "stop", usage: { input: 3, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 4,
        cost: { input: 0.125, output: 0, cacheRead: 0, cacheWrite: 0, total: 0.125 } },
    }) } },
  });
}
const classifyCode = 'await models.classify({provider:"d3-classifier",id:"labels"}, {state:{},questions:{yes:{type:"bool",instructions:"offline",criteria:{true:"yes",false:"no"}}}});';

test("D3 models and unexecuted source are not tools; display does not change usage or model input", { timeout: 20_000 }, async t => {
  const h = await fixture(t, { factories: [classifierFactory()], tools: [
    tool("never_executed", async () => { throw new Error("unreachable"); }),
  ] });
  await h.run(`if (false) await tools.never_executed({}); ${classifyCode} return "CLASSIFIED";`);
  const root = h.root();
  assert.equal(root.isError, false, "fixture: the offline classifier executes successfully");
  assert.equal(starts(h).length, 1);
  assert.ok(root.details?.calls.some(c => c.name.startsWith("models.") && c.cost === 0.125));
  assert.equal(root.usage?.cost.total, 0.125);
  assert.equal(root.nestedCalls?.calls.length ?? 0, 0);
  const before = structuredClone(h.session.messages);
  const stats = h.session.getSessionStats();
  h.component().setExpanded(false); plain(h.component());
  h.component().setExpanded(true); h.component().invalidate(); plain(h.component());
  assert.equal(count(h), 1);
  assert.deepEqual(h.session.messages, before);
  assert.deepEqual(h.session.getSessionStats(), stats);
  assert.equal(stats.cost, before.filter(m => m.role === "assistant" || m.role === "toolResult")
    .reduce((total, m) => total + (m.usage?.cost.total ?? 0), 0), "nested usage is counted once");
});

for (const layout of ["individual", "aggregate"] as const) {
  test(`D3 ${layout}: real root invalidation reveals a late grandchild without a new root result`, { timeout: 20_000 }, async t => {
    const begin = gate(), finished = gate(), childStarted = gate();
    t.after(() => { begin.release(); finished.release(); });
    const h = await fixture(t, { layout, tools: [
      tool("late_leaf", async () => { childStarted.release(); await finished.promise; return textResult("leaf done"); }),
      tool("silent_parent", async (_id, _args, _signal, _update, ctx) => {
        await begin.promise; await ctx.executeTool("late_leaf", {}); return textResult("parent done");
      }),
    ] });
    const rootReady = gate();
    const unsub = h.session.subscribe(e => { if (e.type === "tool_execution_start" && e.toolName === "silent_parent") rootReady.release(); });
    t.after(unsub);
    const running = h.run('await tools.silent_parent({}); return "done";');
    await rootReady.promise;
    const c = h.component();
    plain(c);
    const previous = h.ui.requests;
    const rootUpdates = () => h.events.filter(e => e.type === "tool_execution_update" && e.toolCallId === ROOT).length;
    const beforeUpdates = rootUpdates();
    begin.release(); await childStarted.promise;
    await new Promise<void>(resolve => setImmediate(resolve));
    const requests = h.ui.requests;
    const updateCount = rootUpdates();
    const live = plain(c);
    // Public component invalidation must also keep the same root's metadata connected.
    c.invalidate(); const refreshed = plain(c);
    finished.release(); await running;
    assert.equal(updateCount, beforeUpdates, "fixture: no native root progress packet explains the redraw");
    await t.test("nested event invalidates the owning real root", () => assert.ok(requests > previous));
    await t.test("same root shows new actual activity before it finishes", () => {
      assert.match(live, /late_leaf/); assert.match(refreshed, /late_leaf/);
    });
  });
}

function argumentOfBytes(bytes: number, label: string) {
  const base = { payload: label };
  const remaining = bytes - utf8(base);
  assert.ok(remaining >= 0);
  return { payload: label + "😀".repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4) };
}

for (const layout of ["individual", "aggregate"] as const) {
  test(`D3 ${layout}: whole native nested display is bounded in UTF-8, execution and costs are not clipped`, { timeout: 40_000 }, async t => {
    const inputs = [argumentOfBytes(8192, "boundary_kept"), argumentOfBytes(8193, "boundary_over"),
      ...Array.from({ length: 256 }, (_, i) => argumentOfBytes(2048, `record_${String(i).padStart(3, "0")}`))];
    const executed: unknown[] = [];
    let nativeView: CodemodeToolDetails | undefined;
    let nativeDuration: number | undefined;
    const observeNative: ExtensionFactory = pi => pi.registerToolRenderer((name, next) => {
      const renderer = next();
      if (name !== "codemode" || !renderer?.renderResult) return renderer;
      const renderResult = renderer.renderResult;
      return { ...renderer, renderResult(result, options, theme, context) {
        if (!options.isPartial) { nativeView = structuredClone(result.details); nativeDuration = context.durationMs; }
        return renderResult(result, options, theme, context);
      } };
    });
    const h = await fixture(t, { layout, factories: [classifierFactory(), observeNative], tools: [
      tool("budget_child", async (_id, args) => { executed.push(structuredClone(args)); return textResult("discarded"); }, Type.Object({ payload: Type.String() })),
    ] });
    const code = `${classifyCode}\nfor (let i = 0; i < 258; i++) {
      const bytes = i === 0 ? 8192 : i === 1 ? 8193 : 2048;
      const label = i === 0 ? "boundary_kept" : i === 1 ? "boundary_over" : "record_" + String(i - 2).padStart(3, "0");
      const remaining = bytes - JSON.stringify({payload:label}).length;
      await tools.budget_child({payload:label + "😀".repeat(Math.floor(remaining / 4)) + "x".repeat(remaining % 4)});
    }\n${classifyCode}\nreturn "BUDGET_ROOT";`;
    await h.run(code);
    const root = h.root();
    assert.equal(root.isError, false);
    assert.deepEqual(executed, inputs, "fixture: all original UTF-8 arguments execute unchanged");
    assert.equal(utf8(inputs[0]), 8192); assert.equal(utf8(inputs[1]), 8193);
    assert.ok(JSON.stringify(inputs[1]).length < 8192, "fixture distinguishes UTF-8 bytes from D2 UTF-16 units");
    assert.equal(root.details?.calls.length, 260, "fixture: original native progress remains unbounded");
    assert.equal(root.nestedCalls?.calls.length, 256);
    assert.equal(root.nestedCalls?.complete, false);
    assert.deepEqual(root.nestedCalls?.calls[0].arguments, inputs[0]);
    assert.equal(root.nestedCalls?.calls[1].arguments, undefined);
    assert.ok(root.nestedCalls!.calls.reduce((n, c) => n + (c.arguments ? utf8(c.arguments) : 0), 0) <= 32768);
    const original = structuredClone(root);
    const stats = h.session.getSessionStats();
    const output = plain(h.component());
    h.component().setExpanded(false); plain(h.component());
    h.component().setExpanded(true); h.component().invalidate(); plain(h.component());
    assert.deepEqual(root, original, "display copies must not mutate the result seen by persistence or model context");
    assert.equal(nativeDuration, root.durationMs, "native root duration is preserved, not replaced with a sum of child durations");
    assert.deepEqual(h.session.getSessionStats(), stats);
    assert.equal(root.usage?.cost.total, 0.25);
    await t.test("known native renderer receives a bounded read-only display view", () => {
      assert.ok(nativeView?.calls.length, "native renderer delegation is retained");
      assert.ok(nativeView.calls.length <= 256, `native list has ${nativeView.calls.length} records`);
      assert.ok(nativeView.calls.every(c => Buffer.byteLength(c.args, "utf8") <= 8192));
      assert.ok(nativeView.calls.reduce((n, c) => n + Buffer.byteLength(c.args, "utf8"), 0) <= 32768,
        "native preview strings alone must not bypass the whole-display byte budget");
    });
    await t.test("native and projected lists together do not render more than 256 records", () => {
      const rows = output.split("\n").filter(line => !/\bawait\b/.test(line) && /budget_child|models\.classify/.test(line));
      assert.ok(rows.length > 0 && rows.length <= 256, `${rows.length} visible nested records`);
    });
    await t.test("omitted list and displayed cost are explicitly partial", () => {
      assert.ok(PARTIAL.test(output), "truncated display explicitly describes the list as partial");
      const scope = output.split("\n").filter(line => /cost|\$|费用|成本/i.test(line)).join("\n");
      assert.match(scope, PARTIAL, "clipped native cost is not presented as complete execution cost");
    });
  });
}

for (const history of ["intact", "missing-parent", "foreign-prefix"] as const) {
  test(`D3 saved ${history}: non-UI reload and HTML use recorded metadata, never current file contents`, { timeout: 20_000 }, async t => {
    const code = 'await tools.archive_parent({}); return "ARCHIVE_ROOT";';
    let compactionHooks = 0;
    const compactFactory: ExtensionFactory = pi => { pi.on("session_before_compact", event => {
      const first = event.branchEntries.find(e => e.type === "message" && e.message.role === "assistant"
        && e.message.content.some(block => block.type === "toolCall" && block.id === ROOT));
      assert.ok(first);
      compactionHooks++;
      return { compaction: { summary: "Offline summary of the user request.", firstKeptEntryId: first.id,
        tokensBefore: event.preparation.tokensBefore } };
    }); };
    const h = await fixture(t, { tools: [tool("archive_parent", async (_id, _args, _signal, _update, ctx) => {
      await ctx.executeTool("read", { path: "historical.txt" });
      return textResult("parent result only");
    })] });
    writeFileSync(join(h.cwd, "historical.txt"), "OLD_CHILD_BODY_NOT_RECORDED");
    // A real prior turn makes manual compaction meaningful, without a model service.
    h.provider.setResponses([fauxAssistantMessage("Prelude acknowledged.")]);
    await h.session.prompt("Earlier context. ".repeat(128));
    await h.run(code);
    const original = h.root();
    assert.deepEqual(original.nestedCalls?.calls.map(c => c.name), ["archive_parent", "read"]);
    assert.ok(!JSON.stringify(original.nestedCalls).includes("OLD_CHILD_BODY_NOT_RECORDED"));
    const saved = h.session.exportToJsonl(join(h.cwd, "saved.jsonl"));
    const reopened = SessionManager.open(saved, join(h.cwd, "saved-sessions"));
    assert.deepEqual(reopened.buildSessionContext().messages.filter(m => m.role === "toolResult"), [JSON.parse(JSON.stringify(original))]);
    writeFileSync(join(h.cwd, "historical.txt"), "CURRENT_FILE_MUST_NOT_BECOME_OLD_RESULT");

    let path = saved;
    if (history !== "intact") {
      // Simulate a documented lossy/legacy saved record, not invented execution events.
      // Keep only the real read record; a syntactic ID prefix is not proof of a parent.
      const lossy = SessionManager.create(h.cwd, join(h.cwd, "legacy-sessions"));
      for (const message of reopened.buildSessionContext().messages) {
        if (message.role === "toolResult") {
          const leaf = structuredClone(message.nestedCalls!.calls.find(c => c.name === "read")!);
          if (history === "foreign-prefix") leaf.id = `${ROOT}-different/1/1`;
          delete leaf.durationMs; delete leaf.arguments;
          leaf.status = "unfinished";
          // Error words do not grant an unfinished historical record a cancelled state.
          leaf.error = "cancelled is an old diagnostic, not a state";
          lossy.appendMessage({ ...message, details: undefined, durationMs: undefined,
            nestedCalls: { complete: false, calls: [leaf] } });
        } else if (message.role === "user" || message.role === "assistant" || message.role === "system") {
          lossy.appendMessage(message);
        }
      }
      path = lossy.getSessionFile()!;
    }
    const resumed = await fixture(t, { sessionFile: path, factories: [compactFactory] });
    writeFileSync(join(resumed.cwd, "historical.txt"), "CURRENT_FILE_MUST_NOT_BECOME_OLD_RESULT");
    await resumed.session.reload();
    const restored = resumed.root();
    const c = resumed.restoredComponent(restored, code);
    const output = plain(c);
    const exported = await resumed.session.exportToHtml(join(resumed.cwd, `history-${history}.html`));
    const html = readFileSync(exported, "utf8");
    const base64 = html.match(/<script id="session-data" type="application\/json">([A-Za-z0-9+/=]+)<\/script>/)?.[1];
    assert.ok(base64, "fixture: SDK HTML has an embedded session payload");
    const data = JSON.parse(Buffer.from(base64, "base64").toString("utf8"));
    const rendered = data.renderedTools?.[ROOT]?.resultHtmlExpanded?.replace(/<[^>]+>/g, "") ?? "";
    const exportedRoot = data.entries.find((e: { type: string; message?: ToolResultMessage }) =>
      e.type === "message" && e.message?.role === "toolResult")?.message;
    assert.ok(exportedRoot, "fixture: real exporter kept the root result");
    assert.equal(starts(h).length, 3);
    assert.equal(starts(resumed).length, 0, "reload/render/export must not re-execute tools");
    assert.doesNotMatch(output, /CURRENT_FILE_MUST_NOT_BECOME_OLD_RESULT|OLD_CHILD_BODY_NOT_RECORDED/);
    await t.test("root metadata is available without hasUI", () => {
      assert.equal(count(resumed), 1);
      assert.match(output, /\bread\b/);
      if (history !== "intact") {
        assert.match(output, PARTIAL); assert.match(output, UNKNOWN);
        const records = output.split("\n").filter(l => !l.includes("tools.")).join("\n");
        assert.doesNotMatch(records, /archive_parent/, "a missing or foreign-prefix ancestor is not fabricated");
        assert.doesNotMatch(records, /\b0\s*ms\b/, "missing time is not zero duration");
        const readLine = records.split("\n").find(line => /\bread\b/.test(line))!;
        assert.doesNotMatch(readLine.split("cancelled is an old diagnostic")[0], CANCELLED,
          "unfinished history is not cancelled merely because its diagnostic says so");
      }
    });
    await t.test("HTML preserves saved nested data and does not fabricate bodies or timing", () => {
      assert.deepEqual(exportedRoot.nestedCalls, restored.nestedCalls);
      assert.doesNotMatch(rendered, /CURRENT_FILE_MUST_NOT_BECOME_OLD_RESULT|OLD_CHILD_BODY_NOT_RECORDED/);
      if (history !== "intact") {
        assert.doesNotMatch(rendered, /\b0\s*ms\b/);
        assert.doesNotMatch(rendered, /archive_parent/);
      }
    });
    if (history === "intact") {
      await t.test("tree navigation and real compaction retain one root and known descendants", async () => {
        const entries = resumed.session.sessionManager.getBranch();
        const firstUser = entries.find(e => e.type === "message" && e.message.role === "user")!;
        const leaf = resumed.session.sessionManager.getLeafId()!;
        await resumed.session.navigateTree(firstUser.id, { summarize: false });
        assert.equal(resumed.projection.getViewForGroup(ROOT), undefined);
        await resumed.session.navigateTree(leaf, { summarize: false });
        assert.equal(count(resumed), 1);
        // This short tail needs a one-token cut point; 64 retains the entire earlier user turn.
        resumed.session.settingsManager.applyOverrides({ compaction: { keepRecentTokens: 1 } });
        await resumed.session.compact();
        assert.equal(compactionHooks, 1, "fixture: real compaction ran the public hook once");
        assert.equal(resumed.session.sessionManager.getBranch().filter(e => e.type === "compaction").length, 1);
        const compactedFile = resumed.session.exportToJsonl(join(resumed.cwd, "compacted.jsonl"));
        const afterCompact = await fixture(t, { sessionFile: compactedFile });
        assert.equal(afterCompact.session.sessionManager.getBranch().filter(e => e.type === "compaction").length, 1);
        assert.equal(count(afterCompact), 1);
        assert.deepEqual(afterCompact.root().nestedCalls, original.nestedCalls);
        assert.equal(starts(afterCompact).length, 0);
        assert.match(plain(afterCompact.restoredComponent(afterCompact.root(), code)), /\bread\b/);
      });
      await t.test("old nested history works without loading codemode", async () => {
        const unloaded = await fixture(t, { codemode: false, sessionFile: saved });
        await unloaded.session.reload();
        assert.equal(unloaded.session.getToolDefinition("codemode"), undefined);
        assert.ok(!unloaded.session.getActiveToolNames().includes("codemode"));
        assert.match(plain(unloaded.restoredComponent(unloaded.root(), code)), /\bread\b/);
        assert.equal(starts(unloaded).length, 0);
      });
    }
  });
}

test("D3 unloaded codemode: ordinary tool execution neither enables codemode nor MCP", { timeout: 20_000 }, async t => {
  const h = await fixture(t, { codemode: false, tools: [tool("ordinary_child", async () => textResult("ordinary result"))] });
  assert.ok(!h.session.getActiveToolNames().includes("codemode"));
  assert.equal(h.session.getToolDefinition("codemode"), undefined);
  await h.run("", "ordinary_child", {});
  assert.equal(h.root().isError, false);
  assert.equal(starts(h).length, 1);
  assert.equal(count(h), 1);
  assert.match(plain(h.component()), /ordinary/);
  assert.ok(!h.session.getActiveToolNames().some(name => name === "codemode" || name.startsWith("mcp__")));
});

// Read JSON string fields from the displayed text, not the request or a private
// model cache. This also works when an explicitly marked Raw preview cuts JSON short.
function displayedDetailStrings(text: string, field: "id" | "args") {
  const pattern = new RegExp(`"${field}"\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`, "g");
  return Array.from(text.matchAll(pattern), match => JSON.parse(match[1]) as string);
}

for (const scenario of [
  { label: "record count", calls: 258, name: "detail_count_child", args: {}, sourceArgs: "{}" },
  { label: "multibyte arguments", calls: 100, name: "detail_bytes_child", args: { tag: "界".repeat(200) }, sourceArgs: '{tag:"界".repeat(200)}' },
]) {
  test(`D3 aggregate clicked Metadata/Raw: ${scenario.label}`, { timeout: 30_000 }, async t => {
    const executed: unknown[] = [];
    const h = await fixture(t, { layout: "aggregate", tools: [
      tool(scenario.name, async (_id, args) => {
        executed.push(structuredClone(args));
        return textResult("nested result not retained");
      }, scenario.name === "detail_bytes_child" ? Type.Object({ tag: Type.String() }) : Type.Object({})),
    ] });
    patchAggregateToolExecutions(h.projection);
    t.after(() => restoreAggregateToolExecutions());
    const opened: ReturnType<typeof buildDetailModel>[] = [];
    const code = `for (let i = 0; i < ${scenario.calls}; i++) await tools.${scenario.name}(${scenario.sourceArgs}); return "DETAILS_DONE";`;
    await h.run(code);
    const root = h.root();
    assert.equal(root.isError, false, "fixture: native script succeeds");
    assert.equal(starts(h).filter(event => event.parentToolCallId === ROOT).length, scenario.calls);
    assert.deepEqual(executed, Array.from({ length: scenario.calls }, () => scenario.args));
    assert.equal(root.details?.calls.length, scenario.calls, "fixture: original native calls are not clipped");
    if (scenario.calls === 258) {
      assert.equal(root.nestedCalls?.calls.length, 256);
      assert.equal(root.nestedCalls?.complete, false);
    } else {
      assert.ok(root.details!.calls.reduce((total, call) => total + utf8(call.args), 0) > 32768,
        "fixture: compact-JSON UTF-8 argument bytes exceed the total budget");
      assert.ok(root.details!.calls.reduce((total, call) => total + JSON.stringify(call.args).length, 0) < 32768,
        "fixture: UTF-16 length alone would miss this regression");
    }
    const before = structuredClone({ root, executed, messages: h.session.messages,
      branch: h.session.sessionManager.getBranch(), usage: h.session.getSessionStats() });
    h.projection.rebuild(h.session.sessionManager.getBranch(), h.session.messages);
    h.projection.setDetailOpener(async request => { opened.push(buildDetailModel(request)); });
    const component = h.component();
    component.setExpanded(true);
    component.invalidate();
    const width = 160;
    const rendered = component.render(width).map(stripTerminalSequences);
    // Select the executable root row, not the Run heading's tool-name summary.
    const rootRow = rendered.findIndex(line => /\bcodemode\(/.test(line));
    assert.ok(rootRow >= 0, "fixture: expanded aggregate exposes the actual codemode root row");
    const handled = component.handleMouse({ type: "click", button: "left", x: 8, y: rootRow, screenX: 8, screenY: rootRow,
      width, height: rendered.length, shift: false, alt: false, ctrl: false });
    assert.equal(handled?.handled, true, "fixture: the real root click is handled");
    await new Promise<void>(resolve => setImmediate(resolve));
    assert.equal(opened.length, 1, "fixture: the real click opens one detail request");
    const metadata = opened[0].tabs.find(tab => tab.id === "details");
    assert.ok(metadata, "fixture: the real request provides a Metadata tab");
    assert.deepEqual({ root, executed, messages: h.session.messages,
      branch: h.session.sessionManager.getBranch(), usage: h.session.getSessionStats() }, before,
    "opening details must not truncate execution arguments, original results, saved history or usage");

    for (const [surface, text] of [["Metadata", metadata.text], ["Raw", metadata.rawText]] as const) {
      const ids = displayedDetailStrings(text, "id");
      const argumentsShown = displayedDetailStrings(text, "args")
        .filter(value => !/^\[?(?:arguments?\s+omitted|参数(?:已)?省略)/i.test(value));
      assert.ok(ids.length > 0, `fixture: ${surface} exposes real call records`);
      assert.ok(ids.every(id => root.details!.calls.some(call => call.id === id)),
        `${surface} must not fabricate call identities`);
      assert.ok(argumentsShown.every(args => root.details!.calls.some(call => call.args === args)),
        `${surface} retained argument previews stay faithful to actual native data`);
      await t.test(`${surface}: record scope stays within 256 calls`, () => {
        assert.ok(ids.length <= 256, `${surface} displays ${ids.length} call records`);
      });
      await t.test(`${surface}: compact-JSON UTF-8 arguments stay within 8192/32768 bytes`, () => {
        assert.ok(argumentsShown.every(args => utf8(args) <= 8192), `${surface} exceeds the per-argument byte budget`);
        const bytes = argumentsShown.reduce((total, args) => total + utf8(args), 0);
        assert.ok(bytes <= 32768, `${surface} displays ${bytes} argument bytes`);
      });
      await t.test(`${surface}: omitted nested data is explicitly marked`, () => {
        assert.ok(PARTIAL.test(text), `${surface} must label omitted nested data, including in Raw mode`);
      });
    }
  });
}
