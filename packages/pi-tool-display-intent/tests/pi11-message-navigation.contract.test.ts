import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, afterEach, test } from "node:test";
import type { ExtensionFactory, ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";

// Must precede SDK/product imports: no user config, executables, accounts or terminal.
const sandbox = mkdtempSync(join(tmpdir(), "pi11-d4-contract-"));
const previousEnv = { ...process.env };
process.env.PI_CODING_AGENT_DIR = join(sandbox, "agent");
process.env.HOME = sandbox;
process.env.PATH = join(sandbox, "empty-bin");
mkdirSync(process.env.PATH);
mkdirSync(process.env.PI_CODING_AGENT_DIR);
after(() => {
  for (const key of Object.keys(process.env)) if (!(key in previousEnv)) delete process.env[key];
  Object.assign(process.env, previousEnv);
  rmSync(sandbox, { recursive: true, force: true });
});

const sdk = await import("@earendil-works/pi-coding-agent");
const tui = await import("@earendil-works/pi-tui");
// Published SDK declaration: constructor(userBindings?, configPath?); not a root value export.
const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
const { createDisplaySession } = await import("./helpers/display-session.ts");
const { AggregateTerminal } = await import("./helpers/aggregate-terminal.ts");
const { default: registerNative } = await import("../src/user-message-box-native.ts");
const { default: registerDisplay } = await import("../src/index.ts");
const { patchNativeUserMessagePrototype } = await import("../src/user-message-box-renderer.ts");
const { unregisterUserMessageRenderPrototypePatch } = await import("../src/user-message-box-patch.ts");
const { loadToolDisplayConfig, saveToolDisplayConfig, serializeToolDisplayConfigV2 } = await import("../src/config-store.ts");
const { DEFAULT_TOOL_DISPLAY_CONFIG } = await import("../src/types.ts");
sdk.initTheme("dark", false);
const themeSession = await createDisplaySession(DEFAULT_TOOL_DISPLAY_CONFIG, [], { display: false });
const theme = themeSession.session.extensionRunner.getUIContext().theme;
await themeSession.close();

const userPrototype = sdk.UserMessageComponent.prototype;
const nativeRender = userPrototype.render;
// Test isolation only, after lifecycle assertions: never forge ownership metadata.
afterEach(() => {
  unregisterUserMessageRenderPrototypePatch(userPrototype);
  userPrototype.render = nativeRender;
});
const markerPattern = /\x1b\]133;([ABC])(?:\x07|\x1b\\)/g;
const stripMarkers = (line: string) => line.replace(markerPattern, "");
const visible = (lines: string[]) => lines.map(tui.stripTerminalSequences).join("\n");
function boundaries(lines: string[], width: number) {
  assert.ok(lines.length > 0, "visible message must not disappear");
  assert.deepEqual([...lines.join("\n").matchAll(markerPattern)].map(match => match[1]), ["A", "B", "C"], "exactly one ordered host boundary");
  assert.match(lines[0], /^\x1b\]133;A(?:\x07|\x1b\\)/, "A precedes styles and visible content");
  assert.match(lines.at(-1)!, /\x1b\]133;B(?:\x07|\x1b\\)\x1b\]133;C(?:\x07|\x1b\\)/, "B/C belong to the final line");
  for (const line of lines) {
    assert.equal(tui.visibleWidth(line), tui.visibleWidth(stripMarkers(line)), "markers consume no columns");
    assert.ok(tui.visibleWidth(line) <= width, "output fits terminal width");
  }
}

async function start(config = structuredClone(DEFAULT_TOOL_DISPLAY_CONFIG), factories?: ExtensionFactory[]) {
  const h = await createDisplaySession(config, [], {
    display: false,
    factories: factories ?? [pi => registerNative(pi, () => config)],
  });
  const terminal = new AggregateTerminal();
  const screen = new tui.TuiMainScreen(terminal);
  const runner = h.session.extensionRunner;
  let drivePanel: ((component: Component) => void) | undefined;
  let opened = false;
  const uiContext: ExtensionUIContext = {
    ...runner.getUIContext(), theme,
    custom: async factory => {
      assert.ok(drivePanel, "fixture: unexpected custom UI interaction");
      opened = true;
      let result;
      let closed = false;
      const component = await factory(screen, theme, new KeybindingsManager(), value => { result = value; closed = true; });
      screen.addChild(component);
      screen.setFocus(component);
      screen.start();
      try {
        screen.renderNow();
        drivePanel(component);
        assert.ok(closed, "Esc closes the real /tools panel");
        return result;
      } finally {
        screen.removeChild(component);
        component.dispose?.();
        screen.stop();
      }
    },
  };
  await h.session.bindExtensions({ uiContext, mode: "tui", onError: error => h.errors.push(error) });
  assert.deepEqual(h.errors, [], "fixture: extension startup must succeed");
  return {
    ...h, terminal, screen,
    async tools(drive: (component: Component) => void) {
      drivePanel = drive; opened = false;
      const currentRunner = h.session.extensionRunner;
      const command = currentRunner.getCommand("tools");
      assert.ok(command, "the real extension registers /tools");
      try {
        await command.handler("", currentRunner.createCommandContext());
        assert.ok(opened, "/tools opens its actual custom UI");
      } finally { drivePanel = undefined; }
    },
  };
}

