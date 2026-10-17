/**
 * ext-templates-e2e.test.ts — Data-driven, headless end-to-end runner for
 * `tools:`/`ext:`/`extensions:` scoping against the REAL pi-mono runtime.
 *
 * Unlike agent-runner-e2e.test.ts (which builds AgentConfig objects in code),
 * this exercises the FULL chain from frontmatter onward:
 *
 *   test/fixtures/.pi/agents/*.md         (pre-configured agent templates)
 *     → real loadCustomAgents()           (frontmatter → parseToolsField/ext:)
 *     → registerAgents()                  (real registry)
 *     → real runAgent() [headless]        (real DefaultResourceLoader loads the
 *                                          real .mjs extension fixtures)
 *     → real createAgentSession()         (real pi-mono session construction)
 *     → session.getActiveToolNames()      (constructed model tool view, NOT authority)
 *
 * Each template is self-describing: its `expect_present` / `expect_absent`
 * frontmatter declares the tools that must / must not be active. Adding a
 * scenario = adding a .md file; no test code changes needed.
 *
 * Headless: an in-memory runtime supplies a faux response; we assert on the
 * pre-prompt tool view captured at onSessionCreated, so no LLM/network is
 * involved. cwd is the fixtures dir so the templates' relative `extensions:`
 * paths resolve and the .mjs fixtures can import `@sinclair/typebox` from the
 * repo's node_modules.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxAssistantMessage, fauxProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { type AgentSession, ModelRegistry, ModelRuntime, parseFrontmatter, SessionManager } from "@earendil-works/pi-coding-agent";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runAgent } from "../src/agent-runner.js";
import { getAgentConfig, registerAgents } from "../src/agent-types.js";
import { loadCustomAgents } from "../src/custom-agents.js";
import { resolveAgentInvocationConfig } from "../src/invocation-config.js";

// Real pi-mono (loader + dynamic extension import + session construction) — a
// cold run under full-suite contention can exceed vitest's 5s default.
vi.setConfig({ testTimeout: 30_000 });

const FIXTURES_DIR = resolve(fileURLToPath(new URL("./fixtures", import.meta.url)));
const TEMPLATES_DIR = join(FIXTURES_DIR, ".pi", "agents");

function csv(val: unknown): string[] {
  return typeof val === "string" ? val.split(",").map((s) => s.trim()).filter(Boolean) : [];
}

/** Discover scenarios from the template files at collection time. */
const SCENARIOS = readdirSync(TEMPLATES_DIR)
  .filter((f) => f.endsWith(".md"))
  .map((file) => {
    const fm = parseFrontmatter<Record<string, unknown>>(
      readFileSync(join(TEMPLATES_DIR, file), "utf8"),
    ).frontmatter;
    return {
      name: file.replace(/\.md$/, ""), // loadCustomAgents keys agents by filename
      present: csv(fm.expect_tools_present),
      absent: csv(fm.expect_tools_absent),
      promptContains: csv(fm.expect_prompt_contains),
      promptAbsent: csv(fm.expect_prompt_absent),
    };
  });

/** Distinctive marker for the parent system prompt (prompt_mode: append asserts it leaks in). */
const PARENT_PROMPT = "PARENT_PROMPT_MARKER";

