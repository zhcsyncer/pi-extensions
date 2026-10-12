import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession,
  createMcpExtension,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type AgentSession,
  type InlineExtension,
  type McpServerEntry,
  type McpTransportFactory,
} from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const packageRoot = fileURLToPath(new URL("..", import.meta.url));
const sdkManifest = JSON.parse(readFileSync(
  new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8",
));

type Transport = ReturnType<McpTransportFactory>;
type Message = Parameters<Transport["send"]>[0];

// Synthetic protocol declarations, NOT evidence of the real Context7 names/schema.
const declarations = [
  {
    name: "resolve-library-id",
    description: "Synthetic library resolution",
    inputSchema: {
      type: "object", required: ["libraryName", "query"],
      properties: { libraryName: { type: "string" }, query: { type: "string" } },
    },
  },
  {
    name: "query-docs",
    description: "Synthetic documentation query",
    inputSchema: {
      type: "object", required: ["libraryId", "query"],
      properties: { libraryId: { type: "string" }, query: { type: "string" } },
    },
  },
  { name: "unapproved", description: "Not approved", inputSchema: { type: "object" } },
];

function syntheticTransport() {
  const listeners = new Set<(message: Message) => void>();
  const calls: { name: string; arguments: unknown }[] = [];
  const transport: Transport = {
    async start() {},
    async close() {},
    onMessage(listener) { listeners.add(listener); return () => listeners.delete(listener); },
    onError() { return () => {}; },
    onClose() { return () => {}; },
    async send(message) {
      if (!("method" in message) || !("id" in message)) return;
      let result: unknown;
      switch (message.method) {
        case "initialize":
          result = {
            protocolVersion: "2025-11-25",
            capabilities: { tools: {} },
            serverInfo: { name: "synthetic-context7", version: "0.0.0" },
          };
          break;
        case "tools/list": result = { tools: declarations }; break;
        case "tools/call": {
          const params = message.params as { name: string; arguments: unknown };
          calls.push({ name: params.name, arguments: params.arguments });
          result = {
            content: [{ type: "text", text: params.name === "resolve-library-id" ? "/fixture/library" : "Synthetic docs" }],
            structuredContent: { fixture: true },
            isError: false,
          };
          break;
        }
        default: throw new Error(`Unexpected synthetic MCP request: ${message.method}`);
      }
      for (const listener of listeners) listener({ jsonrpc: "2.0", id: message.id, result });
    },
  };
  return { transport, calls };
}