for (const layout of ["individual", "aggregate"] as const) {
  test(`${layout}: ordinary default is custom; explicit false delegates to actual SDK`, async () => {
    const configFile = join(sandbox, `${layout}.json`);
    const ordinary = "Ordinary question with 中文 and enough words to wrap when resized.";
    const expected = new Map([24, 64].map(width => [width, nativeRender.call(new sdk.UserMessageComponent(ordinary), width)]));
    writeFileSync(configFile, JSON.stringify({ version: 2, toolCalls: { layout } }));
    let h = await start(loadToolDisplayConfig(configFile).config);
    try {
      const message = new sdk.UserMessageComponent(ordinary);
      assert.notDeepEqual(message.render(64), expected.get(64), "default keeps the custom user box rather than native output");
    } finally { await h.close(); }
    writeFileSync(configFile, JSON.stringify({ version: 2, toolCalls: { layout }, transcript: { userMessageBox: false } }));
    h = await start(loadToolDisplayConfig(configFile).config);
    try {
      const message = new sdk.UserMessageComponent(ordinary);
      for (const width of [64, 64, 24, 64]) {
        assert.deepEqual(message.render(width), expected.get(width), "false preserves native content, padding and markers through cache/resize");
      }
    } finally { await h.close(); }
  });
}

test("explicit false survives public load/save/serialize; missing field defaults true", () => {
  const file = join(sandbox, "roundtrip.json");
  writeFileSync(file, JSON.stringify({ version: 2, transcript: { userMessageBox: false } }));
  const loaded = loadToolDisplayConfig(file).config;
  assert.equal(loaded.enableNativeUserMessageBox, false);
  assert.deepEqual(serializeToolDisplayConfigV2(loaded).transcript, { userMessageBox: false });
  saveToolDisplayConfig(loaded, file);
  assert.equal(loadToolDisplayConfig(file).config.enableNativeUserMessageBox, false);
  writeFileSync(file, JSON.stringify({ version: 2 }));
  assert.equal(loadToolDisplayConfig(file).config.enableNativeUserMessageBox, true);
});

test("real SDK custom user output has one boundary on warm renders and resize", async () => {
  const h = await start();
  try {
    const message = new sdk.UserMessageComponent("Navigate 中文 **message** with a long enough sentence to wrap.");
    h.screen.addChild(message);
    h.screen.start();
    for (const width of [64, 64, 22, 22, 64]) {
      h.terminal.resize(width, 24);
      h.screen.renderNow();
      boundaries(message.render(width), width);
      assert.match(visible(h.screen.captureRenderState().previousLines), /Navigate/);
    }
    assert.ok(h.terminal.writes.length > 0, "fixture: native TUI painted only the synthetic transport");
  } finally { h.screen.stop(); await h.close(); }
});

// Controlled downstream output isolates T1 marker/routing edges; integration above uses SDK components.
for (const terminator of ["\x07", "\x1b\\"]) {
  test(`custom layout strips ${terminator === "\x07" ? "BEL" : "ST"} markers before measuring and restores them once`, () => {
    const marker = (kind: string) => `\x1b]133;${kind}${terminator}`;
    class Marked { render(_width: number) { return [marker("A") + "中文 alpha", marker("B") + marker("C") + "omega"]; } }
    class Plain { render(_width: number) { return ["中文 alpha", "omega"]; } }
    patchNativeUserMessagePrototype(Marked.prototype, () => theme, () => true);
    patchNativeUserMessagePrototype(Plain.prototype, () => theme, () => true);
    try {
      const marked = new Marked();
      const plain = new Plain();
      for (const width of [40, 40, 18, 40]) {
        const lines = marked.render(width);
        boundaries(lines, width);
        assert.deepEqual(lines.map(stripMarkers), plain.render(width).map(stripMarkers), "marker encoding does not alter layout or visible text");
      }
    } finally {
      unregisterUserMessageRenderPrototypePatch(Marked.prototype);
      unregisterUserMessageRenderPrototypePatch(Plain.prototype);
    }
  });
}

