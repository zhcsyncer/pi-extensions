import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { normalizeToolDisplayConfig } from "../src/config-store.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG as defaults, type ToolDisplayConfig } from "../src/types.ts";
import { createDisplaySession } from "./helpers/display-session.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as any;
const text = (component: any) => component.render(120).map((s: string) => s.trimEnd()).join("\n").trim();
const config = (customToolOverrides: Record<string, any>, extra: Partial<ToolDisplayConfig> = {}): ToolDisplayConfig => ({ ...defaults, ...extra, customToolOverrides });
const output = (tool: any, value: string, options = {}, context = {}) => text(tool.renderResult({ content: [{ type: "text", text: value }], details: {} }, { expanded: false, isPartial: false, ...options }, theme, context));

test("custom overrides default to an empty opt-in map", () => {
  assert.deepEqual(normalizeToolDisplayConfig({}).customToolOverrides, {});
});

test("custom override normalization handles shorthand, invalid entries and built-in exclusions", () => {
  assert.deepEqual(normalizeToolDisplayConfig({ customToolOverrides: {
    ide_find_symbol: true, " agent_gateway ": { outputMode: "preview" },
    mcp_gateway: { kind: "mcp", outputMode: "hidden" }, disabled_tool: false,
    invalid_kind: { kind: "terminal", outputMode: "verbose" }, read: { kind: "mcp", outputMode: "summary" }, "": {}, "   ": true,
  } }).customToolOverrides, {
    ide_find_symbol: { kind: "generic", outputMode: "summary" }, agent_gateway: { kind: "generic", outputMode: "preview" },
    mcp_gateway: { kind: "mcp", outputMode: "hidden" }, invalid_kind: { kind: "generic", outputMode: "summary" },
  });
  for (const value of [null, true, "name", [], 42]) {
    assert.deepEqual(normalizeToolDisplayConfig({ customToolOverrides: value }).customToolOverrides, {});
  }
  assert.deepEqual(normalizeToolDisplayConfig({ customToolOverrides: {
    hidden: { outputMode: "hidden", label: "ignored" }, summary: { outputMode: "summary", pathFields: ["file_path"] }, preview: { outputMode: "preview", renderShell: "self" },
  } }).customToolOverrides, {
    hidden: { kind: "generic", outputMode: "hidden" }, summary: { kind: "generic", outputMode: "summary" }, preview: { kind: "generic", outputMode: "preview" },
  });
});

for (const layout of ["individual", "aggregate"] as const) {
  test(`${layout} preserves specialized custom content and real definitions`, async t => {
    const original = {
      name: "ide_find_symbol", description: "Find symbols", parameters: { type: "object", properties: {} },
      renderCall: () => new Text("SPECIAL CALL", 0, 0), renderResult: () => new Text("SPECIAL RESULT", 0, 0),
    };
    const h = await createDisplaySession(config({ ide_find_symbol: { outputMode: "summary" } }, { toolCallLayout: layout }), [original]);
    t.after(() => h.close());
    const displayed = h.displayTool(original.name);
    assert.match(text(displayed.renderCall({ query: "Widget" }, theme)), /SPECIAL CALL/);
    assert.match(output(displayed, "ignored"), /SPECIAL RESULT/);
    assert.equal(h.session.getToolDefinition(original.name)!.renderCall, original.renderCall);
    assert.equal(h.session.getToolDefinition(original.name)!.parameters, original.parameters);
  });
}

test("generic and explicit MCP custom tools retain their respective argument presentations", async t => {
  const h = await createDisplaySession(config({
    remote_gateway: {}, remote_gateway_structured: { kind: "mcp" },
  }), [{ name: "remote_gateway" }, { name: "remote_gateway_structured" }]);
  t.after(() => h.close());
  const args = { tool: "read_file", server: "filesystem" };
  assert.equal(text(h.displayTool("remote_gateway").renderCall(args, theme)), "● remote_gateway(tool=read_file · server=filesystem) — Run remote_gateway");
  assert.equal(text(h.displayTool("remote_gateway_structured").renderCall(args, theme)), "● MCP(call filesystem:read_file) (2 args) — Run mcp");
});

