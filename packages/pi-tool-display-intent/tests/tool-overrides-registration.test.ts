import assert from "node:assert/strict";
import test from "node:test";
import { homedir } from "node:os";
import {
  createBashToolDefinition, createEditToolDefinition, createFindToolDefinition,
  createGrepToolDefinition, createLsToolDefinition, createReadToolDefinition,
  createWriteToolDefinition, initTheme, ToolExecutionComponent,
} from "@earendil-works/pi-coding-agent";
import { Text, TuiMainScreen, visibleWidth, stripTerminalSequences } from "@earendil-works/pi-tui";
import { decorateToolForDisplay, withDisplaySummary } from "../tool-display-api-consumer.js";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { shortenPath } from "../src/render-utils.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG as defaults } from "../src/types.ts";
import { createDisplaySession, createRendererTestHarness } from "./helpers/display-session.ts";
import { AggregateTerminal } from "./helpers/aggregate-terminal.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as any;
const text = (component: any, width = 160) => component.render(width).map((line: string) => stripTerminalSequences(line).trimEnd()).join("\n");
const factories = {
  read: createReadToolDefinition, grep: createGrepToolDefinition, find: createFindToolDefinition,
  ls: createLsToolDefinition, bash: createBashToolDefinition, edit: createEditToolDefinition,
  write: createWriteToolDefinition,
};

test("real registry retains native definitions and registers only Bash/Write semantic decorations", async t => {
  const h = await createDisplaySession();
  t.after(() => h.close());
  assert.deepEqual(h.session.extensionRunner.getAllRegisteredTools().map(t => t.definition.name).sort(), ["bash", "write"]);
  for (const [name, factory] of Object.entries(factories)) {
    const actual = h.session.getToolDefinition(name)!;
    const original = factory(h.cwd);
    assert.equal(actual.description, original.description);
    assert.equal(actual.promptSnippet, original.promptSnippet);
    assert.deepEqual(actual.outputSchema, original.outputSchema);
    assert.deepEqual(actual.constrainedSampling, original.constrainedSampling);
    if (name !== "bash") {
      assert.equal(actual.parameters, original.parameters, `${name} keeps its schema`);
      assert.deepEqual(actual.promptGuidelines, original.promptGuidelines);
    } else {
      assert.ok((actual.parameters as any).required.includes("displaySummary"));
      assert.deepEqual(actual.promptGuidelines?.slice(0, -1), original.promptGuidelines);
    }
  }
});

test("renderers are available before session_start without registering execution tools for history", async () => {
  const h = await createRendererTestHarness();
  registerToolDisplayOverrides(h.api, () => defaults);
  assert.equal(h.session.extensionRunner.getAllRegisteredTools().length, 0);
  for (const name of Object.keys(factories)) {
    const resolved = h.renderers(name)!;
    assert.equal(typeof resolved.renderCall, "function");
    assert.equal(typeof resolved.renderResult, "function");
  }
});

test("Bash display summary is prepared and a real command still runs in the provided context", async t => {
  const h = await createDisplaySession();
  t.after(() => h.close());
  const bash = h.session.getToolDefinition("bash")!;
  const args = bash.prepareArguments!({ command: "printf hello", displaySummary: "Checking the sample file" });
  const ctx = h.session.extensionRunner.createToolContext("bash-1", undefined);
  const result = await bash.execute("bash-1", args, undefined, undefined, ctx);
  assert.match(JSON.stringify(result.structuredContent), /hello/);
  assert.match(text(h.displayTool("bash").renderCall(args, theme, {})), /Checking the sample file/);
});

