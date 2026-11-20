import assert from "node:assert/strict";
import test from "node:test";
import { Text } from "@earendil-works/pi-tui";
import { isMcpToolCandidate } from "../src/tool-metadata.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG as defaults } from "../src/types.ts";
import { createDisplaySession } from "./helpers/display-session.ts";

const theme = { fg: (_color: string, value: string) => value, bold: (value: string) => value } as any;
const render = (component: any) => component.render(120).map((s: string) => s.trimEnd()).join("\n").trim();

for (const [description, input, expected] of [
  ["proxy name", { name: "mcp" }, true],
  ["MCP description", { name: "web_search", description: "MCP tool for web search" }, true],
  ["case-insensitive description", { name: "web_search", description: "mcp tool" }, true],
  ["word boundary", { name: "some_tool", description: "McPherson's tool" }, false],
  ["underscore boundary", { name: "some_tool", description: "mcp_test function" }, false],
  ["not a prefix word", { name: "some_tool", description: "mcpExample" }, false],
  ["not mcpify", { name: "mcpify", description: "Tool to mcpify your code" }, false],
  ["adapter source", { name: "xcodebuild_list_sims", sourceInfo: { source: "local", path: "C:/Users/test/.pi/agent/extensions/pi-mcp-adapter/index.ts" } }, true],
  ["missing description", { name: "random_tool" }, false],
  ["empty description", { name: "random_tool", description: "" }, false],
  ["whitespace", { name: "random_tool", description: "   " }, false],
  ["null", null, false], ["undefined", undefined, false], ["string", "mcp", false],
] as const) {
  test(`MCP recognition: ${description}`, () => assert.equal(isMcpToolCandidate(input), expected));
}

test("MCP display resolves without changing the real execution definition or prompt metadata", async t => {
  const execute = async () => ({ content: [{ type: "text" as const, text: "executed" }], details: undefined });
  const parameters = { type: "object", properties: {} };
  const h = await createDisplaySession(defaults, [{ name: "mcp", description: "MCP gateway", parameters, execute, promptSnippet: "Original snippet", promptGuidelines: ["Original guideline"] }]);
  t.after(() => h.close());
  const definition = h.session.getToolDefinition("mcp")!;
  const renderer = h.renderers("mcp")!;
  assert.equal(definition.execute, execute);
  assert.equal(definition.parameters, parameters);
  assert.equal(definition.promptSnippet, "Original snippet");
  assert.deepEqual(definition.promptGuidelines, ["Original guideline"]);
  assert.equal(definition.renderCall, undefined);
  assert.equal(typeof renderer.renderCall, "function");
  assert.equal(typeof renderer.renderResult, "function");
});

test("MCP-style late tools resolve immediately without lifecycle retries or tool re-registration", async t => {
  const h = await createDisplaySession();
  t.after(() => h.close());
  const before = h.session.extensionRunner.getAllRegisteredTools().length;
  const parameters = { type: "object", properties: {} };
  h.api.registerTool({ name: "mcp__late__probe", label: "Probe", description: "A late probe", parameters, execute: async () => ({ content: [], details: undefined }) });
  assert.equal(h.session.extensionRunner.getAllRegisteredTools().length, before + 1);
  for (let i = 0; i < 3; i++) {
    assert.match(render(h.displayTool("mcp__late__probe").renderCall({}, theme)), /MCP/);
    assert.equal(h.session.getToolDefinition("mcp__late__probe")!.parameters, parameters);
  }
  assert.equal(h.session.extensionRunner.getAllRegisteredTools().length, before + 1);
});

test("historical MCP names resolve with no definition or executable registration", async t => {
  const h = await createDisplaySession();
  t.after(() => h.close());
  const before = h.session.getActiveToolNames();
  const renderer = h.renderers("mcp__old__probe")!;
  assert.equal(h.session.getToolDefinition("mcp__old__probe"), undefined);
  assert.match(render(renderer.renderCall!({ query: "old" }, theme, { executionStarted: false, state: {} } as any)), /mcp__old__probe/);
  assert.deepEqual(h.session.getActiveToolNames(), before);
});

test("MCP proxy call presentation keeps its target and argument count", async t => {
  const h = await createDisplaySession(defaults, [{ name: "mcp" }]);
  t.after(() => h.close());
  const call = h.displayTool("mcp").renderCall;
  assert.equal(render(call({}, theme)), "● MCP(status) (no args) — Run mcp");
  assert.equal(render(call({ tool: "read_file", server: "filesystem" }, theme)), "● MCP(call filesystem:read_file) (2 args) — Run mcp");
});

test("MCP tools preserve specialized renderers through explicit delegation", async t => {
  const original = { name: "mcp", renderCall: () => new Text("SPECIAL MCP CALL", 0, 0), renderResult: () => new Text("SPECIAL MCP RESULT", 0, 0) };
  const h = await createDisplaySession({ ...defaults, mcpOutputMode: "summary" }, [original]);
  t.after(() => h.close());
  const tool = h.displayTool("mcp");
  assert.match(render(tool.renderCall({}, theme)), /SPECIAL MCP CALL/);
  assert.match(render(tool.renderResult({ content: [], details: {} }, { expanded: false, isPartial: false }, theme)), /SPECIAL MCP RESULT/);
  assert.equal(h.session.getToolDefinition("mcp")!.renderCall, original.renderCall);
});

test("MCP display remains independent of built-in override switches and supports multiple tools", async t => {
  const h = await createDisplaySession({ ...defaults, registerToolOverrides: { read: false, grep: false, find: false, ls: false, bash: false, edit: false, write: false } }, [
    { name: "filesystem_list", description: "List files via MCP" },
    { name: "db_query", description: "Query via MCP" },
    { name: "web_search", description: "Search via MCP" },
  ]);
  t.after(() => h.close());
  for (const name of ["filesystem_list", "db_query", "web_search"]) {
    assert.match(render(h.displayTool(name).renderCall({}, theme)), /MCP/);
    assert.equal(h.session.getToolDefinition(name)!.renderCall, undefined);
  }
});