describe("Pi 1.1 Context7 offline entry points", () => {
  let root: string;
  let agentDir: string;
  let cwd: string;
  let session: AgentSession | undefined;

  beforeEach(() => {
    expect(sdkManifest.version).toBe("1.1.0");
    root = mkdtempSync(path.join(tmpdir(), "pi-context7-sdk-"));
    agentDir = path.join(root, "agent");
    cwd = path.join(root, "project");
    mkdirSync(agentDir);
    mkdirSync(cwd);
    vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
    vi.stubEnv("CONTEXT7_API_KEY", "");
  });

  afterEach(async () => {
    if (session) {
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose();
      session = undefined;
    }
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    rmSync(root, { recursive: true, force: true });
  });

  async function load(options: { legacy?: boolean; factories?: InlineExtension[]; excludeLegacy?: boolean } = {}) {
    const settingsManager = SettingsManager.inMemory({
      packages: options.legacy ? [{
        source: packageRoot,
        ...(options.excludeLegacy ? { extensions: ["!extensions/context7.ts"] } : {}),
      }] : [],
      defaultTools: [],
    });
    const resourceLoader = new DefaultResourceLoader({
      cwd, agentDir, settingsManager,
      extensionFactories: options.factories,
      noThemes: true, noPromptTemplates: true, noContextFiles: true,
    });
    await resourceLoader.reload();
    expect(resourceLoader.getExtensions().errors).toEqual([]);
    const modelRuntime = await ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: path.join(agentDir, "models-cache.json"), refreshOnCreate: false,
    });
    ({ session } = await createAgentSession({
      cwd, agentDir, resourceLoader, modelRuntime, settingsManager,
      noTools: "builtin", sessionManager: SessionManager.inMemory(cwd),
    }));
    await session.bindExtensions({});
    return { session, resourceLoader };
  }

  // Execute the real session's active tools, not collectTools() or re-created definitions.
  // This checks SDK loading/execution, not model prompting or consumer permission gates.
  async function execute(name: string, args: Record<string, unknown>) {
    const tool = session!.agent.state.tools.find((tool) => tool.name === name);
    expect(tool, `active tool ${name}`).toBeDefined();
    return tool!.execute(`offline-${name}`, args, new AbortController().signal);
  }

  it("loads and executes legacy REST tools without MCP or codemode, preserving text results", async () => {
    const configDir = path.join(agentDir, "extension-data/pi-context7");
    mkdirSync(configDir, { recursive: true });
    writeFileSync(path.join(configDir, "config.json"), JSON.stringify({ apiKey: "synthetic-key" }));
    const requests: URL[] = [];
    vi.stubGlobal("fetch", async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const url = new URL(String(input));
      expect(url.origin).toBe("https://context7.com");
      expect(new Headers(init?.headers).get("Authorization")).toBe("Bearer synthetic-key");
      requests.push(url);
      if (url.pathname === "/api/v2/libs/search") {
        return Response.json({ results: [{ id: "/fixture/library", title: "Fixture", description: "Synthetic", trustScore: 9 }] });
      }
      expect(url.pathname).toBe("/api/v2/context");
      return new Response("# Synthetic REST docs\n\nExample");
    });
    const { session: loaded, resourceLoader } = await load({ legacy: true });
    expect(loaded.getActiveToolNames().sort()).toEqual(["query-docs", "resolve-library-id"]);
    expect(resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["context7-docs"]);
    const resolved = await execute("resolve-library-id", { libraryName: "Fixture", query: "setup" });
    expect(resolved.content).toEqual([{ type: "text", text: expect.stringContaining("/fixture/library") }]);
    const queried = await execute("query-docs", { libraryId: "/fixture/library", query: "setup" });
    expect(queried.content).toEqual([{ type: "text", text: "# Synthetic REST docs\n\nExample" }]);
    expect(queried.structuredContent).toBeUndefined();
    expect(requests.map((url) => Object.fromEntries(url.searchParams))).toEqual([
      { libraryName: "Fixture", query: "setup" }, { libraryId: "/fixture/library", query: "setup" },
    ]);
  });

  it("keeps the skill when the profile excludes only the legacy extension", async () => {
    const { session: loaded, resourceLoader } = await load({ legacy: true, excludeLegacy: true });
    expect(loaded.getActiveToolNames()).toEqual([]);
    expect(resourceLoader.getSkills().skills.map((skill) => skill.name)).toEqual(["context7-docs"]);
  });

  it("executes synthetic MCP direct tools without codemode and distinguishes server namespaces", async () => {
    const source = path.join(agentDir, "mcp.json");
    // Deliberately connect both fixtures to inspect identity metadata. Consumer
    // authorization must filter unapproved servers before connecting; it is not implemented here.
    const entries: McpServerEntry[] = ["context7", "context7_lookalike"].map((name) => ({
      name, source, scope: "global",
      config: {
        url: `https://${name}.invalid/mcp`,
        exposure: "hidden",
        toolExposure: { "resolve-library-id": "direct", "query-docs": "direct" },
      },
    }));
    const transports = new Map(entries.map((entry) => [entry.name, syntheticTransport()]));
    const connected: McpServerEntry[] = [];
    const { session: loaded } = await load({ factories: [{
      name: "mcp", builtin: true,
      factory: createMcpExtension({
        loadConfig: () => ({ servers: entries, errors: [] }),
        createTransport(entry) {
          connected.push(entry);
          return transports.get(entry.name)!.transport;
        },
      }),
    }] });
    await vi.waitFor(() => expect(loaded.getActiveToolNames().sort()).toEqual([
      "mcp__context7__query_docs", "mcp__context7__resolve_library_id",
      "mcp__context7_lookalike__query_docs", "mcp__context7_lookalike__resolve_library_id",
    ]));
    expect(connected.map((entry) => entry.config)).toEqual(entries.map((entry) => entry.config));
    const a = loaded.getAllTools().find((tool) => tool.name === "mcp__context7__query_docs")!;
    const b = loaded.getAllTools().find((tool) => tool.name === "mcp__context7_lookalike__query_docs")!;
    // The MCP owner alone cannot distinguish trusted A from same-tool-name B.
    expect(a.sourceInfo.path).toBe("builtin:mcp");
    expect(a.sourceInfo).toEqual(b.sourceInfo);
    expect(a.namespace?.name).toBe("mcp__context7");
    expect(b.namespace?.name).toBe("mcp__context7_lookalike");
    expect(a.parameters).toMatchObject(declarations[1].inputSchema);
    expect(loaded.getCallableToolNames()).not.toContain("mcp__context7__unapproved");
    expect(loaded.getAllTools().map((tool) => tool.name)).not.toContain("codemode");
    expect(loaded.getAllTools().map((tool) => tool.name)).not.toContain("tool_search");
    const resolved = await execute("mcp__context7__resolve_library_id", { libraryName: "Fixture", query: "setup" });
    expect(resolved.content).toEqual([{ type: "text", text: "/fixture/library" }]);
    const queried = await execute("mcp__context7__query_docs", { libraryId: "/fixture/library", query: "setup" });
    expect(queried.content).toEqual([{ type: "text", text: "Synthetic docs" }]);
    expect(queried.structuredContent).toEqual({
      content: [{ type: "text", text: "Synthetic docs" }],
      structuredContent: { fixture: true }, isError: false,
    });
    expect(queried.details).toEqual({ server: "context7", tool: "query-docs" });
    expect(transports.get("context7")!.calls).toEqual([
      { name: "resolve-library-id", arguments: { libraryName: "Fixture", query: "setup" } },
      { name: "query-docs", arguments: { libraryId: "/fixture/library", query: "setup" } },
    ]);
    expect(transports.get("context7_lookalike")!.calls).toEqual([]);
  });
});