test("path-bearing display calls compact long paths and restore them when expanded", async t => {
  const h = await createDisplaySession();
  t.after(() => h.close());
  const path = `${homedir()}/.local/share/pnpm/store/v11/links/@earendil-works/pi-coding-agent/1.1.0/3f756669fd860ae9f8a03cb73678ac7de01add7dc08f75902c7f14389da37058/node_modules/@earendil-works/pi-coding-agent/docs/rpc.md`;
  const cases = [
    ["read", { path, offset: 1, limit: 2000 }], ["grep", { pattern: "systemPrompt", path }],
    ["find", { pattern: "*.md", path }], ["ls", { path }],
    ["edit", { path, edits: [{ oldText: "a", newText: "b" }] }], ["write", { path, content: "x" }],
  ] as const;
  for (const [name, args] of cases) {
    const tool = h.displayTool(name);
    const context = { args, state: {}, executionStarted: true, expanded: false, isPartial: false };
    const collapsed = tool.renderCall(args, theme, context);
    const rows = collapsed.render(76);
    assert.equal(rows.length, 1);
    assert.ok(visibleWidth(rows[0]) <= 76);
    assert.match(rows[0], /…/u);
    assert.match(rows[0], /rpc\.md/u);
    assert.doesNotMatch(rows[0], /3f756669fd860ae9/u);
    const expanded = tool.renderCall(args, theme, { ...context, expanded: true, lastComponent: collapsed });
    assert.equal(expanded, collapsed);
    assert.ok(text(expanded, 76).replaceAll("\n", "").includes(shortenPath(path)));
  }
});

test("model intent and deterministic fallback use distinct colors", async t => {
  const h = await createDisplaySession();
  t.after(() => h.close());
  const colors = { fg: (color: string, value: string) => `<${color}>${value}</${color}>`, bold: (s: string) => s };
  const read = h.displayTool("read");
  assert.match(text(read.renderCall({ path: "sample.txt", displaySummary: "Checking the sample file" }, colors, {})), /<accent>Checking the sample file<\/accent>/);
  assert.match(text(read.renderCall({ path: "sample.txt" }, colors, {})), /<muted>Read file<\/muted>/);
});

test("live calls show fallback intent while restored and completed calls do not invent it", async t => {
  initTheme("dark", false);
  const h = await createDisplaySession();
  t.after(() => h.close());
  const tui = new TuiMainScreen(new AggregateTerminal());
  const row = new ToolExecutionComponent("read", "read-live", { path: "sample.txt" }, {}, h.renderers("read"), tui, h.cwd);
  row.setArgsComplete();
  await h.session.extensionRunner.emit({ type: "tool_execution_start", toolCallId: "read-live", toolName: "read", args: { path: "sample.txt" } });
  row.markExecutionStarted();
  assert.match(text(row), /Read file/);
  const result = { content: [{ type: "text" as const, text: "done" }], details: undefined };
  await h.session.extensionRunner.emit({ type: "tool_execution_end", toolCallId: "read-live", toolName: "read", result, isError: false });
  row.updateResult({ ...result, isError: false });
  assert.doesNotMatch(text(row), /Read file/);
  for (const name of Object.keys(factories)) {
    const args = { path: "history.ts", pattern: "needle", command: "pnpm test", content: "content", edits: [] };
    assert.doesNotMatch(text(h.displayTool(name).renderCall(args, theme, { state: {}, executionStarted: false, argsComplete: false, isPartial: false })), / — /);
  }
  assert.match(text(h.displayTool("read").renderCall({ path: "stored.ts", displaySummary: "Stored intent" }, theme, { executionStarted: false })), /Stored intent/);
});

test("cooperative tools retain intent stripping and result presentations", async t => {
  const h = await createDisplaySession({ ...defaults, mcpOutputMode: "summary" });
  t.after(() => h.close());
  let executed: unknown;
  const tool = decorateToolForDisplay(withDisplaySummary({
    name: "custom_probe", label: "Probe", description: "Probe", parameters: { type: "object", properties: { query: { type: "string" } } },
    execute: async (_id: string, args: unknown) => { executed = args; return { content: [{ type: "text", text: "ok" }], details: undefined }; },
  }), {
    kind: "generic", outputMode: "inherit", overrideExistingRenderers: true,
    getCallPresentation: () => ({ target: "remote alpha", metadata: ["cached"] }),
    getResultPresentation: () => ({ summary: "Remote · 2 values", previewStartLine: 2 }),
  });
  const args = { query: "alpha", displaySummary: "Checking the remote value" };
  assert.match(text(tool.renderCall!(args, theme, {})), /custom_probe\(remote alpha · cached\).*Checking the remote value/);
  const result = { content: [{ type: "text", text: "alpha\nbeta" }], details: {} };
  assert.match(text(tool.renderResult!(result, { expanded: false, isPartial: false }, theme, {})), /Remote · 2 values/);
  assert.match(text(tool.renderResult!(result, { expanded: false, isPartial: false }, theme, { isError: true })), /alpha/);
  await tool.execute("custom", args);
  assert.deepEqual(executed, { query: "alpha" });
});

