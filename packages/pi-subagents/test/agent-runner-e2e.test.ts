/**
 * agent-runner-e2e.test.ts — End-to-end test against the REAL pi-mono runtime.
 *
 * Tests the constructed model tool VIEW with NO pi-mono mock:
 *   - a real extension fixture (`fixtures/e2e-probe-ext.mjs`) registers a tool,
 *   - the real `DefaultResourceLoader` loads it via `additionalExtensionPaths`,
 *   - the real `createAgentSession` builds the session,
 *   - we read the real `session.getActiveToolNames()` at `onSessionCreated`
 *     (fires after construction, before any prompt) and assert model visibility.
 *
 * No network/LLM: an explicit in-memory runtime supplies only a faux response.
 * Observations are captured before prompting; a completed provider turn and
 * execution authority are NOT this suite's contract. Visibility is not authority.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type AgentSession, ModelRegistry, ModelRuntime, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { extensionCanonicalName, runAgent } from "../src/agent-runner.js";
import type { AgentConfig } from "../src/types.js";

// These tests spin up the REAL pi-mono runtime (loader + dynamic extension
// import + session construction), so a cold first run under full-suite CPU
// contention can exceed vitest's 5s default. Give the file generous headroom —
// a genuine hang still fails, just later.
vi.setConfig({ testTimeout: 30_000 });

const FIXTURE = resolve(fileURLToPath(new URL("./fixtures/e2e-probe-ext.mjs", import.meta.url)));
/** The fixture registers exactly this tool. */
const EXT_TOOL = "e2e_probe";
const BUILTINS = ["read", "bash", "edit", "write", "grep", "find", "ls"];

/** Minimal `pi` stub — `detectEnv` only needs `exec` (returns non-git). */
function makePi() {
  return { exec: async () => ({ code: 1, stdout: "", stderr: "" }) } as any;
}

describe("agent-runner end-to-end (real pi-mono session + real extension)", () => {
  let cwd: string;
  let faux: ReturnType<typeof fauxProvider>;
  let modelRegistry: ModelRegistry;

  beforeEach(async () => {
    cwd = mkdtempSync(join(tmpdir(), "subagents-e2e-"));
    faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey("faux", "fixture-only");
    modelRegistry = new ModelRegistry(runtime);
  });
  afterEach(() => {
    rmSync(cwd, { recursive: true, force: true });
  });

  /**
   * Pass constructed `cfg` through runAgent's public inline configuration and
   * return the real session's active tool names captured at construction time.
   */
  async function activeToolsFor(cfg: Partial<AgentConfig>): Promise<string[]> {
    const inlineAgentConfig: AgentConfig = {
      name: "e2e",
      description: "e2e",
      builtinToolNames: BUILTINS,
      extensions: false,
      skills: false,
      systemPrompt: "You are e2e.",
      promptMode: "replace",
      inheritContext: false,
      runInBackground: false,
      isolated: false,
      ...cfg,
    };
    const model = faux.getModel();
    faux.setResponses([fauxAssistantMessage("done")]);
    const ctx: any = {
      cwd, getSystemPrompt: () => "PARENT", model, modelRegistry,
      sessionManager: SessionManager.inMemory(cwd),
    };

    let session: AgentSession | undefined;
    let active: string[] | undefined;
    try {
      await runAgent(ctx, "e2e", "go", {
        pi: makePi(),
        model,
        configCwd: cwd,
        inlineAgentConfig,
        onSessionCreated: (s) => {
          session = s;
          active = s.getActiveToolNames();
        },
      });
    } catch (error) {
      // Only a post-capture prompt failure is outside this view-only contract.
      // Initialization/observation failures must never masquerade as empty views.
      if (active === undefined) throw error;
    } finally {
      session?.dispose();
    }
    expect(active, "onSessionCreated must capture the constructed model tool view").toBeDefined();
    return active!;
  }

  it("real pi-mono admits an extension-registered tool when it's in the allowlist (#47)", async () => {
    const active = await activeToolsFor({ extensions: [FIXTURE] });
    // The extension actually loaded and its tool reached the live session.
    expect(active).toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an extension tool is absent when extensions are disabled (not loaded)", async () => {
    const active = await activeToolsFor({ extensions: false });
    expect(active).not.toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("disallowedTools removes a real extension tool from the live session", async () => {
    const active = await activeToolsFor({ extensions: [FIXTURE], disallowedTools: [EXT_TOOL] });
    expect(active).not.toContain(EXT_TOOL); // loaded, then hidden from the model view
    expect(active).toContain("read");
  });

  it("the ext: allowlist flip mutes a loaded-but-unselected extension in real pi-mono", async () => {
    // Extension loads (extensions: [FIXTURE]), but a single ext: selector for a
    // *different* name flips extension tools to an allowlist — the unselected
    // fixture contributes nothing, even though it loaded and ran its handlers.
    const active = await activeToolsFor({ extensions: [FIXTURE], extSelectors: ["ext:not-the-fixture"] });
    expect(active).not.toContain(EXT_TOOL);
    for (const b of BUILTINS) expect(active).toContain(b);
  });

  it("an ext: selector surfaces the loaded extension's tool through the flip", async () => {
    // Derive the canonical name the loader/selector matcher uses, so the test
    // tracks `extensionCanonicalName` rather than hard-coding a filename form.
    const canon = extensionCanonicalName(FIXTURE);
    const active = await activeToolsFor({
      extensions: [FIXTURE],
      builtinToolNames: ["read"],
      extSelectors: [`ext:${canon}`],
    });
    expect(active).toContain(EXT_TOOL); // selected → surfaces despite the flip
    expect(active).toContain("read");
    expect(active).not.toContain("bash"); // builtinToolNames: ["read"] only
  });
});
