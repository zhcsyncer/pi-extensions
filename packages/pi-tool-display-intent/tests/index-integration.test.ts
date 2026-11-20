import assert from "node:assert/strict";
import test from "node:test";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import toolDisplayExtension, { publishToolDisplayMigrationNotice } from "../src/index.ts";
import { createDisplaySession } from "./helpers/display-session.ts";

const load = () => createDisplaySession(undefined, [], { display: false, factories: [toolDisplayExtension] });

test("migration notice uses notify and does not park a long status line", () => {
  const statuses: unknown[] = [];
  const notices: unknown[] = [];
  publishToolDisplayMigrationNotice({
    setStatus: (key, text) => statuses.push({ key, text }),
    notify: (message, level) => notices.push({ message, level }),
  }, "bashCollapsedLines was removed; adjust results.previewRows");
  assert.deepEqual(notices, [{ message: "bashCollapsedLines was removed; adjust results.previewRows", level: "warning" }]);
  assert.deepEqual(statuses, [{ key: "tool-display-intent-migration", text: undefined }]);
});

test("entry point loads through the real extension loader and registers its lifecycle and command", async t => {
  const h = await load();
  t.after(() => h.close());
  const runner = h.session.extensionRunner;
  assert.ok(runner.hasHandlers("session_start"));
  assert.ok(runner.hasHandlers("before_agent_start"));
  assert.ok(runner.hasHandlers("session_shutdown"));
  assert.equal(runner.hasHandlers("context"), false);
  const command = runner.getCommand("tools")!;
  assert.ok(command);
  assert.equal(typeof command.getArgumentCompletions, "function");
});

test("entry point uses renderers without replacing display-only built-in definitions", async t => {
  const h = await load();
  t.after(() => h.close());
  assert.deepEqual(h.session.extensionRunner.getAllRegisteredTools().map(t => t.definition.name).sort(), ["bash", "write"]);
  for (const name of ["read", "grep", "find", "ls", "bash", "edit", "write"]) {
    assert.equal(typeof h.renderers(name)!.renderCall, "function");
    assert.equal(typeof h.renderers(name)!.renderResult, "function");
    assert.ok(h.session.getToolDefinition(name)!.promptSnippet?.trim());
  }
});

test("entry point reload keeps exactly one tools command and does not duplicate semantic tools", async t => {
  const h = await load();
  t.after(() => h.close());
  const active = h.session.getActiveToolNames();
  await h.session.reload();
  await h.session.reload();
  assert.equal(h.session.extensionRunner.getRegisteredCommands().filter(c => c.name === "tools").length, 1);
  assert.deepEqual(h.session.extensionRunner.getAllRegisteredTools().map(t => t.definition.name).sort(), ["bash", "write"]);
  assert.deepEqual(h.session.getActiveToolNames(), active);
});

test("entry point keeps externally owned tools and works without codemode", async t => {
  const execute = async () => ({ content: [], details: undefined });
  const h = await createDisplaySession(undefined, [{ name: "read", execute }, { name: "edit", execute }], { display: false, factories: [toolDisplayExtension] });
  t.after(() => h.close());
  assert.equal(h.session.getToolDefinition("read")!.execute, execute);
  assert.equal(h.session.getToolDefinition("edit")!.execute, execute);
  assert.equal(h.session.getToolDefinition("codemode"), undefined);
  const active = h.session.getActiveToolNames();
  h.renderers("codemode");
  assert.deepEqual(h.session.getActiveToolNames(), active);
});

test("missing required SDK command capability fails explicitly", () => {
  const api = { registerTool() {}, registerToolRenderer() {}, on() {}, getAllTools: () => [], getCommands: () => [] } as unknown as ExtensionAPI;
  assert.throws(() => toolDisplayExtension(api), /registerCommand/i);
});

test("missing required SDK lifecycle capability fails explicitly", () => {
  const api = { registerTool() {}, registerToolRenderer() {}, registerCommand() {} } as unknown as ExtensionAPI;
  assert.throws(() => toolDisplayExtension(api), /on is not a function/i);
});
