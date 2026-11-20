import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { expect, it } from "vitest";
import { UsageReporter } from "../src/usage-reporting.js";
import type { AgentRecord } from "../src/types.js";

it.each(["success", "failure", "background-batch"])("persists native codemode orchestration usage receipts (%s)", async (scenario) => {
  const failAfter = scenario === "failure";
  const batch = scenario === "background-batch";
  const cwd = mkdtempSync(join(tmpdir(), "native-agent-"));
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  try {
    mkdirSync(join(cwd, ".pi/agents"), { recursive: true });
    writeFileSync(join(cwd, ".pi/agents/local.md"), "---\ntools: none\nextensions: none\nskills: none\npersist_session: false\nprompt_mode: replace\n---\nLOCAL_CHILD");
    const settings = SettingsManager.inMemory({ defaultTools: ["+codemode"], compaction: { enabled: false }, retry: { enabled: false } });
    const faux = fauxProvider({ provider: "native-local", models: [{ id: "model", contextWindow: 200000, cost: { input: 1, output: 2, cacheRead: 0.1, cacheWrite: 1 } }] });
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey("native-local", "local-test-only");
    await runtime.getAvailable();
    const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager: settings,
      noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
      additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
      extensionFactories: [createCodemodeExtension({ models: false })],
    });
    await loader.reload();
    expect(loader.getExtensions().errors).toEqual([]);
    ({ session } = await createAgentSession({ cwd, agentDir: getAgentDir(), resourceLoader: loader,
      modelRuntime: runtime, model: faux.getModel(), settingsManager: settings, sessionManager: SessionManager.inMemory(cwd) }));
    await session.bindExtensions({});
    const code = batch ? `
      const launches = await Promise.all([1,2].map(n => tools.Agent({prompt:"go",description:"batch "+n,subagent_type:"local",isolation:"off",run_in_background:true})));
      const ids = launches.map(text => text.match(/Agent ID: ([^\\n]+)/)[1]);
      text(ids);
      text(await tools.steer_subagent({agent_id:ids[0],message:"finish with the same marker"}));
      text(await Promise.all(ids.map(agent_id => tools.get_subagent_result({agent_id,wait:true}))));
    ` : 'text(await tools.Agent({prompt:"go",description:"native probe",subagent_type:"local",isolation:"off"}));' + (failAfter ? 'throw new Error("AFTER_CHILD");' : '');
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("codemode", { code }), { stopReason: "toolUse" }),
      ...Array.from({ length: batch ? 10 : 1 }, () => fauxAssistantMessage("CHILD_DONE")),
      fauxAssistantMessage("PARENT_DONE"),
    ]);
    await session.prompt("Run the child via native codemode");
    const result = session.messages.filter(message => message.role === "toolResult").at(-1)!;
    console.log("NATIVE_CODEMODE_CARRIER", JSON.stringify(result));
    expect(result.isError).toBe(failAfter);
    expect(JSON.stringify(result.content)).toContain("CHILD_DONE");
    expect(result.usage!.totalTokens).toBeGreaterThan(0);
    const markers = (result.details as { subagentUsageRollups: Array<{ agentId: string; cumulative: AgentRecord["lifetimeUsage"] }> }).subagentUsageRollups;
    expect(markers).toHaveLength(batch ? 2 : 1);
    expect(result.usage!.cost.total).toBeCloseTo(markers.reduce((sum, marker) => sum + (marker.cumulative.cost ?? 0), 0), 10);
    expect(result.usage!.totalTokens).toBe(markers.reduce((sum, { cumulative }) =>
      sum + cumulative.input + cumulative.output + cumulative.cacheRead + cumulative.cacheWrite, 0));
    for (const marker of markers) {
      const record = { id: marker.agentId, lifetimeUsage: marker.cumulative } as AgentRecord;
      expect(new UsageReporter().claim(record, session.sessionManager)).toBeUndefined();
    }
    if (batch) {
      const calls = (result.details as { calls: Array<{ name: string; status: string }> }).calls;
      expect(calls.map(call => call.name).sort()).toEqual(["Agent", "Agent", "get_subagent_result", "get_subagent_result", "steer_subagent"]);
      expect(calls.every(call => call.status === "ok")).toBe(true);
    }
  } finally {
    if (session) { await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" }); session.dispose(); }
    rmSync(cwd, { recursive: true, force: true });
  }
});
