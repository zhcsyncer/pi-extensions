import assert from "node:assert/strict";
import test from "node:test";
import { createCodemodeExtension, initTheme, ToolExecutionComponent, SessionManager } from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { TuiMainScreen, stripTerminalSequences } from "@earendil-works/pi-tui";
import { join } from "node:path";
import { AggregateProjection, registerAggregateProjectionEvents } from "../src/aggregate-activity.ts";
import { nestedArgument } from "../src/nested-display.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG as defaults } from "../src/types.ts";
import { createDisplaySession } from "./helpers/display-session.ts";
import { AggregateTerminal } from "./helpers/aggregate-terminal.ts";

const config = { ...defaults, resultMode: "preview" as const, mcpOutputMode: "preview" as const };
const text = (component: { render(width: number): string[] }) => component.render(100).map(stripTerminalSequences).join("\n");

async function treeFixture(codemode: boolean) {
  initTheme("dark", false);
  const faux = fauxProvider({ provider: "nested-fixture", tokensPerSecond: 0 });
  const projection = new AggregateProjection();
  const events: any[] = [];
  let release!: () => void, arrived = 0;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const leaf = { name: "leaf", executionMode: "parallel", execute: async (_id, args) => {
    if (++arrived === (codemode ? 4 : 2)) release();
    await gate;
    if (args.tag.endsWith("bad")) throw new Error(`leaf rejected ${args.tag}`);
    return { content: [{ type: "text", text: "leaf output" }], details: {} };
  } };
  const bridge = { name: "bridge", executionMode: "parallel", execute: async (_id, args, _signal, _update, ctx) => {
    await Promise.all([ctx.executeTool("leaf", { tag: args.tag + "-ok" }), ctx.executeTool("leaf", { tag: args.tag + "-bad" })]);
    return { content: [{ type: "text", text: "caught child error" }], details: {} };
  } };
  const h = await createDisplaySession(config, [leaf, bridge], { factories: [
    ...(codemode ? [createCodemodeExtension({ models: false })] : []),
    pi => pi.registerProvider(faux.provider),
    pi => registerAggregateProjectionEvents(pi, projection),
  ] });
  const rootName = codemode ? "codemode" : "bridge";
  const args = codemode ? { code: 'if(false) await tools.leaf({tag:"never"}); await Promise.all([tools.bridge({tag:"A"}),tools.bridge({tag:"B"})]); return "root ok";' } : { tag: "P" };
  h.api.setActiveTools(codemode ? ["codemode", "bridge", "leaf"] : ["bridge", "leaf"]);
  await h.session.setModel(faux.getModel());
  faux.setResponses([fauxAssistantMessage(fauxToolCall(rootName, args, { id: "root" }), { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
  const tui = new TuiMainScreen(new AggregateTerminal());
  let row!: ToolExecutionComponent, secondRow!: ToolExecutionComponent, liveText = "", secondLiveText = "";
  h.session.subscribe(event => {
    if (!event.type.startsWith("tool_execution_")) return;
    const e = event as any;
    events.push(e);
    if (e.toolCallId === "root") {
      if (e.type === "tool_execution_start") {
        row = new ToolExecutionComponent(rootName, "root", args, { outputPad: 0 }, h.renderers(rootName), tui, h.cwd);
        row.setArgsComplete(); row.markExecutionStarted();
        secondRow = new ToolExecutionComponent(rootName, "root", args, { outputPad: 0 }, h.renderers(rootName), tui, h.cwd);
        secondRow.setArgsComplete(); secondRow.markExecutionStarted();
      } else if (e.type === "tool_execution_update") row.updateResult({ ...e.partialResult, isError: false }, true);
      else row.updateResult({ ...e.result, isError: e.isError, durationMs: e.durationMs });
    } else if (e.type === "tool_execution_start" && row) {
      // No root updateResult here: real nested events must invalidate the public root component.
      liveText = text(row);
      secondLiveText = text(secondRow);
    }
  });
  await h.session.prompt("offline", { expandPromptTemplates: false });
  const entries = h.session.sessionManager.getBranch();
  const messages = entries.filter(e => e.type === "message").map(e => e.message) as any[];
  const result = messages.find(m => m.role === "toolResult");
  row.setExpanded(true);
  return { h, projection, events, row, liveText, secondLiveText, entries, messages, result, rootName, args, tui };
}

for (const codemode of [true, false]) {
  test(`real ${codemode ? "three-level codemode" : "ordinary nested"} calls stay under one root before and after replay`, async t => {
    const f = await treeFixture(codemode);
    t.after(() => f.h.close());
    const expected = codemode ? 6 : 2;
    assert.equal(f.events.filter(e => e.parentToolCallId && e.type === "tool_execution_start").length, expected);
    assert.equal(f.result.nestedCalls.calls.length, expected);
    assert.equal(f.result.isError, false);
    assert.equal(f.messages.filter(m => m.role === "toolResult").length, 1);
    assert.equal(f.projection.getViewForGroup("root")?.callCount, 1);
    const output = text(f.row);
    assert.match(output, /leaf rejected/);
    assert.match(output, /\[error\]/);
    assert.match(output, /result bodies are not stored/);
    assert.match(f.liveText, /leaf/);
    if (!codemode) assert.match(f.secondLiveText, /leaf/, "both real views must refresh without root partial results");
    if (codemode) {
      // Direct bridge operations stay in the original native result, not repeated as supplement rows.
      assert.equal(output.split("\n").filter(line => /✓ bridge/.test(line)).length, 2);
      assert.ok(f.events.findIndex(e => e.toolCallId === "root/2/2" && e.type === "tool_execution_start") < f.events.findIndex(e => e.type === "tool_execution_end"));
    } else assert.equal(f.h.session.getToolDefinition("codemode"), undefined);
    f.projection.rebuild(f.entries);
    assert.equal(f.projection.getViewForGroup("root")?.callCount, 1);
    assert.match(f.projection.renderExpandedToolRow("root", 100).join("\n"), /leaf rejected/);
  });
}

test("nested argument budgets measure bounded compact JSON in UTF-8 without running tool-owned code", () => {
  const ascii = nestedArgument({ tag: "a".repeat(7000) }, 32768);
  assert.equal(ascii.bytes, 7010);
  assert.ok(ascii.text);
  assert.equal(nestedArgument({ tag: "界".repeat(3000) }, 32768).text, undefined);
  assert.equal(nestedArgument({ tag: "a".repeat(7000) }, 1000).text, undefined);
  let calls = 0;
  const unsafe = { get value() { calls++; throw new Error("getter"); }, toJSON() { calls++; throw new Error("toJSON"); } };
  assert.equal(nestedArgument(unsafe, 8192).text, undefined);
  assert.equal(calls, 0);
});

test("known native codemode receives a bounded display copy with its delegate state and unrelated metadata intact", async t => {
  initTheme("dark", false);
  const seen: any[] = [];
  const prior = new WeakMap<object, unknown>();
  const h = await createDisplaySession(config, [], { factories: [createCodemodeExtension({ models: false }), pi => {
    pi.registerToolRenderer((name, next) => {
      const delegate = next();
      if (name !== "codemode" || !delegate) return delegate;
      return { ...delegate,
        renderCall(args, theme, context) {
          context.state.seed = context.toolCallId;
          return delegate.renderCall!(args, theme, context);
        },
        renderResult(result, options, theme, context) {
          assert.equal(context.state.seed, context.toolCallId);
          assert.equal(context.lastComponent, prior.get(context.state));
          seen.push(result);
          const body = delegate.renderResult!(result, options, theme, context);
          prior.set(context.state, body);
          return body;
        },
      };
    });
  }] });
  t.after(() => h.close());
  const original = Object.freeze({ content: Object.freeze([{ type: "text", text: "original output" }]), details: Object.freeze({
    sentinel: { keep: true },
    calls: Object.freeze(Array.from({ length: 300 }, (_, i) => Object.freeze({ id: `budget/models.classify/${i + 1}`, name: "models.classify", args: "界".repeat(200), status: "ok", cost: 1 }))),
  }) });
  const row = new ToolExecutionComponent("codemode", "budget", { code: "return 1;" }, { outputPad: 0 }, h.renderers("codemode"), new TuiMainScreen(new AggregateTerminal()), h.cwd);
  row.updateResult({ ...original, isError: false } as any);
  row.setExpanded(true);
  const output = text(row);
  assert.match(output, /original output/);
  assert.match(output, /partial list/);
  assert.match(output, /visible costs only/);
  assert.match(output, /not full arguments/);
  assert.equal(original.details.calls.length, 300);
  for (const result of seen) {
    assert.equal(result.content, original.content);
    assert.equal(result.details.sentinel, original.details.sentinel);
    assert.ok(result.details.calls.length <= 256);
    const bytes = result.details.calls.map(call => Buffer.byteLength(JSON.stringify(call.args), "utf8"));
    assert.ok(bytes.every(size => size <= 8192));
    assert.ok(bytes.reduce((a, b) => a + b, 0) <= 32768);
  }
  assert.ok(seen.length >= 2);
  assert.equal(h.session.getActiveToolNames().includes("codemode"), false, "rendering must not activate codemode");
});

test("saved native records survive disk/tree/compaction selection without requiring codemode", async t => {
  const f = await treeFixture(true);
  t.after(() => f.h.close());
  const saved = SessionManager.create(f.h.cwd, join(f.h.cwd, "saved"));
  const ids = f.messages.map(message => saved.appendMessage(message));
  const reopened = SessionManager.open(saved.getSessionFile()!);
  const captured = reopened.buildSessionContext().messages.find(m => m.role === "toolResult") as any;
  assert.deepEqual(captured.nestedCalls, f.result.nestedCalls);
  const h = await createDisplaySession(config);
  t.after(() => h.close());
  for (const message of reopened.buildSessionContext().messages) h.session.sessionManager.appendMessage(message as never);
  await h.session.reload();
  const render = () => {
    const row = new ToolExecutionComponent("codemode", "root", f.args, { outputPad: 0 }, h.renderers("codemode"), new TuiMainScreen(new AggregateTerminal()), h.cwd);
    row.updateResult(captured); row.setExpanded(true);
    return text(row);
  };
  assert.match(render(), /leaf rejected/);
  assert.equal(h.session.getToolDefinition("codemode"), undefined);
  const before = ids[f.messages.findIndex(m => m.role === "assistant")];
  const tip = reopened.getLeafId()!;
  reopened.branch(before);
  f.projection.rebuild(reopened.buildContextEntries());
  assert.doesNotMatch(f.projection.renderExpandedToolRow("root", 100).join("\n"), /leaf rejected/);
  reopened.branch(tip);
  reopened.appendCompaction("keep", before, 0);
  f.projection.rebuild(reopened.buildContextEntries());
  assert.match(f.projection.renderExpandedToolRow("root", 100).join("\n"), /leaf rejected/);
  reopened.appendCompaction("drop", null, 0);
  f.projection.rebuild(reopened.buildContextEntries());
  assert.equal(f.projection.getViewForGroup("root"), undefined);
});

test("actual HTML renderer reads saved descendants outside content/details without duplicating native direct calls", async t => {
  const f = await treeFixture(true);
  t.after(() => f.h.close());
  const { createToolHtmlRenderer } = await import("../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js");
  const durations: unknown[] = [];
  const renderer = createToolHtmlRenderer({ cwd: f.h.cwd, theme: f.h.session.extensionRunner.getUIContext().theme,
    getToolRenderers: name => {
      const original = f.h.renderers(name)!;
      return { ...original, renderResult(result, options, theme, context) {
        assert.equal("nestedCalls" in result, false);
        durations.push(context.durationMs);
        return original.renderResult!(result, options, theme, context);
      } };
    },
  });
  renderer.renderCall("root", "codemode", f.args);
  const output = renderer.renderResult("root", "codemode", f.result.content, f.result.details, false)!;
  assert.match(output.expanded, /leaf rejected A-bad/);
  assert.equal((output.expanded.match(/bridge/g) ?? []).length, 2);
  assert.deepEqual(durations, [undefined, undefined]);
});

test("incomplete saved records label missing arguments, unknown parents and absent bodies without inventing cancellation or time", async t => {
  initTheme("dark", false);
  const h = await createDisplaySession(config);
  t.after(() => h.close());
  const result: any = { role: "toolResult", toolCallId: "legacy", toolName: "unknown_root", content: [], isError: false, timestamp: Date.now(), nestedCalls: {
    complete: false, calls: [
      { id: "legacy/9/1", name: "unjoined", status: "unfinished", argumentsBytes: 9000 },
      { id: "foreign-id", name: "failed", status: "error", arguments: {}, error: "aborted is just error text" },
    ],
  } };
  h.session.sessionManager.appendMessage(result);
  await h.session.extensionRunner.emit({ type: "message_start", message: result });
  const row = new ToolExecutionComponent("unknown_root", "legacy", {}, { outputPad: 0 }, h.renderers("unknown_root"), new TuiMainScreen(new AggregateTerminal()), h.cwd);
  row.updateResult(result); row.setExpanded(true);
  const output = text(row);
  assert.match(output, /at least 2 recorded/);
  assert.match(output, /incomplete/);
  assert.match(output, /arguments omitted \(9000 UTF-8 bytes\)/);
  assert.match(output, /parent unknown/);
  assert.match(output, /\[unfinished\]/);
  assert.match(output, /\[error\]/);
  assert.doesNotMatch(output, /\[cancelled\]|\b0ms\b/);
});