test("generic output modes keep errors visible, including empty errors", async t => {
  const modes = ["hidden", "summary", "preview"] as const;
  const h = await createDisplaySession(config(Object.fromEntries(modes.map(mode => [`probe_${mode}`, { outputMode: mode }]))), modes.map(mode => ({ name: `probe_${mode}` })));
  t.after(() => h.close());
  for (const mode of modes) {
    const tool = h.displayTool(`probe_${mode}`);
    assert.equal(output(tool, "Remote request failed\nstack one\nstack two", {}, { isError: true }), "⎿ Remote request failed • Ctrl+O to expand");
    assert.equal(output(tool, "Remote request failed\nstack one\nstack two", { expanded: true }, { isError: true }), "⎿ Remote request failed\n    stack one\n    stack two");
  }
  assert.equal(output(h.displayTool("probe_hidden"), "successful but hidden"), "");
  assert.equal(output(h.displayTool("probe_hidden"), "", {}, { isError: true }), "⎿ Tool failed. • Ctrl+O to expand");
});

test("missing configured tools get historical display without phantom execution registration", async t => {
  const h = await createDisplaySession(config({ missing_tool: { outputMode: "summary" } }));
  t.after(() => h.close());
  assert.equal(h.session.getToolDefinition("missing_tool"), undefined);
  assert.equal(h.session.getActiveToolNames().includes("missing_tool"), false);
  assert.equal(typeof h.renderers("missing_tool")!.renderCall, "function");
});

test("generic calls safely summarize absent, scalar and nested arguments", async t => {
  const h = await createDisplaySession(config({ argument_probe: { outputMode: "summary" } }), [{ name: "argument_probe" }]);
  t.after(() => h.close());
  const call = h.displayTool("argument_probe").renderCall;
  for (const args of [undefined, null, "raw", ["a", "b"]]) {
    assert.equal(text(call(args, theme)), "● argument_probe(no args) — Run argument_probe");
  }
  assert.equal(text(call({ path: "src/index.ts", options: { recursive: true }, tags: ["a", "b"] }, theme)), "● argument_probe(path=src/index.ts · options{…} · tags[2]) — Run argument_probe");
});

test("custom previews retain collapsed, expanded, partial and empty output behavior", async t => {
  const h = await createDisplaySession(config({ preview_probe: { outputMode: "preview" } }, { previewRows: 2 }), [{ name: "preview_probe" }]);
  t.after(() => h.close());
  const tool = h.displayTool("preview_probe");
  assert.equal(output(tool, "alpha\nbeta\ngamma\ndelta"), "⎿ alpha\n    beta\n    ... (2 more lines • Ctrl+O to expand)");
  assert.equal(output(tool, "alpha\nbeta\ngamma\ndelta", { expanded: true }), "⎿ alpha\n    beta\n    gamma\n    delta");
  assert.equal(output(tool, "still running", { isPartial: true }), "⎿ running...");
  assert.equal(output(tool, ""), "⎿ (no output)");
  assert.equal(text(tool.renderResult({ content: [{ type: "image", data: "ignored" }], details: {} }, { expanded: false, isPartial: false }, theme)), "⎿ (no output)");
});

test("explicit MCP custom presentation recognizes proxy argument variants", async t => {
  const h = await createDisplaySession(config({ custom_gateway: { kind: "mcp", outputMode: "summary" } }), [{ name: "custom_gateway" }]);
  t.after(() => h.close());
  const call = h.displayTool("custom_gateway").renderCall;
  for (const [args, target, count] of [
    [{}, "status", "no args"], [{ connect: "filesystem" }, "connect filesystem", "1 arg"],
    [{ describe: "read_file", server: "filesystem" }, "describe read_file @filesystem", "2 args"],
    [{ search: "browser", server: "exa" }, 'search "browser" @exa', "2 args"],
    [{ server: "filesystem" }, "tools filesystem", "1 arg"],
    [{ tool: "read_file", server: "filesystem" }, "call filesystem:read_file", "2 args"],
  ] as const) assert.equal(text(call(args, theme)), `● MCP(${target}) (${count}) — Run mcp`);
});

test("custom display preserves preparation and execution, including tools registered late", async t => {
  const h = await createDisplaySession(config({ late_custom: { outputMode: "summary" } }));
  t.after(() => h.close());
  const parameters = { type: "object", properties: { query: { type: "string" } } };
  const prepareArguments = (args: unknown) => args;
  const execute = async () => ({ content: [{ type: "text" as const, text: "executed" }], details: undefined });
  h.api.registerTool({ name: "late_custom", label: "Late", description: "Late", parameters, prepareArguments, execute });
  const actual = h.session.getToolDefinition("late_custom")!;
  assert.equal(actual.parameters, parameters);
  assert.equal(actual.prepareArguments, prepareArguments);
  assert.equal(actual.execute, execute);
  assert.equal(actual.renderCall, undefined);
  assert.equal(text(h.displayTool("late_custom").renderCall({ query: "late" }, theme)), "● late_custom(query=late) — Run late_custom");
});
