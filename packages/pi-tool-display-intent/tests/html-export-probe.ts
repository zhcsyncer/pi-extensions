import assert from "node:assert/strict";
import { Text } from "@earendil-works/pi-tui";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";
import { createToolHtmlRenderer } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";
import { createDisplaySession } from "./helpers/display-session.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG as defaults } from "../src/types.ts";

async function main(): Promise<void> {
  const config = { ...defaults, resultMode: "preview" as const, readOutputMode: "preview" as const, searchOutputMode: "preview" as const, mcpOutputMode: "preview" as const };
  const aggregate = await createDisplaySession({ ...config, toolCallLayout: "aggregate" });
  const theme = { fg: (_c: string, text: string) => text, bg: (_c: string, text: string) => text, bold: (text: string) => text };
  try {
    assert.equal((aggregate.session.getToolDefinition("read")!.parameters as any).properties.displaySummary, undefined);
    const renderer = createToolHtmlRenderer({ getToolRenderers: aggregate.renderers, theme, cwd: aggregate.cwd, width: 120 } as never);
    const call = renderer.renderCall("history-read", "read", { path: "history.ts" }) ?? "";
    assert.match(call, /history\.ts/);
    assert.doesNotMatch(call, /Read file| — /);
    const result = renderer.renderResult("history-read", "read", [{ type: "text", text: "original result" }], {}, false);
    assert.match(`${result?.collapsed ?? ""}${result?.expanded ?? ""}`, /original result/);
    const bash = renderer.renderCall("history-bash", "bash", { command: "pnpm test" }) ?? "";
    assert.match(bash, /pnpm test/);
    assert.doesNotMatch(bash, /Run command| — /);
  } finally { await aggregate.close(); }

  const delegated: ToolDefinition = {
    name: "export_state_probe", label: "Probe", description: "Probe",
    parameters: { type: "object", properties: {} },
    execute: async () => ({ content: [], details: undefined }),
    renderCall(args, _theme, context) {
      context.state.seed = (args as { seed: string }).seed;
      const component = (context.lastComponent ?? new Text("", 0, 0)) as Text;
      component.setText(`CALL:${context.state.seed}`);
      return component;
    },
    renderResult(_result, { expanded }, _theme, context) {
      context.state.results = (context.state.results ?? 0) + 1;
      const component = (context.lastComponent ?? new Text("", 0, 0)) as Text;
      component.setText(`RESULT:${context.state.seed ?? "missing"}:${context.state.results}:${expanded}`);
      return component;
    },
  };
  const individual = await createDisplaySession(config, [delegated]);
  try {
    const renderer = createToolHtmlRenderer({ getToolRenderers: individual.renderers, theme, cwd: individual.cwd, width: 120 } as never);
    const stored = renderer.renderCall("history-model", "read", { path: "stored.ts", displaySummary: "Reviewing stored intent" }) ?? "";
    assert.match(stored, /Reviewing stored intent/);

    // The SDK exporter resolves independently for call and every result; unlike
    // a TUI row, the first result has no lastComponent from which to recover state.
    assert.match(renderer.renderCall("export-a", delegated.name, { seed: "alpha" }) ?? "", /CALL:alpha/);
    assert.match(renderer.renderCall("export-b", delegated.name, { seed: "beta" }) ?? "", /CALL:beta/);
    const first = renderer.renderResult("export-a", delegated.name, [], {}, false);
    assert.match(first?.collapsed ?? "", /RESULT:alpha:1:false/);
    assert.match(first?.expanded ?? "", /RESULT:alpha:2:true/);
    const second = renderer.renderResult("export-a", delegated.name, [], {}, false);
    assert.match(second?.collapsed ?? "", /RESULT:alpha:3:false/);
    assert.match(second?.expanded ?? "", /RESULT:alpha:4:true/);
    const other = renderer.renderResult("export-b", delegated.name, [], {}, false);
    assert.match(other?.expanded ?? "", /RESULT:beta:2:true/);

    const separateExport = createToolHtmlRenderer({ getToolRenderers: individual.renderers, theme, cwd: individual.cwd, width: 120 } as never);
    const withoutCall = separateExport.renderResult("export-a", delegated.name, [], {}, false);
    assert.match(withoutCall?.expanded ?? "", /RESULT:missing:2:true/);
    process.stdout.write("HTML_STATE_OK\n");
  } finally { await individual.close(); }
}

main().then(() => { process.stdout.write("HTML_EXPORT_OK\n"); process.exit(0); }, error => { console.error(error); process.exit(1); });