test("cooperative preview skips duplicated headers", async t => {
  const h = await createDisplaySession({ ...defaults, mcpOutputMode: "preview", previewRows: 3 });
  t.after(() => h.close());
  const tool = decorateToolForDisplay({ name: "preview_probe", execute: async () => ({ content: [], details: undefined }) }, {
    kind: "generic", outputMode: "inherit", getResultPresentation: () => ({ summary: "Remote · 2 values", previewStartLine: 2 }),
  });
  const result = { content: [{ type: "text", text: "duplicate title\nduplicate metadata\nalpha\nbeta" }], details: {} };
  assert.equal(text(tool.renderResult!(result, { expanded: false, isPartial: false }, theme, {})), "  ⎿ Remote · 2 values\n    alpha\n    beta");
});

for (const layout of ["individual", "aggregate"] as const) {
  test(`${layout} leaves non-Bash schemas intact and respects externally owned built-ins`, async t => {
    const external = { ...createReadToolDefinition(process.cwd()), description: "External read owner" };
    const h = await createDisplaySession({ ...defaults, toolCallLayout: layout }, [external]);
    t.after(() => h.close());
    assert.equal(h.session.getToolDefinition("read")!.execute, external.execute);
    assert.equal(h.session.getToolDefinition("read")!.parameters, external.parameters);
    for (const name of Object.keys(factories).filter(n => n !== "bash")) {
      assert.equal((h.session.getToolDefinition(name)!.parameters as any).properties.displaySummary, undefined);
    }
    assert.equal(h.session.extensionRunner.getAllRegisteredTools().filter(t => t.definition.name === "read").length, 1);
  });
}

test("disabled semantic overrides and passthrough names leave the native tools available", async t => {
  const h = await createDisplaySession({ ...defaults, passthroughToolNames: ["write"], registerToolOverrides: { ...defaults.registerToolOverrides, bash: false } });
  t.after(() => h.close());
  assert.equal(h.session.extensionRunner.getAllRegisteredTools().length, 0);
  assert.equal(h.renderers("write"), h.session.getToolDefinition("write"));
  assert.equal(h.renderers("bash"), h.session.getToolDefinition("bash"));
  assert.ok(h.session.getActiveToolNames().includes("bash"));
});

test("semantic decorations do not activate tools excluded from the selected loadout", async t => {
  const h = await createDisplaySession(defaults, [], { settings: { defaultTools: ["read"] } });
  t.after(() => h.close());
  assert.deepEqual(h.session.getActiveToolNames(), ["read"]);
  await h.session.reload();
  assert.deepEqual(h.session.getActiveToolNames(), ["read"]);
});

test("Bash preserves the merged Pi shell settings", async t => {
  const h = await createDisplaySession(defaults, [], { settings: { shellCommandPrefix: "printf 'prefix-output\\n'" } });
  t.after(() => h.close());
  const result = await h.session.getToolDefinition("bash")!.execute("prefix", { command: "printf 'command-output\\n'" }, undefined, undefined, h.session.extensionRunner.createToolContext("prefix", undefined));
  assert.match(JSON.stringify(result.structuredContent), /prefix-output\\ncommand-output/);
  const broken = await createDisplaySession(defaults, [], { settings: { shellPath: "/definitely/missing/bash" } });
  t.after(() => broken.close());
  await assert.rejects(broken.session.getToolDefinition("bash")!.execute("bad", { command: "printf test" }, undefined, undefined, broken.session.extensionRunner.createToolContext("bad", undefined)), /custom shell path not found/i);
});

test("pending cooperative decorations restore only the renderers they still own", async () => {
  const key = Symbol.for("pi-tool-display-intent.pendingDecorations.v1");
  const global = globalThis as any;
  const previous = global[key];
  const tool: any = { name: "mcp", parameters: {}, execute: async () => ({ content: [], details: undefined }) };
  global[key] = [{ tool, adapter: { kind: "mcp" } }];
  const h = await createDisplaySession();
  try {
    assert.equal(typeof tool.renderCall, "function");
    assert.equal(global[key].length, 0);
    const later = () => new Text("later renderer", 0, 0);
    tool.renderCall = later;
    await h.close();
    assert.equal(tool.renderCall, later);
    assert.equal(tool.renderResult, undefined);
  } finally {
    if (previous === undefined) delete global[key]; else global[key] = previous;
  }
});
