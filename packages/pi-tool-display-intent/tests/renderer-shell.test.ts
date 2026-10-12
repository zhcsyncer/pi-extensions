import assert from "node:assert/strict";
import test from "node:test";
import { initTheme, ToolExecutionComponent, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Text, TuiMainScreen, stripTerminalSequences } from "@earendil-works/pi-tui";
import { DEFAULT_TOOL_DISPLAY_CONFIG as defaults } from "../src/types.ts";
import { createDisplaySession } from "./helpers/display-session.ts";
import { AggregateTerminal } from "./helpers/aggregate-terminal.ts";

const output = (row: ToolExecutionComponent) => row.render(120).map(stripTerminalSequences).join("\n");
const result = { content: [{ type: "text" as const, text: "payload" }], details: undefined, isError: false, durationMs: 73 };

test("delegated call/result components share their state, not the framing or other rows", async t => {
  initTheme("dark", false);
  const definition: ToolDefinition = {
    name: "component_probe", label: "Probe", description: "Probe", parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: undefined }),
    renderCall(args, _theme, ctx) {
      ctx.state.value ??= (args as any).value;
      const component = ctx.lastComponent as Text ?? new Text("", 0, 0);
      component.setText(`CALL:${ctx.state.value}:${ctx.expanded}`);
      return component;
    },
    renderResult(_result, _options, _theme, ctx) {
      const component = ctx.lastComponent as Text ?? new Text("", 0, 0);
      component.setText(`RESULT:${ctx.state.value}:${(ctx.args as any).value}:${ctx.durationMs}:${ctx.showImages}`);
      return component;
    },
  };
  const h = await createDisplaySession(defaults, [definition]);
  t.after(() => h.close());
  const tui = new TuiMainScreen(new AggregateTerminal());
  const renderer = h.renderers("component_probe");
  const first = new ToolExecutionComponent("component_probe", "one", { value: "one" }, { outputPad: 0 }, renderer, tui, h.cwd);
  const second = new ToolExecutionComponent("component_probe", "two", { value: "two" }, { outputPad: 0 }, renderer, tui, h.cwd);
  first.updateResult(result);
  second.updateResult(result);
  first.setExpanded(true);
  first.setShowImages(false);
  first.invalidate();
  assert.match(output(first), /CALL:one:true/);
  assert.match(output(first), /RESULT:one:one:73:false/);
  assert.match(output(second), /RESULT:two:two:73:true/);
});

for (const style of ["compact", "claude"] as const) {
  for (const shell of ["default", "self"] as const) {
    test(`${style}/${shell} applies outputPad exactly once`, async t => {
      initTheme("dark", false);
      const definition: ToolDefinition = {
        name: "padding_probe", label: "Padding", description: "Padding", parameters: { type: "object", properties: {} },
        execute: async () => ({ content: [], details: undefined }), renderShell: shell,
        renderCall(_args, _theme, ctx) { return new Text(`${shell === "self" ? " ".repeat(ctx.outputPad) : ""}PADDING`, 0, 0); },
      };
      const h = await createDisplaySession({ ...defaults, toolCallStyle: style }, [definition]);
      t.after(() => h.close());
      const row = new ToolExecutionComponent("padding_probe", "pad", {}, { outputPad: 1 }, h.renderers("padding_probe"), new TuiMainScreen(new AggregateTerminal()), h.cwd);
      const line = () => output(row).split("\n").find(s => s.includes("PADDING"))!.trimEnd();
      assert.equal(line(), " PADDING");
      row.setOutputPad(0);
      assert.equal(line(), "PADDING");
    });
  }
}
