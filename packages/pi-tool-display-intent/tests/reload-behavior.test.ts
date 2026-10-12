import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { Text } from "@earendil-works/pi-tui";
import toolDisplayExtension from "../src/index.ts";
import { renderBashCall } from "../src/bash-display.ts";
import { createToolDisplayDebugLogger } from "../src/debug-logger.ts";
import { loadToolDisplayConfig, saveToolDisplayConfig } from "../src/config-store.ts";
import { applyToolDisplayMode } from "../src/presets.ts";
import { getToolDisplayApi } from "../tool-display-api-consumer.js";
import { createDisplaySession } from "./helpers/display-session.ts";
import type { PatchableUserMessagePrototype } from "../src/user-message-box-patch.ts";

const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };

test("real reload rebuilds display ownership without duplicate tools or commands", async t => {
  const h = await createDisplaySession(undefined, [], { display: false, factories: [toolDisplayExtension] });
  t.after(() => h.close());
  for (let i = 0; i < 3; i++) {
    const before = h.session.extensionRunner;
    const active = h.session.getActiveToolNames();
    await h.session.reload();
    assert.notEqual(h.session.extensionRunner, before);
    assert.deepEqual(h.session.getActiveToolNames(), active);
    assert.deepEqual(h.session.extensionRunner.getAllRegisteredTools().map(t => t.definition.name).sort(), ["bash", "write"]);
    assert.equal(h.session.extensionRunner.getRegisteredCommands().filter(c => c.name === "tools").length, 1);
    for (const name of ["read", "edit", "grep", "bash", "write"]) {
      assert.equal(typeof h.renderers(name)!.renderCall, "function");
      assert.equal(typeof h.renderers(name)!.renderResult, "function");
    }
  }
});

test("shutdown of an older session leaves the newer display API owner intact", async t => {
  const older = await createDisplaySession();
  const oldApi = getToolDisplayApi();
  const newer = await createDisplaySession();
  t.after(() => newer.close());
  const newApi = getToolDisplayApi();
  assert.notEqual(newApi, oldApi);
  await older.close();
  assert.equal(getToolDisplayApi(), newApi);
  const displayed = newer.displayTool("read").renderCall({ path: "new-owner.txt" }, theme, { state: {} });
  assert.match(displayed.render(120).join("\n"), /new-owner\.txt/);
});

test("late MCP-style registration after reload remains a real tool with a separate renderer", async t => {
  const h = await createDisplaySession();
  t.after(() => h.close());
  await h.session.reload();
  const execute = async () => ({ content: [{ type: "text" as const, text: "sunny" }], details: undefined });
  h.api.registerTool({ name: "mcp__weather__forecast", label: "Weather", description: "Weather", parameters: { type: "object", properties: {} }, execute });
  assert.equal(h.session.getToolDefinition("mcp__weather__forecast")!.execute, execute);
  assert.equal(h.session.getToolDefinition("mcp__weather__forecast")!.renderCall, undefined);
  assert.equal(typeof h.renderers("mcp__weather__forecast")!.renderCall, "function");
});

for (const count of [1, 2]) {
  test(`Bash spinner owns one timer per live render state (${count} rows)`, () => {
    const originalSet = globalThis.setInterval;
    const originalClear = globalThis.clearInterval;
    const timers: ReturnType<typeof setInterval>[] = [];
    const cleared = new Set<ReturnType<typeof setInterval>>();
    globalThis.setInterval = ((fn: any, ms: number) => { const timer = originalSet(fn, ms); timers.push(timer); return timer; }) as typeof setInterval;
    globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => { cleared.add(timer); originalClear(timer); }) as typeof clearInterval;
    try {
      for (let index = 0; index < count; index++) {
        const context = { state: {}, executionStarted: true, isPartial: true, invalidate() {}, lastComponent: undefined as any };
        context.lastComponent = renderBashCall({ command: "test" }, theme, context);
        renderBashCall({ command: "test" }, theme, context);
        assert.equal(timers.length, index + 1);
        context.isPartial = false;
        const completed = renderBashCall({ command: "test" }, theme, context);
        assert.equal(completed, context.lastComponent);
      }
      assert.equal(cleared.size, timers.length);
      renderBashCall({ command: "restored" }, theme, { state: {}, executionStarted: false, isPartial: false, invalidate() {} });
      assert.equal(timers.length, count, "restored rows start no timers");
    } finally {
      globalThis.setInterval = originalSet;
      globalThis.clearInterval = originalClear;
      for (const timer of timers) originalClear(timer);
    }
  });
}

