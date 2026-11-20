import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AggregateProjection, patchAggregateToolExecutions, restoreAggregateToolExecutions } from "../src/aggregate-activity.ts";
import { buildDetailModel, DETAIL_LIMITS, type DetailRequest, type NestedCallRecord } from "../src/detail-viewer-model.ts";
import { DetailViewer } from "../src/detail-viewer.ts";
import { fullscreen } from "./helpers/aggregate-terminal.ts";

const clean = (rows: string[]) => rows.map(stripTerminalSequences).join("\n");
const plain = { fg: (_: string, text: string) => text };
const record = (overrides: Partial<NestedCallRecord> = {}): NestedCallRecord => ({
  id: "root/1", name: "bash", kind: "tool", status: "ok", parentId: "root",
  args: JSON.stringify({ command: "printf 'first'\n  printf 'second'", timeout: 12 }), durationMs: 12, ...overrides,
});
const nested = (call: NestedCallRecord): DetailRequest => ({ kind: "nested", rootToolCallId: "root", call });
const viewer = (request: DetailRequest) => new DetailViewer(buildDetailModel(request), { getHeight: () => 30, onClose() {}, onRender() {} });
const info = (request: DetailRequest) => JSON.parse(buildDetailModel(request).tabs.find(tab => tab.id === "call-info")!.rawText);
const click = (width: number, y: number, height: number): TuiMouseEvent => ({
  type: "click", button: "left", x: width - 1, y, screenX: width - 1, screenY: y,
  width, height, shift: false, ctrl: false, alt: false,
});

