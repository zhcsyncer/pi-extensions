import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach } from "node:test";
import {
  DefaultResourceLoader, SettingsManager, ModelRuntime, SessionManager,
  createAgentSession, type ExtensionAPI, type ExtensionFactory, type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { registerToolDisplayOverrides } from "../../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../../src/types.ts";

/** Real registry for the existing component tests; no mutable ToolInfo objects. */
export async function createDisplaySession(
  config: ToolDisplayConfig = DEFAULT_TOOL_DISPLAY_CONFIG,
  tools: Array<Record<string, any>> = [],
  options: { display?: boolean; factories?: ExtensionFactory[]; settings?: Parameters<typeof SettingsManager.inMemory>[0] } = {},
) {
  const cwd = mkdtempSync(join(tmpdir(), "pi-display-session-"));
  const agentDir = join(cwd, "agent");
  const settingsManager = SettingsManager.inMemory({ packages: [], ...options.settings });
  let fixtureApi: ExtensionAPI;
  const errors: unknown[] = [];
  const loader = new DefaultResourceLoader({
    cwd, agentDir, settingsManager,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [
      ...(options.display === false ? [] : [((pi: ExtensionAPI) => registerToolDisplayOverrides(pi, () => config))]),
      pi => {
        fixtureApi = pi;
        for (const tool of tools) pi.registerTool({
          name: tool.name, label: tool.name, description: tool.name, parameters: { type: "object", properties: {} },
          execute: async () => ({ content: [], details: undefined }), ...tool,
        } as ToolDefinition);
      },
      ...options.factories ?? [],
    ],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const modelRuntime = await ModelRuntime.create({
    authPath: join(agentDir, "auth.json"), modelsPath: null,
    modelsStorePath: join(agentDir, "models-cache"), allowModelNetwork: false, refreshOnCreate: false,
  });
  const { session } = await createAgentSession({
    cwd, agentDir, settingsManager, modelRuntime, resourceLoader: loader,
    sessionManager: SessionManager.inMemory(cwd),
  });
  await session.bindExtensions({ onError: error => errors.push(error) });
  assert.deepEqual(errors, []);
  const renderers = (name: string) => session.extensionRunner.resolveToolRenderers(name, () => session.getToolDefinition(name));
  const displayTool = (name: string): any => ({ ...session.getToolDefinition(name), ...renderers(name), name });
  return {
    cwd, agentDir, session, loader, errors, renderers, displayTool,
    get api() { return fixtureApi!; },
    async close() {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      rmSync(cwd, { recursive: true, force: true });
      assert.deepEqual(errors, []);
    },
  };
}

const openHarnesses = new Set<Awaited<ReturnType<typeof createDisplaySession>>>();
afterEach(async () => {
  for (const harness of openHarnesses) await harness.close();
  openHarnesses.clear();
});

/** Adapter for pre-existing rendering assertions, backed by the real SDK registry. */
export async function createRendererTestHarness(tools: any[] = []) {
  const custom = tools.filter(tool => tool.sourceInfo?.source !== "builtin");
  const h = await createDisplaySession(DEFAULT_TOOL_DISPLAY_CONFIG, custom, { display: false });
  openHarnesses.add(h);
  const registeredTools: any[] = []; // Resolved display views, NOT registration evidence.
  const runtimeTools: any[] = [];
  const refresh = () => {
    registeredTools.splice(0, registeredTools.length, ...["read", "grep", "find", "ls", "bash", "edit", "write"]
      .filter(name => h.renderers(name) !== h.session.getToolDefinition(name)).map(h.displayTool));
    runtimeTools.splice(0, runtimeTools.length, ...custom.map(tool => h.displayTool(tool.name)));
  };
  let started = false;
  const eventHandlers: Record<string, (...args: any[]) => Promise<void>> = new Proxy({}, {
    get: (_target, type: string) => async (event = {}) => {
      if (type === "before_agent_start") {
        if (!started) await h.session.extensionRunner.emit({ type: "session_start", reason: "startup" });
        started = true;
        refresh(); return;
      }
      if (type === "session_start") started = true;
      await h.session.extensionRunner.emit({ type, ...event } as never);
      refresh();
    },
  });
  return { ...h, registeredTools, runtimeTools, eventHandlers, refresh };
}