test("old renderer cleanup cannot stop a newer session's timer", async t => {
  const older = await createDisplaySession();
  const newer = await createDisplaySession();
  t.after(() => newer.close());
  const originalSet = globalThis.setInterval;
  const originalClear = globalThis.clearInterval;
  const timers: ReturnType<typeof setInterval>[] = [];
  const cleared = new Set<ReturnType<typeof setInterval>>();
  globalThis.setInterval = ((fn: any, ms: number) => { const timer = originalSet(fn, ms); timers.push(timer); return timer; }) as typeof setInterval;
  globalThis.clearInterval = ((timer: ReturnType<typeof setInterval>) => { cleared.add(timer); originalClear(timer); }) as typeof clearInterval;
  try {
    const old = older.displayTool("bash");
    old.renderCall({ command: "test" }, theme, { state: {}, toolCallId: "old", executionStarted: true, isPartial: true, invalidate() {} });
    const fresh = newer.displayTool("bash");
    fresh.renderCall({ command: "test" }, theme, { state: {}, toolCallId: "new", executionStarted: true, isPartial: true, invalidate() {} });
    assert.equal(timers.length, 2);
    await older.close();
    assert.equal(cleared.has(timers[0]), true);
    assert.equal(cleared.has(timers[1]), false);
  } finally {
    globalThis.setInterval = originalSet;
    globalThis.clearInterval = originalClear;
    for (const timer of timers) originalClear(timer);
  }
});

test("existing user-message prototype patch remains safe across entry-point reload", async t => {
  const h = await createDisplaySession(undefined, [], { display: false, factories: [toolDisplayExtension] });
  t.after(() => h.close());
  const proto = UserMessageComponent.prototype as PatchableUserMessagePrototype;
  assert.ok(proto.__piUserMessageNativePatched);
  const original = proto.__piUserMessageOriginalRender;
  await h.session.reload();
  assert.equal(proto.__piUserMessageOriginalRender, original);
  assert.ok(proto.__piUserMessageNativePatched);
});

test("config fingerprint changes reload and saved modes preserve row budgets", () => {
  const dir = mkdtempSync(join(tmpdir(), "pi-display-config-"));
  try {
    const path = join(dir, "config.json");
    writeFileSync(path, JSON.stringify({ readOutputMode: "hidden" }));
    const initial = loadToolDisplayConfig(path).config;
    assert.equal(initial.readOutputMode, "hidden");
    assert.equal(saveToolDisplayConfig(applyToolDisplayMode(initial, "preview"), path).success, true);
    const reloaded = loadToolDisplayConfig(path).config;
    assert.equal(reloaded.readOutputMode, "preview");
    assert.equal(reloaded.resultMode, "preview");
    assert.equal(reloaded.searchOutputMode, "preview");
    assert.equal(reloaded.previewRows, initial.previewRows);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test("debug logger flush is safe for independent reload instances", async () => {
  for (let i = 0; i < 2; i++) {
    const logger = createToolDisplayDebugLogger({ configFile: "/dev/null/non-existent.json" });
    logger.log("test");
    await assert.doesNotReject(() => logger.flush());
  }
});

test("modal invalidation and disposal remain safe", async () => {
  const { ZellijModal } = await import("../src/zellij-modal.ts");
  const modal = new ZellijModal(new Text("test"), { title: "Test", borderStyle: "square" });
  assert.doesNotThrow(() => modal.dispose());
  assert.doesNotThrow(() => modal.invalidate());
});
