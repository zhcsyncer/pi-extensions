import { execFileSync } from "node:child_process";
import { mkdtemp, mkdir, writeFile, readFile, readdir, rm, access } from "node:fs/promises";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { describe, expect, test } from "vitest";
import {
  fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, getCurrentTools,
  type FauxResponseFactory,
} from "@earendil-works/pi-ai";
import {
  AgentSession, createAgentSession, createEventBus, DefaultResourceLoader,
  ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import reviewExtension from "../extensions/adversarial-review.ts";
import subagentsExtension from "../../pi-subagents/src/index.ts";
import { resolveReviewRuntime } from "../src/runtime/resolve-runtime.ts";
import type { ReviewAgentTerminalEvent, SpawnReviewAgentInput } from "../src/runtime/types.ts";
import type { MergedReviewReport } from "../src/types.ts";

// Workspace integration evidence, not a published-package closure or an MCP connection test.
// Only the SDK model boundary is synthetic; command, RPC, embedded runtime and tools are real.
const report = { verdict: "approve", summary: "Fixture review completed.", findings: [] };
const reportText = JSON.stringify(report);
const builtins = ["find", "grep", "ls", "read"];
const parentSecret = "PARENT_HISTORY_MUST_NOT_ENTER_REVIEW_7419";
const readSentinel = "READ_POSITIVE_CONTROL_5281";

type Backend = "external-v3" | "embedded";
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
async function bounded<T>(promise: Promise<T>): Promise<T> {
  const controller = new AbortController();
  try {
    return await Promise.race([promise, delay(10_000, undefined, { signal: controller.signal }).then(() => {
      throw new Error("Contract fixture did not settle within 10 seconds");
    })]);
  } finally { controller.abort(); }
}
async function exists(path: string) {
  try { await access(path); return true; } catch { return false; }
}

async function fixture(backend: Backend, pinned = false) {
  const dir = await mkdtemp("/var/tmp/a1-review-contract-");
  const cwd = join(dir, "repo");
  const agentDir = join(dir, "agent");
  await mkdir(cwd); await mkdir(agentDir);
  const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = agentDir;
  const git = (...args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", ...args], {
    cwd, encoding: "utf8", env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_AUTHOR_NAME: "Contract", GIT_AUTHOR_EMAIL: "contract@example.invalid",
      GIT_COMMITTER_NAME: "Contract", GIT_COMMITTER_EMAIL: "contract@example.invalid" },
  }).trim();
  git("init", "-q", "-b", "fixture");
  await writeFile(join(cwd, "evidence.txt"), readSentinel + "\n");
  git("add", "."); git("commit", "-qm", "fixture base");
  await writeFile(join(cwd, "change.txt"), "const value = 2;\n");
  git("add", "."); git("commit", "-qm", "fixture change");
  const before = { head: git("rev-parse", "HEAD"), status: git("status", "--porcelain=v1"), worktrees: git("worktree", "list", "--porcelain") };
  const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(),
    modelsPath: null, modelsStorePath: join(agentDir, "models-cache.json"), refreshOnCreate: false, allowModelNetwork: false });
  const providers = ["a", "b"].map((id) => fauxProvider({ provider: `a1-contract-${id}`, models: [{ id: `review-${id}` }], tokensPerSecond: 0 }));
  for (const provider of providers) modelRuntime.registerNativeProvider(provider.provider);
  const models = providers.map((provider) => provider.getModel());
  const ordinaryPath = join(agentDir, "ordinary-discovery.js");
  const ordinaryEffect = join(dir, "ordinary-loaded");
  await writeFile(ordinaryPath, `import { appendFileSync } from 'node:fs';
export default (pi) => { pi.on('session_start', () => appendFileSync(${JSON.stringify(ordinaryEffect)}, 'start\\n')); };`);
  const skillPath = join(agentDir, "skills", "ordinary-skill");
  await mkdir(skillPath, { recursive: true });
  await writeFile(join(skillPath, "SKILL.md"), "---\nname: ordinary-skill\ndescription: Ordinary parent skill fixture\n---\nPARENT_SKILL_ONLY\n");
  const pinnedPath = join(agentDir, "pinned-observer.js");
  const pinnedLog = join(dir, "pinned-lifecycle");
  const pinnedEffect = join(dir, "pinned-tool-effect");
  if (pinned) {
    await mkdir(join(agentDir, "extension-data", "pi-subagents"), { recursive: true });
    await writeFile(join(agentDir, "extension-data", "pi-subagents", "config.json"), JSON.stringify({ pinnedExtensions: ["pinned-observer"] }));
    await writeFile(pinnedPath, `import { appendFileSync } from 'node:fs';
export default (pi) => {
  pi.on('session_start', () => appendFileSync(${JSON.stringify(pinnedLog)}, 'start\\n'));
  pi.registerTool({ name: 'pinned_effect', label: 'Pinned effect', description: 'Test-only effect',
    parameters: { type: 'object', properties: {} },
    execute: async () => { appendFileSync(${JSON.stringify(pinnedEffect)}, 'executed'); return { content: [{ type: 'text', text: 'effect' }] }; } });
};`);
  }
  await writeFile(join(agentDir, "settings.json"), JSON.stringify({ extensions: [ordinaryPath, ...(pinned ? [pinnedPath] : [])] }));
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const events = createEventBus();
  let pi!: ExtensionAPI;
  let ctx!: ExtensionContext;
  const loader = new DefaultResourceLoader({ cwd, agentDir, settingsManager, eventBus: events,
    noExtensions: true, noSkills: false, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    additionalExtensionPaths: [ordinaryPath, ...(pinned ? [pinnedPath] : [])],
    additionalSkillPaths: [skillPath],
    extensionFactories: [
      (api) => { pi = api; api.on("session_start", (_event, context) => { ctx = context; }); },
      ...(backend === "external-v3" ? [subagentsExtension] : []), reviewExtension,
    ],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const sessionManager = SessionManager.inMemory(cwd);
  sessionManager.appendMessage({ role: "user", content: parentSecret, timestamp: Date.now() });
  const { session: parent } = await createAgentSession({ cwd, agentDir, modelRuntime, model: models[0],
    scopedModels: models.map((model) => ({ model, thinkingLevel: "off" as const })),
    thinkingLevel: "off", settingsManager, sessionManager, resourceLoader: loader, tools: [] });
  await parent.bindExtensions({ mode: "print" });
  expect(ctx.scopedModels.map((entry) => entry.model.id)).toEqual(models.map((model) => model.id));
  expect(await readFile(ordinaryEffect, "utf8")).toBe("start\n");
  expect(parent.resourceLoader.getSkills().skills.map((skill) => skill.name)).toContain("ordinary-skill");
  const children: AgentSession[] = [];
  const original = AgentSession.prototype.prompt;
  AgentSession.prototype.prompt = async function (...args) {
    if (this !== parent && !children.includes(this)) children.push(this);
    return await original.apply(this, args);
  };
  let resolved: Awaited<ReturnType<typeof resolveReviewRuntime>> | undefined;
  return {
    cwd, dir, agentDir, parent, providers, models, children, git, before, ordinaryPath, ordinaryEffect, pinnedLog, pinnedEffect,
    async runtime() {
      resolved = await resolveReviewRuntime({ pi, ctx, events, externalProbeTimeoutMs: 50 });
      expect(resolved.capabilities.backend).toBe(backend);
      return resolved;
    },
    async command() {
      await parent.prompt(`/adversarial-review --range HEAD~1..HEAD ${models.map((m) => `--reviewer ${m.provider}/${m.id}@off`).join(" ")}`);
    },
    async assertGitUnchanged() {
      expect(git("rev-parse", "HEAD")).toBe(before.head);
      expect(git("status", "--porcelain=v1")).toBe(before.status);
      expect(git("worktree", "list", "--porcelain")).toBe(before.worktrees);
      expect(await readFile(join(cwd, "evidence.txt"), "utf8")).toBe(readSentinel + "\n");
    },
    async cleanup() {
      try {
        await resolved?.dispose();
        await parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      } finally {
        parent.dispose();
        AgentSession.prototype.prompt = original;
        if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
        else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
        await rm(dir, { recursive: true, force: true });
      }
    },
  };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;
function input(f: Fixture, role: SpawnReviewAgentInput["role"]): SpawnReviewAgentInput {
  return { role, prompt: "Return the fixture report after the scripted tool calls.", systemPrompt: "Synthetic contract case.",
    cwd: f.cwd, model: f.models[0]!, thinking: "off", maxTurns: 5, graceTurns: 1,
    correlationId: `contract-${role}`, description: `Contract ${role}`, persistSession: false };
}
function findReport(value: unknown): MergedReviewReport | undefined {
  if (!value || typeof value !== "object") return undefined;
  if ("routeResults" in value && "runtime" in value && "overall" in value) return value as MergedReviewReport;
  for (const child of Object.values(value)) { const found = findReport(child); if (found) return found; }
  return undefined;
}

// Prototype observation is intentionally serial and transparent, with restoration in every finally.
describe.sequential.each<Backend>(["external-v3", "embedded"])("SDK 1.1 Review contract: %s", (backend) => {
  test("real command publishes one report and cleans its detached Git worktree", async () => {
    const f = await fixture(backend);
    try {
      for (const provider of f.providers) provider.setResponses([(context) => {
        expect(getCurrentTools(context.messages).map((tool) => tool.name).sort()).toEqual(builtins);
        expect(JSON.stringify(context)).not.toContain(parentSecret);
        return fauxAssistantMessage(reportText);
      }]);
      expect(f.parent.getAllTools().map((tool) => tool.name)).not.toContain("adversarial-review");
      await bounded(f.command());
      const entries = f.parent.sessionManager.getEntries();
      const results = entries.filter((entry) => entry.type === "custom" && entry.customType === "adversarial-review-result");
      expect(results).toHaveLength(1);
      const published = findReport(results[0]);
      expect(published?.runtime.backend).toBe(backend);
      expect(published?.overall).toBe("candidate-approve");
      expect(published?.successfulReviewerCount).toBe(2);
      expect(published?.routeResults.map((r) => r.status)).toEqual(["completed", "completed"]);
      expect(published?.runtime.formatRepairAttempts ?? 0).toBe(0);
      const auditDir = join(f.agentDir, "extension-data", "pi-adversarial-review", "audit");
      expect((await readdir(auditDir)).filter((name) => name.endsWith(".json"))).toHaveLength(1);
      expect(f.providers.map((p) => p.state.callCount)).toEqual([1, 1]);
      expect(f.children).toHaveLength(2);
      for (const child of f.children) {
        expect(child.resourceLoader.getSkills().skills).toEqual([]);
        expect(child.resourceLoader.getExtensions().extensions.map((extension) => extension.resolvedPath)).not.toContain(f.ordinaryPath);
        const childCwd = child.sessionManager.getCwd();
        expect(childCwd).not.toBe(f.cwd);
        expect(await exists(childCwd)).toBe(false);
        expect(child.sessionManager.getSessionFile()).toBeUndefined();
      }
      expect(await readFile(f.ordinaryEffect, "utf8")).toBe("start\n");
      await f.assertGitUnchanged();
    } finally { await f.cleanup(); }
  }, 30_000);

  test("provider failure stays on the selected backend without another execution", async () => {
    const f = await fixture(backend);
    try {
      f.providers[0]!.setResponses([fauxAssistantMessage("", { stopReason: "error", errorMessage: "Synthetic permanent failure" })]);
      f.providers[1]!.setResponses([fauxAssistantMessage(reportText)]);
      await bounded(f.command());
      const results = f.parent.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "adversarial-review-result");
      expect(results).toHaveLength(1);
      const published = findReport(results[0]);
      expect(published?.runtime.backend).toBe(backend);
      expect(published?.overall).toBe("inconclusive");
      expect(published?.routeResults.map((r) => r.status).sort()).toEqual(["completed", "errored"]);
      expect(f.providers.map((p) => p.state.callCount)).toEqual([1, 1]);
      expect(f.children).toHaveLength(2);
      await f.assertGitUnchanged();
    } finally { await f.cleanup(); }
  }, 30_000);

  test("command shutdown retains its Git snapshot until children settle, then cleans up and audits cancellation", async () => {
    const f = await fixture(backend);
    const bothEntered = deferred(); const aborted = deferred(); const release = deferred();
    let enteredCount = 0;
    let command: Promise<void> | undefined;
    try {
      for (const provider of f.providers) provider.setResponses([async (_context, options) => {
        options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
        if (++enteredCount === 2) bothEntered.resolve();
        await release.promise;
        return fauxAssistantMessage(reportText);
      }]);
      let commandFinished = false;
      command = f.command().then(() => { commandFinished = true; });
      await bounded(bothEntered.promise);
      const workspaces = f.children.map((child) => child.sessionManager.getCwd());
      expect(workspaces).toHaveLength(2);
      expect(f.git("worktree", "list", "--porcelain")).not.toBe(f.before.worktrees);
      const shutdown = f.parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      await bounded(aborted.promise);
      await delay(30);
      expect(commandFinished).toBe(false);
      for (const workspace of workspaces) expect(await exists(workspace)).toBe(true);
      expect(f.parent.sessionManager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "adversarial-review-result")).toHaveLength(0);
      release.resolve();
      await bounded(Promise.all([command, shutdown]));
      expect(f.providers.map((provider) => provider.state.callCount)).toEqual([1, 1]);
      for (const workspace of workspaces) expect(await exists(workspace)).toBe(false);
      await f.assertGitUnchanged();
      const auditDir = join(f.agentDir, "extension-data", "pi-adversarial-review", "audit");
      const audits = await Promise.all((await readdir(auditDir)).filter((name) => name.endsWith(".json")).map(async (name) =>
        JSON.parse(await readFile(join(auditDir, name), "utf8"))));
      expect(audits).toHaveLength(1);
      expect(findReport(audits[0])?.overall).toBe("cancelled");
      expect(findReport(audits[0])?.runtime.backend).toBe(backend);
    } finally {
      release.resolve();
      try { await command; } finally { await f.cleanup(); }
    }
  }, 30_000);

  test.each(["reviewer", "refuter", "format-repair"] as const)("%s uses the real execution ceiling with a read positive control", async (role) => {
    const f = await fixture(backend);
    try {
      const { runtime } = await f.runtime();
      const terminal: ReviewAgentTerminalEvent[] = [];
      const settled = deferred();
      const unsubscribe = runtime.onTerminal((event) => { terminal.push(event); settled.resolve(); });
      const forbidden = join(f.cwd, "MUST_NOT_WRITE.txt");
      f.providers[0]!.setResponses([
        (context) => {
          expect(getCurrentTools(context.messages).map((tool) => tool.name).sort()).toEqual(role === "format-repair" ? [] : builtins);
          expect(JSON.stringify(context)).not.toContain(parentSecret);
          return fauxAssistantMessage([
            fauxToolCall("read", { path: join(f.cwd, "evidence.txt") }, { id: "positive-read" }),
            fauxToolCall("grep", { pattern: readSentinel, path: f.cwd }, { id: "positive-grep" }),
            fauxToolCall("find", { pattern: "evidence.txt", path: f.cwd }, { id: "positive-find" }),
            fauxToolCall("ls", { path: f.cwd }, { id: "positive-ls" }),
            fauxToolCall("write", { path: forbidden, content: "forbidden" }, { id: "negative-write" }),
          ], { stopReason: "toolUse" });
        },
        (context) => {
          const results = context.messages.filter((message) => message.role === "toolResult");
          const read = results.find((message) => message.toolCallId === "positive-read");
          const write = results.find((message) => message.toolCallId === "negative-write");
          expect(read).toBeDefined(); expect(write).toBeDefined();
          for (const tool of ["read", "grep", "find", "ls"]) {
            const result = results.find((message) => message.toolCallId === `positive-${tool}`);
            expect(result).toBeDefined();
            expect(result?.isError).toBe(role === "format-repair");
            if (role !== "format-repair") expect(JSON.stringify(result)).toContain(tool === "read" || tool === "grep" ? readSentinel : "evidence.txt");
          }
          expect(write?.isError).toBe(true);
          return fauxAssistantMessage(reportText);
        },
      ]);
      const spawned = await runtime.spawn(input(f, role));
      await bounded(settled.promise);
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ agentId: spawned.agentId, correlationId: `contract-${role}`, status: "completed" });
      expect(await exists(forbidden)).toBe(false);
      expect(f.children).toHaveLength(1);
      expect(f.children[0]!.getCallableToolNames().sort()).toEqual(role === "format-repair" ? [] : builtins);
      unsubscribe();
    } finally { await f.cleanup(); }
  }, 30_000);

  test.each(["reviewer", "format-repair"] as const)("%s pin lifecycle does not authorize tools even after fixture activation", async (role) => {
    const f = await fixture(backend, true);
    try {
      const { runtime } = await f.runtime();
      const settled = deferred();
      const terminal: ReviewAgentTerminalEvent[] = [];
      runtime.onTerminal((event) => { terminal.push(event); settled.resolve(); });
      const forbidden = join(f.cwd, "forced-write.txt");
      f.providers[0]!.setResponses([
        (context) => {
          expect(getCurrentTools(context.messages).map((tool) => tool.name).sort()).toEqual(role === "format-repair" ? [] : builtins);
          const child = f.children[0]!;
          // This is a deliberately cooperative same-process observer, not an OS sandbox claim.
          expect(child.getAllTools().map((tool) => tool.name)).toContain("pinned_effect");
          child.setActiveToolsByName(["read", "write", "pinned_effect"]);
          return fauxAssistantMessage([
            fauxToolCall("read", { path: join(f.cwd, "evidence.txt") }, { id: "forced-read" }),
            fauxToolCall("write", { path: forbidden, content: "forbidden" }, { id: "forced-write" }),
            fauxToolCall("pinned_effect", {}, { id: "forced-pin" }),
          ], { stopReason: "toolUse" });
        },
        (context) => {
          const results = context.messages.filter((message) => message.role === "toolResult");
          const read = results.find((message) => message.toolCallId === "forced-read");
          expect(read).toBeDefined();
          expect(read?.isError).toBe(role === "format-repair");
          if (role !== "format-repair") expect(JSON.stringify(read)).toContain(readSentinel);
          for (const id of ["forced-write", "forced-pin"]) {
            expect(results.find((message) => message.toolCallId === id)?.isError).toBe(true);
          }
          return fauxAssistantMessage(reportText);
        },
      ]);
      await runtime.spawn(input(f, role));
      await bounded(settled.promise);
      expect(terminal).toHaveLength(1);
      expect(terminal[0]?.status, terminal[0]?.error).toBe("completed");
      expect(await readFile(f.pinnedLog, "utf8")).toBe("start\nstart\n");
      expect(await exists(f.pinnedEffect)).toBe(false);
      expect(await exists(forbidden)).toBe(false);
      expect(await readFile(f.ordinaryEffect, "utf8")).toBe("start\n");
    } finally { await f.cleanup(); }
  }, 30_000);

  test.each(["stop", "dispose"] as const)("active %s waits past abort acknowledgement for provider settlement", async (operation) => {
    const f = await fixture(backend);
    const entered = deferred(); const aborted = deferred(); const release = deferred();
    try {
      const resolved = await f.runtime();
      const terminal: ReviewAgentTerminalEvent[] = [];
      const settled = deferred();
      resolved.runtime.onTerminal((event) => { terminal.push(event); settled.resolve(); });
      const response: FauxResponseFactory = async (_context, options) => {
        options?.signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
        entered.resolve();
        await release.promise;
        return fauxAssistantMessage(reportText);
      };
      f.providers[0]!.setResponses([response]);
      const { agentId } = await resolved.runtime.spawn(input(f, "reviewer"));
      await bounded(entered.promise);
      let completed = false;
      // External ownership is drained by the real extension shutdown, not by disposing a client subscription.
      const stopping = (operation === "stop" ? resolved.runtime.stop(agentId)
        : backend === "embedded" ? resolved.dispose()
        : f.parent.extensionRunner.emit({ type: "session_shutdown", reason: "quit" }))
        .then(() => { completed = true; });
      await bounded(aborted.promise);
      await delay(30);
      expect(completed).toBe(false);
      expect(terminal).toEqual([]);
      release.resolve();
      await bounded(stopping);
      await bounded(settled.promise);
      expect(terminal).toHaveLength(1);
      expect(terminal[0]).toMatchObject({ agentId, correlationId: "contract-reviewer", status: "stopped" });
      expect(f.providers[0]!.state.callCount).toBe(1);
      await f.assertGitUnchanged();
    } finally { release.resolve(); await f.cleanup(); }
  }, 30_000);
});
