// Run from the repository root through scripts/run-isolated.mjs:
// node scripts/run-isolated.mjs pnpm --dir packages/pi-tool-display-intent exec tsx scripts/bench-rendering.mjs
// Same D2 phase-one workload. Timings are observations, never test thresholds.
import { performance } from "node:perf_hooks";
import { PreviewText } from "../src/preview-text.ts";
import { ClaudeToolResultComponent } from "../src/tool-call-style.ts";
import { createDisplaySession } from "../tests/helpers/display-session.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG as defaults } from "../src/types.ts";
import { ToolExecutionComponent, initTheme, getSelectListTheme } from "@earendil-works/pi-coding-agent";
import { TuiMainScreen, TuiAltScreen, Container, VStack, ScrollView, Editor } from "@earendil-works/pi-tui";
import { AggregateTerminal } from "../tests/helpers/aggregate-terminal.ts";

const width = 100, rounds = 30;
const source = i => Array.from({ length: 32 }, (_, j) => `row-${i}-${j} \x1b[31m结果测试\x1b[0m ` + "word ".repeat(22));
const stats = samples => {
  samples.sort((a, b) => a - b);
  return { medianMs: +samples[Math.floor(samples.length / 2)].toFixed(3), p95Ms: +samples[Math.min(samples.length - 1, Math.ceil(samples.length * .95) - 1)].toFixed(3) };
};
const bench = rows => {
  for (let i = 0; i < 3; i++) for (const row of rows) row.render(width);
  const samples = [];
  for (let i = 0; i < rounds; i++) {
    const start = performance.now();
    for (const row of rows) row.render(width);
    samples.push(performance.now() - start);
  }
  return stats(samples);
};
const selection = process.argv[2] ?? "all";
initTheme("dark", false);
const h = await createDisplaySession({ ...defaults, resultMode: "preview", readOutputMode: "preview", searchOutputMode: "preview", mcpOutputMode: "preview", previewRows: 8 });
try {
  if (selection !== "input") for (const count of [100, 300]) {
    let previewFg = 0, shellFg = 0, previewProbes = 0, shellProbes = 0;
    const preTheme = { fg: (_color, s) => { previewFg++; if (s === "x") previewProbes++; return s; } };
    const shellTheme = { fg: (_color, s) => { shellFg++; if (s === "x") shellProbes++; return s; } };
    const previews = Array.from({ length: count }, (_, i) => new PreviewText({ lines: source(i), maxRows: 8, theme: preTheme, expanded: false }));
    const shells = previews.map(p => new ClaudeToolResultComponent(p, { theme: shellTheme }));
    const tui = new TuiMainScreen(new AggregateTerminal());
    const renderer = h.renderers("read");
    const rows = Array.from({ length: count }, (_, i) => {
      const row = new ToolExecutionComponent("read", `bench-${i}`, { path: `sample-${i}.txt` }, { outputPad: 0 }, renderer, tui, h.cwd);
      row.updateResult({ content: [{ type: "text", text: source(i).join("\n") }], details: {}, isError: false, durationMs: 12 });
      return row;
    });
    const leaf = bench(previews);
    previewFg = previewProbes = 0;
    for (const p of previews) p.render(width);
    const leafWarm = { fg: previewFg, probes: previewProbes, body: previewFg - previewProbes };
    const pair = bench(shells);
    previewFg = shellFg = previewProbes = shellProbes = 0;
    for (const p of shells) p.render(width);
    const pairWarm = { previewFg, previewProbes, previewBody: previewFg - previewProbes, shellFg, shellProbes, shellBody: shellFg - shellProbes };
    const actual = bench(rows);
    console.log(JSON.stringify({ kind: "component", node: process.version, count, width, rounds, logicalLines: 32, previewRows: 8, leaf, pair, actual, leafWarm, pairWarm }));
  }
  if (selection !== "component") for (const count of [100, 300]) for (const mode of ["regular", "fullscreen"]) {
    const terminal = new AggregateTerminal();
    terminal.columns = width; terminal.rows = 30;
    const tui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal, false, undefined, { mouse: false, copyOnSelect: false });
    const document = new Container();
    for (let i = 0; i < count; i++) {
      const row = new ToolExecutionComponent("read", `ui-${mode}-${i}`, { path: `sample-${i}.txt` }, { outputPad: 0 }, h.renderers("read"), tui, h.cwd);
      row.updateResult({ content: [{ type: "text", text: source(i).join("\n") }], details: {}, isError: false, durationMs: 12 });
      document.addChild(row);
    }
    const editor = new Editor(tui, { borderColor: s => s, selectList: getSelectListTheme() });
    if (mode === "regular") { tui.addChild(document); tui.addChild(editor); }
    else tui.setLayoutRoot(new VStack([
      { component: new ScrollView(document, { primary: true, follow: "end", scrollbar: "hidden" }), basis: 0, grow: 1, minSize: 0 },
      { component: editor, shrink: 0 },
    ]));
    tui.setFocus(editor); tui.start(); tui.renderNow();
    const sample = async data => {
      const start = performance.now();
      await new Promise((resolve, reject) => {
        let pending = false;
        const timeout = setTimeout(() => reject(new Error("no paint")), 3000);
        terminal.onWrite = () => {
          if (pending) return;
          pending = true;
          queueMicrotask(() => { clearTimeout(timeout); resolve(); });
        };
        terminal.onInput(data);
      });
      terminal.onWrite = undefined; terminal.writes.length = 0;
      return performance.now() - start;
    };
    try {
      for (let i = 0; i < 3; i++) { await sample("x"); await sample("\x7f"); }
      const typing = [], backspace = [];
      for (let i = 0; i < 12; i++) { typing.push(await sample("x")); backspace.push(await sample("\x7f")); }
      console.log(JSON.stringify({ kind: "synthetic-input", node: process.version, mode, count, width, height: 30, samples: 12, path: "Terminal callback -> native Editor -> scheduled TUI diff/Terminal.write (synthetic transport)", typing: stats(typing), backspace: stats(backspace), finalText: editor.getText() }));
    } finally { terminal.onWrite = undefined; tui.stop({ preserveScreen: true }); }
  }
} finally { await h.close(); }
