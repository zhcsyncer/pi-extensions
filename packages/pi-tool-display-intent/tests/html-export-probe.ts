import assert from "node:assert/strict";
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

  const individual = await createDisplaySession(config);
  try {
    const renderer = createToolHtmlRenderer({ getToolRenderers: individual.renderers, theme, cwd: individual.cwd, width: 120 } as never);
    const stored = renderer.renderCall("history-model", "read", { path: "stored.ts", displaySummary: "Reviewing stored intent" }) ?? "";
    assert.match(stored, /Reviewing stored intent/);
  } finally { await individual.close(); }
}

main().then(() => { process.stdout.write("HTML_EXPORT_OK\n"); process.exit(0); }, error => { console.error(error); process.exit(1); });