test("empty downstream stays zero height", () => {
  class Empty { render(_width: number): string[] { return []; } }
  patchNativeUserMessagePrototype(Empty.prototype, () => theme, () => true);
  try {
    assert.deepEqual(new Empty().render(40), [], "empty is not a synthetic navigation stop");
  } finally { unregisterUserMessageRenderPrototypePatch(Empty.prototype); }
});

test("single-line steer starts with A, not B/C", () => {
  class Single { render(_width: number) { return ["ordinary"]; } }
  patchNativeUserMessagePrototype(Single.prototype, () => theme, () => true, () => true, () => ({ lines: ["↳ turn left"] }));
  try {
    const single = new Single();
    for (const width of [40, 40, 20]) {
      const lines = single.render(width);
      assert.equal(lines.length, 1);
      boundaries(lines, width);
      assert.equal(visible(lines), "↳ turn left");
    }
  } finally {
    unregisterUserMessageRenderPrototypePatch(Single.prototype);
  }
});

test("ordinary opt-out never bypasses aggregate steer hidden/expanded routing", () => {
  let enabled = true;
  let hide = true;
  class Message { render(_width: number) { return ["native ordinary"]; } }
  const steer = new Message();
  const ordinary = new Message();
  patchNativeUserMessagePrototype(Message.prototype, () => theme, () => enabled, () => true,
    instance => instance === steer ? (hide ? { hide: true } : { lines: ["│ ↳ revised instruction"] }) : undefined);
  try {
    assert.deepEqual(steer.render(40), []);
    enabled = false;
    assert.deepEqual(steer.render(40), [], "turning ordinary box off must not expose a hidden steer");
    assert.deepEqual(ordinary.render(40), ["native ordinary"]);
    hide = false;
    const expanded = steer.render(40);
    assert.equal(visible(expanded), "│ ↳ revised instruction");
    boundaries(expanded, 40);
  } finally { unregisterUserMessageRenderPrototypePatch(Message.prototype); }
});

test("opt-out preserves a cooperating downstream renderer byte-for-byte", async () => {
  const downstream = function (this: InstanceType<typeof sdk.UserMessageComponent>, width: number) {
    return nativeRender.call(this, width).map(line => line.replace(/\x1b\]133;([ABC])\x07/g, "\x1b]133;$1\x1b\\"));
  };
  userPrototype.render = downstream;
  const config = { ...structuredClone(DEFAULT_TOOL_DISPLAY_CONFIG), enableNativeUserMessageBox: false };
  let h: Awaited<ReturnType<typeof start>> | undefined;
  try {
    const message = new sdk.UserMessageComponent("Cooperating renderer owns its ST encoding and padding.");
    const expected = downstream.call(message, 44);
    h = await start(config);
    assert.deepEqual(message.render(44), expected);
    assert.deepEqual(message.render(44), expected, "cache must not add another boundary");
  } finally {
    await h?.close();
    userPrototype.render = nativeRender;
  }
});

test("assistant navigation remains native, including tool-call batches", async () => {
  const make = (toolCall: boolean) => new sdk.AssistantMessageComponent({
    role: "assistant", api: "openai-completions", provider: "offline", model: "fixture",
    content: [{ type: "text", text: "Assistant answer" }, ...(toolCall ? [{ type: "toolCall" as const, id: "call-1", name: "read", arguments: { path: "never-opened" } }] : [])],
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: toolCall ? "toolUse" : "stop", timestamp: 1,
  });
  const expected = [make(false).render(44), make(true).render(44)];
  boundaries(expected[0], 44);
  assert.deepEqual([...expected[1].join("").matchAll(markerPattern)], [], "SDK tool batch has no assistant boundary");
  const h = await start(structuredClone(DEFAULT_TOOL_DISPLAY_CONFIG), [registerDisplay]);
  try {
    for (const [index, toolCall] of [false, true].entries()) assert.deepEqual(make(toolCall).render(44), expected[index]);
  } finally { await h.close(); }
});