test("codemode starts on highlighted Script, with independent Raw state and Metadata returning to Script", () => {
  initTheme("dark", false);
  const request: DetailRequest = { kind: "tool", toolName: "codemode", args: { code: "const value = 2 + 3;\ntext(value);" },
    result: { content: [{ type: "text", text: '{"answer":5}' }], details: { elapsed: 1 } } };
  const component = viewer(request);
  const initial = component.render(100);
  assert.match(clean(initial), /\[Script\]/);
  assert.match(clean(initial), /const value = 2 \+ 3;/);
  const code = initial.find(line => stripTerminalSequences(line).includes("const value"))!;
  assert.match(code, /\x1b\[[\d;]+mconst/);
  component.handleInput("m");
  assert.match(clean(component.render(100)), /\[Metadata\]/);
  component.handleInput("m");
  assert.deepEqual(component.render(100), initial);
  component.handleInput("r");
  assert.match(clean(component.render(100)), /"code":/);
  component.handleInput("\t");
  assert.match(clean(component.render(100)), /\[Output\]/);
  assert.doesNotMatch(clean(component.render(100)), /\[Raw\]/);
  component.handleInput("r");
  assert.match(clean(component.render(100)), /\{"answer":5\}/);
  component.handleInput("\t");
  assert.match(clean(component.render(100)), /\[Script\].*\[Raw\]/);
  assert.match(clean(viewer({ ...request, toolName: "custom" }).render(100)), /\[Result\]/);
});

test("a child has recorded Args and Call info, never a fabricated Result or write/edit diff", () => {
  initTheme("dark", false);
  const request = nested(record({ status: "error", error: "command rejected", cost: 0.025 }));
  const before = structuredClone(request);
  const component = viewer(request);
  assert.deepEqual(component.model.tabs.map(tab => tab.id), ["args", "call-info"]);
  assert.equal(component.model.tabs[0].fields?.[0].language, "bash");
  assert.deepEqual(JSON.parse(component.model.tabs[0].rawText), JSON.parse(before.kind === "nested" ? before.call.args! : ""));
  assert.match(clean(component.render(100)), /\[Args\]/);
  assert.match(clean(component.render(100)), /printf 'first'/);
  component.handleInput("\t");
  assert.match(clean(component.render(100)), /\[Call info\]/);
  assert.match(clean(component.render(100)), /command rejected/);
  const metadata = info(request);
  assert.deepEqual([metadata.tool, metadata.status, metadata.durationMs, metadata.cost, metadata.parentCallId, metadata.rootToolCallId],
    ["bash", "error", 12, 0.025, "root", "root"]);
  assert.match(metadata.returnContent, /Call record only/);
  assert.deepEqual(request, before);
  for (const name of ["write", "edit"]) {
    const model = buildDetailModel(nested(record({ name, args: '{"path":"file.ts","content":"not a result"}' })));
    assert.ok(model.tabs.every(tab => tab.id !== "result" && tab.diff === undefined));
  }
});

test("preview, missing and unparseable arguments stay truthful and model-call metadata remains available", () => {
  const preview = '  {"command":"preview, not complete parameters"}\n  ';
  const request = nested(record({ kind: "model", name: "models.classify", preview: true, args: preview, status: "cancelled", cost: 0, parentId: undefined }));
  const page = buildDetailModel(request).tabs[0];
  assert.equal(page.label, "Args preview");
  assert.equal(page.presentation, "text");
  assert.equal(page.text, preview);
  assert.equal(page.rawText, preview);
  assert.equal(page.fields, undefined);
  const metadata = info(request);
  assert.equal(metadata.cost, 0);
  assert.equal(metadata.kind, "model");
  assert.equal(metadata.status, "cancelled");
  assert.equal(metadata.parentCallId, "unavailable");
  for (const argumentBytes of [undefined, 9000]) {
    const missing = nested(record({ args: undefined, argumentBytes, durationMs: undefined }));
    assert.match(buildDetailModel(missing).tabs[0].text, /not retained or are unavailable/);
    assert.equal(info(missing).durationMs, undefined);
    assert.equal(info(missing).argumentBytes, argumentBytes);
    assert.notEqual(buildDetailModel(missing).tabs[0].rawText, "{}");
  }
  const invalid = buildDetailModel(nested(record({ args: '{"unfinished":' }))).tabs[0];
  assert.equal(invalid.rawText, '{"unfinished":');
  assert.equal(invalid.fields, undefined);
  assert.match(invalid.label, /text/);
});

test("child detail snapshots sanitize controls and bound oversized data without executing accessors", () => {
  const source = record({ name: "bash\x1b]52;c;hidden\x07", args: JSON.stringify({ command: "echo safe\x1b[2J\n  next" }), error: "failure\x1b]52;c;hidden\x07" });
  const request = nested(source);
  const model = buildDetailModel(request);
  assert.equal(model.title, "bash · call record");
  assert.equal(model.tabs[0].fields?.[0].value, "echo safe\n  next");
  assert.doesNotMatch(JSON.stringify(model), /hidden/);
  (source as { args: string }).args = '{"command":"later update"}';
  assert.doesNotMatch(JSON.stringify(model), /later update/);
  const oversized = buildDetailModel(nested(record({ args: JSON.stringify({ command: "x".repeat(200_000) }) })));
  assert.equal(oversized.tabs[0].truncated, true);
  assert.equal(oversized.tabs[0].fields, undefined);
  assert.ok(oversized.tabs.every(tab => tab.text.length < DETAIL_LIMITS.characters));
  let calls = 0;
  const hostile = Object.defineProperties({ id: "root/1", name: "bash", kind: "tool", status: "ok" }, {
    args: { get() { calls++; throw new Error("must not evaluate"); } },
    error: { get() { calls++; throw new Error("must not evaluate"); } },
  }) as NestedCallRecord;
  assert.match(buildDetailModel(nested(hostile)).tabs[0].text, /unavailable/);
  assert.equal(calls, 0);
});

const child = (id: string, tag: string, error?: string) => ({ id, name: "bash", status: error ? "error" : "ok",
  arguments: { command: "printf repeated", displaySummary: "Same long purpose repeated for wrapped child rows", data: tag }, durationMs: 12, ...(error ? { error } : {}) });
const entries = (calls: ReturnType<typeof child>[]) => [
  { id: "u", type: "message", message: { role: "user", content: "request" } },
  { id: "a", type: "message", message: { role: "assistant", id: "turn", stopReason: "toolUse", content: [{ type: "toolCall", id: "root", name: "codemode", arguments: { code: "text(5);" } }] } },
  { id: "r", type: "message", message: { role: "toolResult", toolCallId: "root", toolName: "codemode", content: [{ type: "text", text: "PARENT_OUTPUT_ONLY" }], nestedCalls: { complete: true, calls } } },
];

for (const timeline of ["flat", "turns"] as const) test(timeline + ": repeated child names, wraps and errors open the correct immutable record after live updates and replay", async t => {
  initTheme("dark", false);
  const calls = [child("root/1", "first"), child("root/2", "second", "error belonging to second child, continued"), child("root/2/1", "grandchild")];
  const p = new AggregateProjection(() => false, () => timeline);
  t.after(() => { p.dispose(); restoreAggregateToolExecutions(); });
  p.setRenderTheme(plain); p.rebuild(entries(calls)); patchAggregateToolExecutions(p);
  p.toggleGroupExpansion("root"); p.toggleNestedExpansion("root");
  const row = new ToolExecutionComponent("codemode", "root", { code: "text(5);" }, {}, undefined, { requestRender() {} } as never, process.cwd());
  const opened: DetailRequest[] = [];
  p.setDetailOpener(async request => { opened.push(request); });
  const width = 30;
  const clickRows = async (expected: typeof calls) => {
    const lines = row.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    const starts = lines.flatMap((line, index) => /[●!] Bash/.test(stripTerminalSequences(line)) ? [index] : []);
    assert.equal(starts.length, expected.length);
    for (const [index, start] of starts.entries()) {
      for (let y = start; y < (starts[index + 1] ?? lines.length); y++) {
        assert.equal(row.handleMouse(click(width, y, lines.length))?.handled, true);
        await Promise.resolve(); await Promise.resolve();
        const request = opened.at(-1)!;
        assert.equal(request.kind, "nested");
        if (request.kind !== "nested") throw new Error("not a child record");
        assert.equal(request.rootToolCallId, "root");
        assert.equal(request.call.id, expected[index].id);
        assert.deepEqual(JSON.parse(request.call.args!), expected[index].arguments);
        const model = buildDetailModel(request);
        assert.ok(model.tabs.every(tab => tab.id !== "result"));
        assert.doesNotMatch(JSON.stringify(model), /PARENT_OUTPUT_ONLY/);
        assert.equal(p.isNestedExpanded("root"), true);
        assert.equal(p.isItemExpanded("root"), true);
      }
    }
  };
  await clickRows(calls);
  const frozen = opened[0];
  p.nested.update({ toolCallId: "root/1", parentToolCallId: "root", args: { ...calls[0].arguments, data: "updated" } });
  calls[0].arguments.data = "updated";
  await clickRows(calls);
  assert.equal(frozen.kind === "nested" && JSON.parse(frozen.call.args!).data, "first");
  p.rebuild(entries([calls[1], calls[0], calls[2]]));
  await clickRows([calls[1], calls[0], calls[2]]);
});

test("fullscreen parent and child clicks open the intended first page in the actual overlay", async t => {
  initTheme("dark", false);
  const f = fullscreen(); f.terminal.columns = 100; f.terminal.rows = 36;
  const p = new AggregateProjection();
  t.after(() => { p.dispose(); f.stop(); restoreAggregateToolExecutions(); });
  p.setRenderTheme(plain); p.rebuild(entries([child("root/1", "recorded-child")])); patchAggregateToolExecutions(p);
  p.toggleGroupExpansion("root");
  const row = new ToolExecutionComponent("codemode", "root", { code: "text(5);" }, {}, undefined, f.renderer, process.cwd());
  f.document.addChild(row);
  p.setDetailOpener(request => new Promise<void>(resolve => {
    const component = new DetailViewer(buildDetailModel(request), {
      getHeight: () => 24, onRender: () => f.renderer.requestRender(), onClose: () => { handle.hide(); resolve(); },
    });
    const handle = f.renderer.showOverlay(component, { width: 90 });
  }));
  f.start();
  const buttonRow = f.lines().findIndex(line => line.includes("[Script / Output]"));
  assert.ok(buttonRow >= 0);
  f.terminal.click(f.lines()[buttonRow].indexOf("[Script / Output]"), buttonRow); f.paint();
  assert.match(f.lines().join("\n"), /\[Script\]/);
  assert.match(f.lines().join("\n"), /text\(5\);/);
  assert.equal(p.isNestedExpanded("root"), false);
  f.terminal.onInput?.("\x1b"); f.paint();
  await Promise.resolve(); await Promise.resolve();
  assert.equal(f.renderer.hasOverlay(), false);
  const parentRow = f.lines().findIndex(line => line.includes("▸ codemode"));
  f.terminal.click(6, parentRow); f.paint();
  const childRow = f.lines().findIndex(line => line.includes("● Bash"));
  assert.ok(childRow >= 0);
  f.terminal.click(8, childRow); f.paint();
  assert.match(f.lines().join("\n"), /\[Args\]/);
  assert.match(f.lines().join("\n"), /recorded-child/);
  f.terminal.onInput?.("\t"); f.paint();
  assert.match(f.lines().join("\n"), /\[Call info\]/);
  assert.match(f.lines().join("\n"), /root\/1/);
  assert.doesNotMatch(f.lines().join("\n"), /PARENT_OUTPUT_ONLY/);
  assert.equal(p.isNestedExpanded("root"), true);
  assert.equal(p.isItemExpanded("root"), true);
  f.terminal.onInput?.("\x1b"); f.paint();
  await Promise.resolve(); await Promise.resolve();
});

test("list clipping and preview notices never acquire child hit regions; repeated anonymous preview IDs keep their own snapshots", async t => {
  initTheme("dark", false);
  let maxRows = 1;
  const p = new AggregateProjection(() => false, () => "flat", () => false, undefined, () => maxRows);
  t.after(() => { p.dispose(); restoreAggregateToolExecutions(); });
  p.setRenderTheme(plain); p.rebuild(entries([child("root/1", "first"), child("root/2", "second")]));
  patchAggregateToolExecutions(p); p.toggleGroupExpansion("root"); p.toggleNestedExpansion("root");
  const row = new ToolExecutionComponent("codemode", "root", { code: "text(5);" }, {}, undefined, { requestRender() {} } as never, process.cwd());
  const opened: DetailRequest[] = [];
  p.setDetailOpener(async request => { opened.push(request); });
  let lines = row.render(100);
  const childRow = lines.findIndex(line => stripTerminalSequences(line).includes("● Bash"));
  assert.ok(childRow >= 0);
  assert.equal(row.handleMouse(click(100, childRow, lines.length))?.handled, true);
  await Promise.resolve(); await Promise.resolve();
  for (let y = childRow + 1; y < lines.length; y++) assert.equal(row.handleMouse(click(100, y, lines.length)), undefined);
  assert.equal(opened.length, 1);
  maxRows = 0;
  lines = row.render(100);
  const layout = p.renderExpandedToolRowLayout("root", 100);
  assert.ok(layout.nestedRegions!.every(region => region.action !== "child"));
  assert.match(clean(lines), /Truncated/);

  maxRows = 100;
  p.nested.rebuild([{ message: { role: "toolResult", toolCallId: "root", toolName: "codemode", details: { calls: [
    { id: "root/?", name: "same", status: "ok", args: "first preview" },
    { id: "root/?", name: "same", status: "ok", args: "second preview" },
  ] } } }]);
  lines = row.render(100);
  const starts = lines.flatMap((line, index) => stripTerminalSequences(line).includes("● same") ? [index] : []);
  assert.equal(starts.length, 2);
  for (const [index, y] of starts.entries()) {
    assert.equal(row.handleMouse(click(100, y, lines.length))?.handled, true);
    await Promise.resolve(); await Promise.resolve();
    const request = opened.at(-1)!;
    assert.equal(request.kind, "nested");
    if (request.kind === "nested") assert.equal(request.call.args, index === 0 ? "first preview" : "second preview");
  }
  const notice = lines.findIndex(line => stripTerminalSequences(line).includes("Argument previews are"));
  assert.ok(notice >= 0);
  assert.equal(row.handleMouse(click(100, notice, lines.length)), undefined);
});
