import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { initTheme, UserMessageComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { loadToolDisplayConfig, saveToolDisplayConfig } from "../src/config-store.ts";
import { patchNativeUserMessagePrototype } from "../src/user-message-box-renderer.ts";
import { unregisterUserMessageRenderPrototypePatch, type PatchableUserMessagePrototype } from "../src/user-message-box-patch.ts";

const A = "\x1b]133;A\x07";
const B = "\x1b]133;B\x07";
const C = "\x1b]133;C\x07";
function assertNavigation(lines: string[]) {
  assert.ok(lines[0]?.startsWith(A));
  for (const marker of [A, B, C]) assert.equal(lines.join("\n").split(marker).length - 1, 1);
}

test("D4 public setting persists false, defaults true, and rejects invalid input", () => {
  const root = mkdtempSync(join(tmpdir(), "d4-config-"));
  const path = join(root, "config.json");
  try {
    for (const value of [false, true, undefined, "false"]) {
      writeFileSync(path, JSON.stringify({ version: 2, results: { mode: "summary" }, transcript: { userMessageBox: value } }));
      const loaded = loadToolDisplayConfig(path);
      assert.equal(loaded.config.enableNativeUserMessageBox, value !== false);
      if (typeof value === "string") assert.match(loaded.notice ?? "", /transcript.userMessageBox: expected boolean/);
      else assert.equal(loaded.notice, undefined);
      saveToolDisplayConfig(loaded.config, path);
      assert.equal(loadToolDisplayConfig(path).config.enableNativeUserMessageBox, value !== false);
      if (value === false) assert.equal(JSON.parse(readFileSync(path, "utf8")).transcript.userMessageBox, false);
    }
  } finally { rmSync(root, { recursive: true, force: true }); }
});

test("D4 disabled ordinary rendering delegates exact downstream width/output but steer still routes first", () => {
  let steer: { hide: true } | { lines: string[] } | undefined;
  const downstream = ["\x1b]133;A\x1b\\partner\x1b]133;B\x1b\\"];
  let widthSeen = 0;
  const proto = { render: (width: number) => { widthSeen = width; return downstream; } };
  patchNativeUserMessagePrototype(proto, () => undefined, () => false, () => true, () => steer);
  assert.equal(proto.render(19.5), downstream);
  assert.equal(widthSeen, 19.5);
  steer = { hide: true };
  assert.deepEqual(proto.render(20), []);
  steer = { lines: ["steer"] };
  const lines = proto.render(20);
  assertNavigation(lines);
  assert.match(lines.join(""), /steer/);
});

test("D4 self-drawn real SDK history caches exactly one navigation boundary across resize", () => {
  initTheme("dark", false);
  const proto = UserMessageComponent.prototype as unknown as PatchableUserMessagePrototype;
  patchNativeUserMessagePrototype(proto, () => undefined, () => true);
  try {
    const user = new UserMessageComponent("A normal prompt");
    for (const width of [40, 40, 18, 18, 40]) {
      const lines = user.render(width);
      assertNavigation(lines);
      assert.ok(lines.every((line) => visibleWidth(line) <= width));
    }
  } finally { unregisterUserMessageRenderPrototypePatch(proto); }
});

test("D4 strip BEL/ST before layout, A first on single-line steer, and keep zero output", () => {
  for (const terminator of ["\x07", "\x1b\\"]) {
    const marked = `\x1b]133;A${terminator}body\x1b]133;B${terminator}\x1b]133;C${terminator}`;
    const proto: PatchableUserMessagePrototype = { render: () => [marked] };
    patchNativeUserMessagePrototype(proto, () => undefined, () => true);
    const lines = proto.render(20);
    assertNavigation(lines);
    assert.ok(lines.every((line) => visibleWidth(line) <= 20));
    const steer: PatchableUserMessagePrototype = { render: () => [] };
    patchNativeUserMessagePrototype(steer, () => undefined, () => true, () => true, () => ({ lines: [marked] }));
    assert.deepEqual(steer.render(20), [A + B + C + "body"]);
  }
  for (const content of [[], [""], [A + B + C]]) {
    const proto: PatchableUserMessagePrototype = { render: () => content };
    patchNativeUserMessagePrototype(proto, () => undefined, () => true);
    assert.deepEqual(proto.render(20), []);
  }
});

test("D4 old owner cleanup cannot dismantle replacement, including expansion", () => {
  const proto: PatchableUserMessagePrototype = { render: () => ["native"] };
  const oldOwner = { retired: false };
  const newOwner = { retired: false };
  patchNativeUserMessagePrototype(proto, () => undefined, () => true, () => true, () => ({ lines: ["old"] }), oldOwner);
  patchNativeUserMessagePrototype(proto, () => undefined, () => true, () => true, () => ({ lines: ["new"] }), newOwner);
  unregisterUserMessageRenderPrototypePatch(proto, oldOwner);
  assert.match(proto.render(20).join(""), /new/);
  assert.equal(typeof proto.setExpanded, "function");
  unregisterUserMessageRenderPrototypePatch(proto, newOwner);
  assert.deepEqual(proto.render(20), ["native"]);
  assert.equal(proto.setExpanded, undefined);
});

test("D4 cleanup leaves later third-party render and expansion wrappers intact and inert underneath", () => {
  const proto: PatchableUserMessagePrototype = { render: () => ["native"] };
  patchNativeUserMessagePrototype(proto, () => undefined, () => true);
  const wrapped = proto.render;
  const wrappedExpanded = proto.setExpanded;
  const thirdParty = function(this: object, width: number) { return ["partner", ...wrapped.call(this, width)]; };
  const thirdPartyExpanded = function(this: object, expanded: boolean) { wrappedExpanded?.call(this, expanded); };
  proto.render = thirdParty;
  proto.setExpanded = thirdPartyExpanded;
  unregisterUserMessageRenderPrototypePatch(proto);
  assert.equal(proto.render, thirdParty);
  assert.equal(proto.setExpanded, thirdPartyExpanded);
  assert.deepEqual(proto.render(20), ["partner", "native"]);
});