describe("ext: / tools: scoping — template-driven e2e (real pi-mono, headless)", () => {
  let prevAgentDir: string | undefined;
  let prevHome: string | undefined;
  let hermeticDir: string;
  let faux: ReturnType<typeof fauxProvider>;
  let modelRegistry: ModelRegistry;

  beforeAll(async () => {
    // Isolate global discovery (getAgentDir / ~/.pi) so the dev's real agents
    // and extensions can't bleed into the run.
    hermeticDir = mkdtempSync(join(tmpdir(), "subagents-tmpl-"));
    prevAgentDir = process.env.PI_CODING_AGENT_DIR;
    prevHome = process.env.HOME;
    process.env.PI_CODING_AGENT_DIR = hermeticDir;
    process.env.HOME = hermeticDir;

    faux = fauxProvider({ provider: "faux", models: [{ id: "faux-1", contextWindow: 200_000 }] });
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false,
    });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey("faux", "fixture-only");
    modelRegistry = new ModelRegistry(runtime);

    // Load the templates through the REAL loader (project agents come from
    // <cwd>/.pi/agents → FIXTURES_DIR/.pi/agents) for discovery assertions and
    // caller-side option resolution. runAgent independently loads configCwd.
    registerAgents(loadCustomAgents(FIXTURES_DIR));
  });

  afterAll(() => {
    if (prevAgentDir == null) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = prevAgentDir;
    if (prevHome == null) delete process.env.HOME;
    else process.env.HOME = prevHome;
    rmSync(hermeticDir, { recursive: true, force: true });
  });

  async function runScenario(agentName: string): Promise<{ active: string[]; prompt: string }> {
    const model = faux.getModel();
    faux.setResponses([fauxAssistantMessage("done")]);
    // cwd = fixtures dir so the templates' relative extensions: paths resolve.
    // getSystemPrompt returns a distinctive marker so prompt_mode: append can be
    // proven to inherit the parent prompt.
    const ctx: any = {
      cwd: FIXTURES_DIR, getSystemPrompt: () => PARENT_PROMPT, model, modelRegistry,
      sessionManager: SessionManager.inMemory(FIXTURES_DIR),
    };
    const pi: any = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) };

    // Mirror production: the caller resolves frontmatter-locked fields (isolated,
    // inherit_context, …) into runAgent options via resolveAgentInvocationConfig.
    // isolated also narrows the constructed extension tool view.
    const resolved = resolveAgentInvocationConfig(getAgentConfig(agentName), { modelFromParams: false } as any);

    let session: AgentSession | undefined;
    let observed: { active: string[]; prompt: string } | undefined;
    try {
      await runAgent(ctx, agentName, "go", {
        pi,
        model,
        cwd: FIXTURES_DIR,
        configCwd: FIXTURES_DIR,
        isolated: resolved.isolated,
        inheritContext: resolved.inheritContext,
        onSessionCreated: (s) => {
          // Capture both public observables before any prompt turn.
          session = s;
          observed = { active: s.getActiveToolNames(), prompt: s.systemPrompt };
        },
      });
    } catch (error) {
      // A later prompt failure is outside the view contract, but initialization
      // and observation failures must fail rather than pass absent assertions.
      if (observed === undefined) throw error;
    } finally {
      session?.dispose();
    }
    expect(observed, `${agentName}: onSessionCreated must capture tools and prompt`).toBeDefined();
    return observed!;
  }

  it("every template on disk is discovered, registered, and self-describing", () => {
    // 1:1 with the .md files in the templates dir — nothing silently dropped.
    const onDisk = readdirSync(TEMPLATES_DIR).filter((f) => f.endsWith(".md")).length;
    expect(SCENARIOS.length).toBe(onDisk);
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(6);

    for (const s of SCENARIOS) {
      // Every fixture has positive and negative controls, not just absence checks.
      expect(s.present.length + s.promptContains.length + s.promptAbsent.length).toBeGreaterThan(0);
      expect(s.present.length).toBeGreaterThan(0);
      expect(s.absent.length).toBeGreaterThan(0);
      expect(s.promptContains.length).toBeGreaterThan(0);
      // Each loaded as ITS OWN agent — guards against runAgent silently falling
      // back to general-purpose when a template fails to parse/register.
      const cfg = getAgentConfig(s.name);
      expect(cfg, `template "${s.name}" did not register (parse error or name mismatch?)`).toBeDefined();
      expect(cfg?.name).toBe(s.name);
    }
  });

  it.each(SCENARIOS)(
    "$name → active tools and system prompt match the template",
    async ({ name, present, absent, promptContains, promptAbsent }) => {
      const { active, prompt } = await runScenario(name);
      for (const tool of present) expect(active, `${name}: expected "${tool}" active`).toContain(tool);
      for (const tool of absent) expect(active, `${name}: expected "${tool}" NOT active`).not.toContain(tool);
      for (const s of promptContains) expect(prompt, `${name}: prompt should contain "${s}"`).toContain(s);
      for (const s of promptAbsent) expect(prompt, `${name}: prompt should NOT contain "${s}"`).not.toContain(s);
    },
  );
});