for (const layout of ["individual", "aggregate"] as const) {
  test(`${layout}: /tools saves ordinary-message preference and refreshes history across reload`, async () => {
    // Initial setup only. Every preference change below is made by the actual settings UI.
    const config = { ...structuredClone(DEFAULT_TOOL_DISPLAY_CONFIG), toolCallLayout: layout };
    saveToolDisplayConfig(config);
    const h = await start(config, [registerDisplay]);
    const history = new sdk.UserMessageComponent("Existing history");
    const native = nativeRender.call(new sdk.UserMessageComponent("Existing history"), 44);
    const row = (panel: Component) => {
      const label = panel.render(80).map(tui.stripTerminalSequences).find(line => line.includes("User message box"));
      assert.ok(label, "product: /tools exposes User message box in both layouts");
      return label;
    };
    const search = (panel: Component) => {
      assert.ok(panel.handleInput, "fixture: settings exposes public keyboard input");
      for (const key of "user") panel.handleInput(key);
    };
    try {
      assert.notDeepEqual(history.render(44), native, "default positive control");
      await h.tools(panel => {
        search(panel);
        assert.match(row(panel), /\bon\b/);
        panel.handleInput!(" ");
        assert.match(row(panel), /\boff\b/);
        assert.equal(loadToolDisplayConfig().config.enableNativeUserMessageBox, false, "Space saves immediately");
        assert.deepEqual(history.render(44), native, "warm history refreshes immediately, without test invalidation");
        panel.handleInput!("\x1b");
      });
      await h.session.reload();
      assert.deepEqual(h.errors, [], "fixture: public reload must succeed");
      assert.deepEqual(history.render(44), native, "existing history remains native after reload");
      assert.deepEqual(new sdk.UserMessageComponent("Existing history").render(44), native, "new components also use the saved preference");
      await h.tools(panel => {
        search(panel);
        assert.match(row(panel), /\boff\b/, "reopened UI reflects saved false");
        panel.handleInput!("\r");
        assert.match(row(panel), /\bon\b/);
        assert.equal(loadToolDisplayConfig().config.enableNativeUserMessageBox, true, "Enter restores and saves true");
        assert.notDeepEqual(history.render(44), native, "restoring true refreshes warm history");
        panel.handleInput!("\x1b");
      });
      await h.session.reload();
      assert.notDeepEqual(history.render(44), native, "restored true survives reload");
      assert.notDeepEqual(new sdk.UserMessageComponent("Existing history").render(44), native);
    } finally { await h.close(); saveToolDisplayConfig(structuredClone(DEFAULT_TOOL_DISPLAY_CONFIG)); }
  });
}

test("old shutdown preserves the new user wrapper; final shutdown restores downstream", async () => {
  const old = await start(structuredClone(DEFAULT_TOOL_DISPLAY_CONFIG), [registerDisplay]);
  const current = await start(structuredClone(DEFAULT_TOOL_DISPLAY_CONFIG), [registerDisplay]);
  let oldClosed = false;
  try {
    const currentWrapper = userPrototype.render;
    const before = new sdk.UserMessageComponent("New owner").render(44);
    assert.notDeepEqual(before, nativeRender.call(new sdk.UserMessageComponent("New owner"), 44), "positive control: new session owns custom rendering");
    await old.close(); oldClosed = true;
    assert.equal(userPrototype.render, currentWrapper, "old shutdown must not replace the current wrapper");
    assert.deepEqual(new sdk.UserMessageComponent("New owner").render(44), before, "old shutdown must leave new owner effective");
  } finally {
    if (!oldClosed) await old.close();
    await current.close();
  }
  assert.deepEqual(new sdk.UserMessageComponent("After final shutdown").render(44),
    nativeRender.call(new sdk.UserMessageComponent("After final shutdown"), 44),
    "the last owner restores its downstream renderer when shutting down");
});

test("shutdown cannot clobber a foreign wrapper installed after the extension", async () => {
  const h = await start(structuredClone(DEFAULT_TOOL_DISPLAY_CONFIG), [registerDisplay]);
  const previous = userPrototype.render;
  const foreign = function (this: InstanceType<typeof sdk.UserMessageComponent>, width: number) {
    return previous.call(this, width).concat("foreign footer");
  };
  let closed = false;
  try {
    assert.notDeepEqual(new sdk.UserMessageComponent("Before foreign owner").render(44),
      nativeRender.call(new sdk.UserMessageComponent("Before foreign owner"), 44), "extension installed its wrapper first");
    userPrototype.render = foreign;
    closed = true;
    await h.close();
    assert.equal(userPrototype.render, foreign, "cleanup must preserve the current foreign owner");
    assert.match(visible(new sdk.UserMessageComponent("Foreign owner").render(44)), /foreign footer/);
  } finally {
    if (!closed) await h.close();
    userPrototype.render = nativeRender;
  }
});
