import assert from "node:assert/strict";
import test from "node:test";
import { ToolExecutionComponent, initTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, Input, stripTerminalSequences, visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { AggregateProjection, formatAggregateTarget, formatAggregateCallDuration, patchAggregateToolExecutions, registerAggregateProjectionEvents, renderExpandedAggregateSummary, restoreAggregateToolExecutions } from "../src/aggregate-activity.ts";
import { aggregateNestedSummary, renderNestedChildren } from "../src/aggregate-nested.ts";
import { buildDetailModel, type DetailRequest } from "../src/detail-viewer-model.ts";
import { NestedDisplayStore } from "../src/nested-display.ts";
import { fullscreen } from "./helpers/aggregate-terminal.ts";

const plain = { fg: (_: string, text: string) => text };
const format = { target: formatAggregateTarget, duration: formatAggregateCallDuration };
const clean = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const words = (lines: string[]) => lines.map(line => stripTerminalSequences(line).replace(/^  [│└] /, "").trim()).join(" ").replace(/\s+/g, " ");
const entry = (id: string, message: unknown) => ({ type: "message", id, message });
const args = { code: "text(2 + 3);" };
const saved = (id: string, name = "codemode") => ({
  role: "toolResult", toolCallId: id, toolName: name, isError: false, content: [{ type: "text", text: "parent output" }],
  nestedCalls: { complete: true, calls: [
    { id: `${id}/1`, name: "bash", status: "ok", arguments: { command: "private-command", displaySummary: "Check project" }, durationMs: 1250 },
    { id: `${id}/2`, name: "read", status: "error", arguments: { path: `${id}.ts` }, error: `missing ${id}.ts`, durationMs: 12 },
  ] },
});
const branch = () => [
  entry("u", { role: "user", content: "request", timestamp: 1 }),
  entry("a", { role: "assistant", id: "turn", stopReason: "toolUse", content: [
    { type: "toolCall", id: "a", name: "codemode", arguments: args },
    { type: "toolCall", id: "b", name: "orchestrator", arguments: {} },
  ] }),
  entry("ra", saved("a")), entry("rb", saved("b", "orchestrator")),
  entry("f", { role: "assistant", id: "done", stopReason: "stop", content: [{ type: "text", text: "done" }] }),
];
const click = (width: number, y: number, height: number): TuiMouseEvent => ({
  type: "click", button: "left", x: width - 1, y, screenX: width - 1, screenY: y, width, height,
  shift: false, alt: false, ctrl: false,
});

for (const timeline of ["flat", "turns"] as const) for (const width of [100, 26]) {
  test(timeline + " at " + width + " columns: parent toggles children and explicit Details has disjoint hit bounds", async t => {
    initTheme("dark", false);
    const p = new AggregateProjection(() => false, () => timeline);
    t.after(() => { p.dispose(); restoreAggregateToolExecutions(); });
    p.setRenderTheme(plain); p.rebuild(branch()); patchAggregateToolExecutions(p);
    const opened: DetailRequest[] = [];
    p.setDetailOpener(async request => { opened.push(request); });
    const root = new Container();
    const first = new ToolExecutionComponent("codemode", "a", args, {}, undefined, { requestRender() {} } as never, process.cwd());
    const second = new ToolExecutionComponent("orchestrator", "b", {}, {}, undefined, { requestRender() {} } as never, process.cwd());
    root.addChild(first); root.addChild(second);
    p.toggleGroupExpansion("a");
    let lines = root.render(width);
    assert.match(words(lines), /▸ codemode · 2 internal calls · 1 failed/);
    assert.match(words(lines), /▸ orchestrator · 2 internal calls · 1 failed/);
    assert.doesNotMatch(clean(lines), /Internal calls:|text\(2|Check project|missing a.ts|unavailable in history|Nested tools/);
    assert.equal(p.getViewForGroup("a")?.failedCount, 0);
    assert.equal(p.getViewForGroup("a")?.nestedFailedCount, 2);
    const header = clean(renderExpandedAggregateSummary(p.getViewForGroup("a")!, 120, plain));
    assert.match(header, /2 internal failed/);
    assert.doesNotMatch(header, /Internal calls:|Nested tools/);

    const firstLines = first.render(width).map(stripTerminalSequences);
    const titleRow = firstLines.findIndex(line => line.includes("▸ codemode"));
    const detailsRow = firstLines.findIndex(line => line.includes("[Script / Output]"));
    const detailsColumn = firstLines[detailsRow].indexOf("[Script / Output]");
    assert.match(clean(second.render(100)), /\[Details\]/);
    assert.ok(detailsColumn >= 0);
    assert.equal(detailsRow === titleRow, width === 100, "narrow Details must move to its own continuation");
    const send = (x: number, y: number) => root.handleMouse({ ...click(width, y, lines.length), x, screenX: x });
    // Left and right edges of Details are inclusive/exclusive respectively.
    assert.equal(send(detailsColumn, detailsRow)?.handled, true);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(p.isNestedExpanded("a"), false);
    assert.equal(p.isItemExpanded("a"), true);
    assert.equal(opened.length, 1);
    const model = buildDetailModel(opened[0]);
    assert.equal(model.tabs[1].fields?.[0].language, "javascript");
    assert.deepEqual(JSON.parse(model.tabs[1].rawText), args);
    assert.equal(send(detailsColumn + "[Script / Output]".length - 1, detailsRow)?.handled, true);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(opened.length, 2);
    assert.equal(send(detailsColumn + "[Script / Output]".length, detailsRow), undefined);
    assert.equal(p.isNestedExpanded("a"), false);
    if (detailsRow !== titleRow) {
      assert.equal(send(detailsColumn - 1, detailsRow), undefined, "blank continuation columns are not hidden toggle targets");
      assert.equal(p.isNestedExpanded("a"), false);
      assert.equal(send(firstLines[titleRow].indexOf("▸"), titleRow)?.handled, true);
    } else {
      assert.equal(send(detailsColumn - 1, detailsRow)?.handled, true, "the column immediately before Details belongs only to toggle");
    }
    assert.equal(p.isNestedExpanded("a"), true);
    assert.equal(p.isNestedExpanded("b"), false);
    assert.equal(opened.length, 2);
    lines = root.render(width);
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    assert.match(words(lines), /Check project/);
    assert.doesNotMatch(clean(lines), /private-command|\[ok\]|\[error\]|Child result bodies|unavailable in history/);
    const expanded = first.render(width).map(stripTerminalSequences);
    const parentColumn = expanded.find(line => line.includes("▾ codemode"))!.indexOf("▾");
    const childRow = expanded.findIndex(line => line.includes("● Bash"));
    assert.equal(expanded[childRow].indexOf("●"), parentColumn + 2, "indent is relative to the actual framed parent, including turns");
    const failed = expanded.find(line => line.includes("! Read"))!;
    assert.equal(failed.indexOf("!"), parentColumn + 2);
    assert.match(words(expanded), /12ms/);
    assert.doesNotMatch(words(expanded), /0s/);
    const error = expanded.find(line => line.includes("missing a.ts"))!;
    assert.equal(error.indexOf("missing"), parentColumn + 4);
    assert.equal(send(parentColumn + 2, childRow)?.handled, true);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(opened[2].kind, "nested");
    if (opened[2].kind === "nested") assert.equal(opened[2].call.id, "a/1");
    assert.equal(p.isNestedExpanded("a"), true);
    assert.equal(p.isItemExpanded("a"), true);
    assert.doesNotMatch(clean(second.render(width)), /Check project/);

    const sibling = second.render(width).map(stripTerminalSequences);
    const siblingTitle = sibling.findIndex(line => line.includes("▸ orchestrator"));
    assert.equal(send(sibling[siblingTitle].indexOf("▸"), first.render(width).length + siblingTitle)?.handled, true);
    assert.equal(p.isNestedExpanded("b"), true);
    lines = root.render(width);
    const layout = p.renderExpandedToolRowLayout("a", width);
    const offset = first.render(width).length - layout.lines.length;
    const toggle = layout.nestedRegions!.find(region => region.action === "toggle")!;
    assert.equal(send(toggle.startColumn!, offset + toggle.endRow - 1)?.handled, true, "wrapped parent continuation still toggles only this root");
    assert.equal(p.isNestedExpanded("a"), false);
    assert.equal(p.isNestedExpanded("b"), true);
    assert.equal(opened.length, 3);
    lines = root.render(width);
    assert.equal(send(width - 1, 1)?.handled, true);
    assert.equal(p.isItemExpanded("a"), false);
    lines = root.render(width);
    assert.equal(send(width - 1, 1)?.handled, true);
    assert.equal(p.isNestedExpanded("a"), false);
    assert.equal(p.isNestedExpanded("b"), true);
    assert.match(clean(second.render(100)), /▾ orchestrator/);
  });
}

test("tools without internal calls keep ordinary click-to-detail behavior with no fake arrow", async t => {
  initTheme("dark", false);
  const p = new AggregateProjection();
  t.after(() => { p.dispose(); restoreAggregateToolExecutions(); });
  const entries = branch();
  const empty = saved("a");
  empty.nestedCalls.calls = [];
  entries[2] = entry("ra", empty);
  p.setRenderTheme(plain); p.rebuild(entries); patchAggregateToolExecutions(p);
  const opened: DetailRequest[] = [];
  p.setDetailOpener(async request => { opened.push(request); });
  const row = new ToolExecutionComponent("codemode", "a", args, {}, undefined, { requestRender() {} } as never, process.cwd());
  p.toggleGroupExpansion("a");
  const lines = row.render(100);
  assert.doesNotMatch(clean(lines), /[▸▾]|\[Details\]|internal calls/);
  const call = lines.map(stripTerminalSequences).findIndex(line => line.includes("● codemode"));
  assert.equal(row.handleMouse(click(100, call, lines.length))?.handled, true);
  await Promise.resolve();
  assert.equal(opened.length, 1);
  assert.equal(p.isNestedExpanded("a"), false);
  await Promise.resolve();
  p.nested.ingest({ ...empty, nestedCalls: { complete: false, calls: [] } });
  const incomplete = row.render(100);
  assert.doesNotMatch(clean(incomplete), /[▸▾]/);
  assert.match(words(incomplete), /incomplete \/ omitted data/);
  const incompleteCall = incomplete.map(stripTerminalSequences).findIndex(line => line.includes("● codemode"));
  assert.equal(row.handleMouse({ ...click(100, incompleteCall, incomplete.length), x: 6, screenX: 6 })?.handled, true);
  await Promise.resolve();
  assert.equal(opened.length, 2);
  p.toggleNestedExpansion("a");
  assert.equal(p.isNestedExpanded("a"), false, "missing records do not create an empty toggle");
});

test("nested child continuations and errors follow their actual parent hierarchy", t => {
  const p = new AggregateProjection(() => false, () => "turns");
  t.after(() => p.dispose());
  const entries = branch();
  const result = saved("a");
  result.nestedCalls.calls.push({ id: "a/1/1", name: "read", status: "error", arguments: { path: "long-child-path/".repeat(5) }, error: "child failure ".repeat(50), durationMs: 999 });
  entries[2] = entry("ra", result);
  p.setRenderTheme(plain); p.rebuild(entries); p.toggleNestedExpansion("a");
  const rows = p.renderExpandedToolRow("a", 50).map(stripTerminalSequences);
  const parent = rows.find(line => line.includes("▾ codemode"))!.indexOf("▾");
  const child = rows.find(line => line.includes("● Bash"))!.indexOf("●");
  const grandchild = rows.findIndex(line => line.includes("! Read(long-child"));
  assert.equal(child, parent + 2);
  assert.equal(rows[grandchild].indexOf("!"), child + 2);
  for (const row of rows.slice(grandchild + 1).filter(line => line.includes("long-child") || line.includes("child failure"))) {
    assert.equal(4 + row.slice(4).search(/\S/), child + 4);
  }
  assert.ok(rows.every(row => visibleWidth(row) <= 50));
  assert.ok(rows.filter(row => row.includes("child failure")).length <= 2);
  assert.match(words(rows), /999ms/);
});

test("very narrow parents keep a visible, clickable Details entry instead of clipping it away", async t => {
  initTheme("dark", false);
  const p = new AggregateProjection(() => false, () => "turns");
  t.after(() => { p.dispose(); restoreAggregateToolExecutions(); });
  p.setRenderTheme(plain); p.rebuild(branch()); patchAggregateToolExecutions(p);
  let opened = 0;
  p.setDetailOpener(async () => { opened++; });
  const row = new ToolExecutionComponent("codemode", "a", args, {}, undefined, { requestRender() {} } as never, process.cwd());
  p.toggleGroupExpansion("a");
  for (const width of [1, 4, 5, 8, 13, 18]) {
    const lines = row.render(width);
    const layout = p.renderExpandedToolRowLayout("a", width);
    const offset = lines.length - layout.lines.length;
    assert.ok(lines.every(line => visibleWidth(line) <= width));
    const regions = layout.nestedRegions!.filter(region => region.action === "details");
    const label = regions.map(region => stripTerminalSequences(lines[offset + region.startRow]).slice(region.startColumn, region.endColumn)).join("");
    assert.equal(label.replace(/\s/g, ""), "[Script/Output]");
    assert.ok(layout.nestedRegions!.some(region => region.action === "toggle" && region.endRow > region.startRow), "parent remains visible too");
    const region = regions[0];
    const event = click(width, offset + region.startRow, lines.length);
    assert.equal(row.handleMouse({ ...event, x: region.startColumn!, screenX: region.startColumn! })?.handled, true);
    await Promise.resolve(); await Promise.resolve();
    assert.equal(p.isNestedExpanded("a"), false);
  }
  assert.equal(opened, 6);
});

test("fullscreen SGR clicks expand internal calls without moving the Run or taking editor focus", () => {
  initTheme("dark", false);
  const f = fullscreen();
  const editor = new Input();
  f.widgets.addChild(editor); f.renderer.setFocus(editor);
  const p = new AggregateProjection();
  p.setRenderTheme(plain); p.rebuild(branch()); patchAggregateToolExecutions(p);
  const first = new ToolExecutionComponent("codemode", "a", args, {}, undefined, f.renderer, process.cwd());
  const second = new ToolExecutionComponent("orchestrator", "b", {}, {}, undefined, f.renderer, process.cwd());
  f.document.addChild(first); f.document.addChild(second);
  try {
    f.start();
    const heading = f.lines().findIndex(line => line.includes("Run"));
    f.terminal.click(10, heading); f.paint();
    const summary = f.lines().findIndex(line => line.includes("▸ codemode"));
    assert.ok(summary >= 0);
    const top = f.scroll.scrollTop;
    f.terminal.click(10, summary); f.paint();
    assert.equal(p.isNestedExpanded("a"), true);
    assert.equal(p.isNestedExpanded("b"), false);
    assert.equal(p.isItemExpanded("a"), true);
    assert.equal(f.scroll.scrollTop, top);
    assert.ok(f.lines()[summary].includes("▾ codemode"));
    assert.equal(f.renderer.hasOverlay(), false);
    f.terminal.onInput?.("k"); f.paint();
    assert.equal(editor.getValue(), "k");
    const currentSummary = f.lines().findIndex(line => line.includes("▾ codemode"));
    assert.ok(currentSummary >= 0, f.lines().join("\n"));
    f.terminal.click(15, currentSummary); f.paint();
    assert.equal(p.isNestedExpanded("a"), false, f.lines().join("\n"));
  } finally { p.dispose(); f.stop(); restoreAggregateToolExecutions(); }
});

test("nested choices survive live counts, replacement fact objects and Run/global folding, but prune removed roots", t => {
  const p = new AggregateProjection(); t.after(() => p.dispose());
  p.setRenderTheme(plain); p.rebuild(branch()); p.toggleNestedExpansion("a");
  let invalidations = 0;
  p.connectRenderer("a", "codemode", args, () => { invalidations++; });
  const before = p.nested.get("a");
  p.nested.start({ toolCallId: "a/3", parentToolCallId: "a", toolName: "find", args: { pattern: "*.ts" } });
  assert.ok(invalidations > 0);
  assert.match(words(p.renderExpandedToolRow("a", 120)), /▾ codemode · at least 3 internal calls · 1 failed.*1 running/);
  p.nested.end({ toolCallId: "a/3", parentToolCallId: "a", toolName: "find", isError: true, result: { content: [{ type: "text", text: "find rejected" }] } });
  assert.match(clean(p.renderExpandedToolRow("a", 120)), /2 failed/);
  assert.match(clean(p.renderExpandedToolRow("a", 120)), /find rejected/);
  p.noteTimelineExpansion(true); p.noteTimelineExpansion(false); p.noteTimelineExpansion(true);
  assert.equal(p.isNestedExpanded("a"), true);
  assert.equal(p.isNestedExpanded("b"), false);
  p.rebuild(branch());
  assert.notEqual(p.nested.get("a"), before);
  assert.equal(p.isNestedExpanded("a"), true);
  p.rebuild([]); p.rebuild(branch());
  assert.equal(p.isNestedExpanded("a"), false);
});

test("session_start clears local nested choices even for reused call IDs; shutdown rejects stale clicks", async () => {
  const handlers = new Map<string, Array<(event: any, ctx: any) => unknown>>();
  const pi = { on(name: string, handler: (event: any, ctx: any) => unknown) {
    handlers.set(name, [...handlers.get(name) ?? [], handler]);
  } } as unknown as ExtensionAPI;
  const p = new AggregateProjection();
  registerAggregateProjectionEvents(pi, p);
  const ctx = { hasUI: false, sessionManager: { getBranch: branch } };
  const emit = async (name: string) => { for (const handler of handlers.get(name) ?? []) await handler({}, ctx); };
  try {
    await emit("session_start"); p.toggleNestedExpansion("a");
    await emit("before_agent_start");
    assert.equal(p.isNestedExpanded("a"), true);
    await emit("session_start");
    assert.equal(p.isNestedExpanded("a"), false);
    p.toggleNestedExpansion("a"); await emit("session_shutdown");
    assert.equal(p.isNestedExpanded("a"), false);
    p.toggleNestedExpansion("a");
    assert.equal(p.isNestedExpanded("a"), false);
  } finally { p.dispose(); }
});

test("preview-only history and incomplete generic records keep uncertainty and child failures bounded", () => {
  const store = new NestedDisplayStore();
  store.update({ toolCallId: "live", toolName: "codemode", partialResult: { details: { calls: [
    { id: "live/1", name: "bash", args: "native preview", status: "running" },
  ] } } });
  assert.match(aggregateNestedSummary(store.get("live"))!, /count unavailable.*execution record unavailable/);
  store.ingest({ role: "toolResult", toolCallId: "legacy", toolName: "codemode", details: { calls: [
    { id: "legacy/1", name: "bash", args: "command preview", status: "cancelled" },
    { id: "legacy/models.classify/1", name: "models.classify", args: "model preview", status: "ok", durationMs: 300 },
    { id: "legacy/?", name: "unknown", args: "unknown preview", status: "error", error: "failed\n".repeat(100) },
  ] } });
  const root = store.get("legacy")!;
  assert.match(aggregateNestedSummary(root)!, /1 failed.*1 cancelled.*1 model calls.*execution record unavailable.*incomplete/);
  const collapsed = renderNestedChildren(root, 45, 2, plain, false, 10, format);
  assert.deepEqual(collapsed, { lines: [], regions: [] });
  const expanded = renderNestedChildren(root, 45, 2, plain, true, 100, format);
  assert.match(clean(expanded.lines), /argument preview/);
  assert.match(words(expanded.lines), /300ms/);
  assert.doesNotMatch(words(expanded.lines), /Child result bodies|unavailable in history/);
  for (const width of [1, 5, 20, 80]) {
    const rows = renderNestedChildren(root, width, 2, plain, true, 8, format).lines;
    assert.ok(rows.every(row => visibleWidth(row) <= width));
    assert.ok(rows.length < 200, "error text cannot bypass the preview row budget");
  }
  store.ingest({ role: "toolResult", toolCallId: "generic", nestedCalls: { complete: false, calls: [
    { id: "orphan", name: "worker", status: "unfinished", argumentsBytes: 9000 },
  ] } });
  const generic = renderNestedChildren(store.get("generic"), 100, 2, plain, true, 30, format);
  assert.match(aggregateNestedSummary(store.get("generic"))!, /at least 1.*1 unfinished.*incomplete/);
  assert.match(clean(generic.lines), /arguments omitted: 9000 UTF-8 bytes.*parent unknown/);
  assert.doesNotMatch(clean(generic.lines), /0ms|\[ok\]|● worker/);
  store.dispose();
});
