import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, stripTerminalSequences, visibleWidth } from "@earendil-works/pi-tui";
import { PreviewText } from "../src/preview-text.ts";
import { ClaudeToolResultComponent } from "../src/tool-call-style.ts";
import { extractTextOutput } from "../src/render-utils.ts";
import { renderEditDiffResult, renderWriteDiffResult } from "../src/diff-renderer.ts";
import { buildInspectorSettings, openSettingsModal } from "../src/config-modal.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG as defaults } from "../src/types.ts";
import { createDisplaySession } from "./helpers/display-session.ts";
import { AggregateTerminal } from "./helpers/aggregate-terminal.ts";

const plain = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

test("both layers skip repeated body work while nonempty theme probes detect same-appearance changes", () => {
  let bodies = 0, prefixes = 0, color = 31;
  const innerTheme = { appearance: "dark", fg: (_c: string, s: string) => { if (!s) return ""; if (s !== "x") bodies++; return `\x1b[${color}m${s}\x1b[0m`; } };
  const outerTheme = { appearance: "dark", fg: (_c: string, s: string) => { if (!s) return ""; if (s !== "x") prefixes++; return `\x1b[${color}m${s}\x1b[0m`; } };
  const preview = new PreviewText({ lines: ["alpha", "beta"], maxRows: 8, theme: innerTheme, expanded: false });
  const shell = new ClaudeToolResultComponent(preview, { theme: outerTheme });
  const initial = shell.render(100).join("\n");
  bodies = prefixes = 0;
  assert.equal(shell.render(100).join("\n"), initial);
  assert.equal(bodies, 0);
  assert.equal(prefixes, 0);
  color = 32;
  const changed = shell.render(100).join("\n");
  assert.notEqual(changed, initial);
  assert.match(changed, /\x1b\[32m/);
  assert.ok(bodies > 0 && prefixes > 0);
});

test("a 4000-row expanded preview that fits the total cache budget is not prematurely omitted", () => {
  const preview = new PreviewText({ lines: Array.from({ length: 4000 }, (_, i) => `row-${i}`), maxRows: 4000, expanded: true, theme: plain });
  const output = preview.render(100).join("\n");
  assert.match(output, /row-3999/);
  assert.doesNotMatch(output, /Truncated/);
});

test("formatted caches cap large child output and retain a narrow-width omission marker", () => {
  const child = { render: () => Array(20_000).fill("z".repeat(100)), invalidate() {} };
  const shell = new ClaudeToolResultComponent(child);
  const rows = shell.render(8);
  assert.ok(rows.reduce((sum, row) => sum + row.length, 0) <= 1_000_000 + 300);
  assert.ok(rows.every(row => visibleWidth(row) <= 8));
  assert.match(rows.join(""), /Truncated/);
});

test("result extraction bounds block traversal without invoking getters or mutating the original", () => {
  let accessed = 0;
  const content = Array.from({ length: 1001 }, () => ({ type: "text", text: "safe" }));
  Object.defineProperty(content, "1000", { get() { accessed++; throw new Error("unreachable tail"); } });
  const result = { content };
  const output = extractTextOutput(result);
  assert.match(output, /safe/);
  assert.match(output, /Truncated/);
  assert.equal(accessed, 0);
  assert.equal(result.content, content);
  const accessor = { content: [{ type: "text", get text() { accessed++; return "unsafe"; } }] };
  assert.match(extractTextOutput(accessor), /Truncated/);
  assert.equal(accessed, 0);
});

test("own renderer snapshots omit getters and toJSON rather than falling through to unbounded formatting", async t => {
  const h = await createDisplaySession({ ...defaults, mcpOutputMode: "preview" });
  t.after(() => h.close());
  let calls = 0;
  const result = { content: [{ type: "text", text: "valid" }], get details() { calls++; throw new Error("getter"); }, toJSON() { calls++; throw new Error("toJSON"); } };
  const component = h.renderers("historical_probe")!.renderResult!(result as never, { expanded: true, isPartial: false }, plain as never, { state: {}, args: {} } as never);
  const output = component.render(120).join("\n");
  assert.match(output, /valid/);
  assert.match(output, /Truncated/);
  assert.equal(calls, 0);
  assert.equal(result.content[0].text, "valid");
  const nonEnumerable = Object.defineProperty({}, "content", { get() { calls++; throw new Error("hidden getter"); } });
  const omitted = h.renderers("historical_probe")!.renderResult!(nonEnumerable as never, { expanded: true, isPartial: false }, plain as never, { state: {}, args: {} } as never);
  assert.match(omitted.render(120).join("\n"), /Truncated/);
  assert.equal(calls, 0);
});

test("oversized diff sources are explicitly omitted, not converted into a partial complete diff", () => {
  const huge = "x".repeat(1_000_001);
  const edit = renderEditDiffResult({ diff: huge }, { expanded: true }, defaults, plain, "done");
  const write = renderWriteDiffResult("new", { expanded: true, previousContent: huge, fileExistedBeforeWrite: true }, defaults, plain, "done");
  for (const component of [edit, write]) {
    const output = component.render(120).join("\n");
    assert.match(output, /diff omitted/);
    assert.match(output, /Truncated/);
    assert.doesNotMatch(output, /lines added|lines removed/);
  }
});

test("a display-omitted Bash call still completes its existing spinner lifecycle", async t => {
  const h = await createDisplaySession();
  t.after(() => h.close());
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const timers: ReturnType<typeof setInterval>[] = [];
  const cleared = new Set<ReturnType<typeof setInterval>>();
  globalThis.setInterval = ((fn: any, ms: number) => { const timer = originalSet(fn, ms); timers.push(timer); return timer; }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => { cleared.add(timer); originalClear(timer); }) as typeof clearInterval;
  try {
    const tool = h.displayTool("bash");
    const context: any = { state: {}, toolCallId: "bounded-bash", argsComplete: true, executionStarted: true, isPartial: true, invalidate() {} };
    context.lastComponent = tool.renderCall({ command: "echo ready" }, plain, context);
    const args = { command: "x".repeat(1_000_001) };
    context.lastComponent = tool.renderCall(args, plain, context);
    assert.match(context.lastComponent.render(120).join("\n"), /Truncated/);
    assert.equal(timers.length, 1);
    context.isPartial = false;
    tool.renderCall(args, plain, context);
    assert.equal(cleared.has(timers[0]), true, "completion must stop the timer before session shutdown");
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
    for (const timer of timers) originalClear(timer);
  }
});

test("settings modal invalidates an existing history row through its actual public TUI", async t => {
  initTheme("dark", false);
  const config = { ...defaults, resultMode: "preview" as const, readOutputMode: "preview" as const, previewRows: 8 };
  const h = await createDisplaySession(config);
  t.after(() => h.close());
  const tui = new TuiMainScreen(new AggregateTerminal());
  const row = new ToolExecutionComponent("read", "config-history", { path: "sample.txt" }, { outputPad: 0 }, h.renderers("read"), tui, h.cwd);
  row.updateResult({ content: [{ type: "text", text: Array.from({ length: 16 }, (_, i) => `payload-${i}`).join("\n") }], isError: false });
  tui.addChild(row);
  const text = () => row.render(120).map(stripTerminalSequences).join("\n");
  assert.doesNotMatch(text(), /payload-10/);
  let resolveReady: (component: any) => void;
  let rejectReady: (error: unknown) => void;
  const ready = new Promise<any>((resolve, reject) => { resolveReady = resolve; rejectReady = reject; });
  const runner = h.session.extensionRunner;
  const originalUI = runner.getUIContext();
  runner.setUIContext({ ...originalUI, custom: factory => new Promise(resolve => {
    Promise.resolve(factory(tui, originalUI.theme, undefined as never, resolve)).then(resolveReady, rejectReady);
  }) } as never, "tui");
  const capabilities = { hasMcpTooling: false, hasRtkOptimizer: false };
  const opened = openSettingsModal(runner.createCommandContext(), {
    getConfig: () => config,
    setConfig: next => { Object.assign(config, next); },
    getCapabilities: () => capabilities,
  });
  const modal = await ready;
  modal.render(120);
  const index = buildInspectorSettings(config, capabilities).findIndex(item => item.id === "previewRows");
  for (let i = 0; i < index; i++) modal.handleInput("\x1b[B");
  modal.handleInput(" ");
  assert.equal(config.previewRows, 12);
  // No test-side invalidate/updateResult: the production setting change must do it.
  assert.match(text(), /payload-10/);
  modal.handleInput("\x1b");
  await opened;
});
