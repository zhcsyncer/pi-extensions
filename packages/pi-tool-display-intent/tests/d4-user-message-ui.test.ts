import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import type { AssistantMessage } from "@earendil-works/pi-ai";
import type { ExtensionUIContext, UserMessageComponent as UserMessageInstance } from "@earendil-works/pi-coding-agent";

// Isolate the config before loading the extension (its config path is module-scoped).
test("D4 real registration /tools keyboard changes old/new prompts and survives reload in both layouts", async () => {
  const root = mkdtempSync(join(tmpdir(), "d4-ui-"));
  const previousDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = root;
  try {
    const { initTheme, UserMessageComponent, AssistantMessageComponent } = await import("@earendil-works/pi-coding-agent");
    const { TuiMainScreen, Container } = await import("@earendil-works/pi-tui");
    const { AggregateTerminal } = await import("./helpers/aggregate-terminal.ts");
    const { createDisplaySession } = await import("./helpers/display-session.ts");
    const { default: extension } = await import("../src/index.ts");
    const { DEFAULT_TOOL_DISPLAY_CONFIG } = await import("../src/types.ts");
    const { saveToolDisplayConfig, loadToolDisplayConfig } = await import("../src/config-store.ts");
    initTheme("dark", false);
    const nativeRender = UserMessageComponent.prototype.render;
    for (const layout of ["individual", "aggregate"] as const) {
      saveToolDisplayConfig({ ...DEFAULT_TOOL_DISPLAY_CONFIG, toolCallLayout: layout });
      const h = await createDisplaySession(undefined, [], { display: false, factories: [extension] });
      const tui = new TuiMainScreen(new AggregateTerminal());
      const user = new UserMessageComponent("historical prompt");
      tui.addChild(user);
      try {
        const bindUI = () => {
          const runner = h.session.extensionRunner;
          const ui = runner.getUIContext();
          runner.setUIContext({
            ...ui,
            custom: async (factory: any) => {
              const component = await factory(tui, ui.theme, undefined, () => {});
              component.render(110);
              for (const key of "native") component.handleInput(key);
              assert.match(component.render(110).join("\n"), /User message box/);
              component.handleInput(" ");
              component.handleInput("\x1b");
            },
          } as ExtensionUIContext, "tui");
        };
        bindUI();
        await h.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
        assert.match(user.render(40).join(""), layout === "individual" ? /╭/ : /▎/);
        const toggle = async () => {
          const runner = h.session.extensionRunner;
          await runner.getCommand("tools")!.handler("", runner.createCommandContext());
        };
        await toggle();
        assert.equal(loadToolDisplayConfig().config.enableNativeUserMessageBox, false);
        assert.deepEqual(user.render(40), nativeRender.call(new UserMessageComponent("historical prompt"), 40));
        assert.deepEqual(new UserMessageComponent("new prompt").render(40), nativeRender.call(new UserMessageComponent("new prompt"), 40));
        await h.session.reload();
        bindUI();
        await h.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
        assert.deepEqual(user.render(40), nativeRender.call(new UserMessageComponent("historical prompt"), 40));
        await toggle();
        assert.equal(loadToolDisplayConfig().config.enableNativeUserMessageBox, true);
        const output = user.render(40);
        assert.ok(output[0]?.startsWith("\x1b]133;A\x07"));
        assert.match(output.join(""), layout === "individual" ? /╭/ : /▎/);

        // The native assistant owns the decision to emit navigation boundaries.
        for (const toolCall of [false, true]) {
          const message: AssistantMessage = {
            role: "assistant", content: [{ type: "text", text: "assistant reply" }, ...(toolCall ? [{ type: "toolCall" as const, id: "call", name: "read", arguments: {} }] : [])],
            api: "openai-completions", provider: "test", model: "offline", timestamp: 1,
            stopReason: toolCall ? "toolUse" : "stop",
            usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
          };
          const lines = new AssistantMessageComponent(message).render(40);
          const joined = lines.join("\n");
          if (toolCall) assert.doesNotMatch(joined, /\x1b\]133;/);
          else {
            assert.ok(lines[0]?.startsWith("\x1b]133;A\x07"));
            for (const marker of ["A", "B", "C"]) assert.equal(joined.split(`\x1b]133;${marker}\x07`).length - 1, 1);
          }
        }
      } finally { await h.close(); }
    }

    // Independent runtimes share SDK prototypes: cleanup must remain owner-scoped.
    saveToolDisplayConfig({ ...DEFAULT_TOOL_DISPLAY_CONFIG, enableNativeUserMessageBox: true });
    const older = await createDisplaySession(undefined, [], { display: false, factories: [extension] });
    saveToolDisplayConfig({ ...DEFAULT_TOOL_DISPLAY_CONFIG, enableNativeUserMessageBox: false });
    const newer = await createDisplaySession(undefined, [], { display: false, factories: [extension] });
    const proto = UserMessageComponent.prototype as UserMessageInstance & { setExpanded?: (expanded: boolean) => void };
    const latest = { render: proto.render, expand: proto.setExpanded, spacer: Container.prototype.addChild, mouse: proto.handleMouse };
    try {
      await older.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
      await older.session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" });
      assert.equal(proto.render, latest.render);
      assert.equal(proto.setExpanded, latest.expand);
      assert.equal(Container.prototype.addChild, latest.spacer);
      assert.equal(proto.handleMouse, latest.mouse);
      const expected = nativeRender.call(new UserMessageComponent("ownership"), 40);
      assert.deepEqual(new UserMessageComponent("ownership").render(40), expected);
    } finally {
      await older.close();
      await newer.close();
    }
    assert.equal(proto.render, nativeRender);
  } finally {
    if (previousDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = previousDir;
    rmSync(root, { recursive: true, force: true });
  }
});
