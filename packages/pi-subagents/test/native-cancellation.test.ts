import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { setImmediate as nextEventLoopTurn } from "node:timers/promises";
import { fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { createAgentSession, createCodemodeExtension, DefaultResourceLoader, getAgentDir, ModelRuntime, SessionManager, SettingsManager } from "@earendil-works/pi-coding-agent";
import { Type } from "@sinclair/typebox";
import { expect, it } from "vitest";

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}

async function fixture() {
  const cwd = mkdtempSync(join(tmpdir(), "native-cancellation-"));
  const trace: string[] = [];
  const started = gate(), childAborted = gate(), release = gate(), rootResult = gate(), waiterStarted = gate(), childSettled = gate(), siblingEnded = gate();
  let childReturned = false, observedAbort = false;
  const parent = fauxProvider({ provider: "cancel-parent", models: [{ id: "model", contextWindow: 200000 }] });
  const child = fauxProvider({ provider: "cancel-child", models: [{ id: "model", contextWindow: 200000 }] });
  mkdirSync(join(cwd, ".pi/agents"), { recursive: true });
  writeFileSync(join(cwd, ".pi/agents/local.md"), "---\ntools: none\nextensions: none\nskills: none\nmodel: cancel-child/model\npersist_session: false\nprompt_mode: replace\n---\nHELD_CHILD");
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
  for (const provider of [parent, child]) {
    runtime.registerNativeProvider(provider.provider);
    await runtime.setRuntimeApiKey(provider.getModel().provider, "offline-only");
  }
  await runtime.getAvailable();
  const args = { prompt: "held child", description: "cancellation", subagent_type: "local" };
  const settings = SettingsManager.inMemory({ defaultTools: ["+codemode"], compaction: { enabled: false }, retry: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd, agentDir: getAgentDir(), settingsManager: settings,
    noExtensions: true, noSkills: true, noContextFiles: true, noPromptTemplates: true, noThemes: true,
    additionalExtensionPaths: [fileURLToPath(new URL("../src/index.ts", import.meta.url))],
    // Observe entry into the public result boundary before any production wait.
    extensionsOverride: base => ({ ...base, extensions: [
      ...base.extensions.filter(extension => extension.path === "<inline:cancel-observer>"),
      ...base.extensions.filter(extension => extension.path !== "<inline:cancel-observer>"),
    ] }),
    extensionFactories: [createCodemodeExtension({ models: false }), { name: "cancel-observer", factory(pi) {
      pi.registerTool({ name: "middle", label: "middle", description: "public nested caller", parameters: Type.Object({}),
        async execute(_id, _args, signal, _update, ctx) {
          const outcome = await ctx.executeTool("Agent", args, { signal });
          return { content: outcome.result.content, details: {}, isError: outcome.isError };
        } });
      pi.registerTool({ name: "unrelated", label: "unrelated", description: "independent root control", parameters: Type.Object({}),
        async execute() { await started.promise; return { content: [{ type: "text", text: "UNRELATED" }], details: {} }; } });
      pi.on("tool_call", event => {
        if (event.toolName === "get_subagent_result") waiterStarted.resolve();
        if (event.toolName === "Agent" && event.input.prompt === "blocked") return { block: true, reason: "fixture veto" };
      });
      pi.on("tool_result", event => {
        trace.push(`result:${event.toolName}`);
        if (!event.parentToolCallId) rootResult.resolve();
      });
      pi.on("tool_execution_end", event => {
        trace.push(`end:${event.toolName}`);
        if (event.toolCallId === "root-b" && !event.parentToolCallId) siblingEnded.resolve();
      });
      pi.on("agent_settled", () => { trace.push("parent-settled"); });
      for (const event of ["subagents:completed", "subagents:failed"]) pi.events.on(event, () => {
        trace.push("child-settled"); childSettled.resolve();
      });
    } }],
  });
  await loader.reload();
  expect(loader.getExtensions().errors).toEqual([]);
  const { session } = await createAgentSession({ cwd, agentDir: getAgentDir(), modelRuntime: runtime, model: parent.getModel(),
    resourceLoader: loader, settingsManager: settings, sessionManager: SessionManager.inMemory(cwd) });
  await session.bindExtensions({});
  child.setResponses([async (_context, options) => {
    trace.push("child-start"); started.resolve();
    const abort = () => { observedAbort = true; trace.push("child-abort"); childAborted.resolve(); };
    if (options?.signal?.aborted) abort(); else options?.signal?.addEventListener("abort", abort, { once: true });
    await release.promise;
    childReturned = true; trace.push("child-provider-return");
    return fauxAssistantMessage("CHILD_DONE", { stopReason: observedAbort ? "aborted" : "stop" });
  }]);
  return { session, trace, args, started, childAborted, release, rootResult, waiterStarted, childSettled, siblingEnded,
    get observedAbort() { return observedAbort; }, get childReturned() { return childReturned; },
    run(name: string, input: Parameters<typeof fauxToolCall>[1], sibling?: ReturnType<typeof fauxToolCall>) {
      const calls = [fauxToolCall(name, input), ...(sibling ? [sibling] : [])];
      parent.setResponses([fauxAssistantMessage(calls, { stopReason: "toolUse" }),
        ...Array.from({ length: 10 }, () => fauxAssistantMessage("PARENT_DONE"))]);
      return session.prompt("run cancellation fixture");
    },
    async close() {
      release.resolve();
      await session.abort(); await session.waitForIdle();
      await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
      session.dispose(); rmSync(cwd, { recursive: true, force: true });
    },
  };
}

it.each(["direct", "codemode", "middle"])("waits for actual foreground child settlement on cancellation (%s)", async mode => {
  const f = await fixture();
  try {
    const prompt = mode === "direct" ? f.run("Agent", f.args)
      : f.run("codemode", { code: mode === "middle" ? "return await tools.middle({});" : `return await tools.Agent(${JSON.stringify(f.args)});` });
    await f.started.promise;
    let returned = false;
    const abort = f.session.abort().then(() => { returned = true; f.trace.push("abort-return"); });
    await f.childAborted.promise;
    if (mode !== "direct") await f.rootResult.promise;
    // The native VM has already stopped and entered root tool_result. Drain its
    // microtasks, not a timed sleep or an observation before VM termination.
    await nextEventLoopTurn();
    expect(returned).toBe(false);
    expect(f.trace).not.toContain("parent-settled");
    f.release.resolve();
    await Promise.all([abort, prompt]);
    expect(f.trace.indexOf("child-provider-return")).toBeLessThan(f.trace.indexOf("child-settled"));
    expect(f.trace.indexOf("child-settled")).toBeLessThan(f.trace.indexOf("abort-return"));
    const result = f.session.messages.filter(message => message.role === "toolResult").at(-1)!;
    const details = result.details as { subagentUsageRollup?: { reportedUsage?: { totalTokens: number } }; subagentUsageRollups?: Array<{ reportedUsage?: { totalTokens: number } }> };
    const receipts = mode === "direct" ? [details.subagentUsageRollup] : details.subagentUsageRollups;
    expect(result.usage!.totalTokens).toBeGreaterThan(0);
    expect(receipts).toHaveLength(1);
    expect(receipts![0]?.reportedUsage?.totalTokens).toBe(result.usage!.totalTokens);
  } finally { await f.close(); }
});

it("does not hold an unrelated native root behind another root's active Agent", async () => {
  const f = await fixture();
  try {
    const prompt = f.run("codemode", { code: `return await tools.Agent(${JSON.stringify(f.args)});` },
      fauxToolCall("codemode", { code: 'await tools.unrelated({}); return "OTHER_ROOT_DONE";' }, { id: "root-b" }));
    await f.started.promise;
    await f.siblingEnded.promise;
    expect(f.childReturned).toBe(false);
    const abort = f.session.abort();
    await f.childAborted.promise;
    f.release.resolve();
    await Promise.all([abort, prompt]);
  } finally { await f.close(); }
});

it.each([false, true])("does not wait for or terminate a returned background task (cancel waiter=%s)", async waiter => {
  const f = await fixture();
  try {
    const code = `const launched=await tools.Agent(${JSON.stringify({ ...f.args, run_in_background: true })});text(launched);` +
      (waiter ? 'const agent_id=launched.match(/Agent ID: ([^\\n]+)/)[1];return await tools.get_subagent_result({agent_id,wait:true});'
        : 'throw new Error("AFTER_BACKGROUND_ID");');
    const prompt = f.run("codemode", { code });
    await f.started.promise;
    if (waiter) await f.waiterStarted.promise; else await f.rootResult.promise;
    await f.session.abort();
    expect(f.childReturned).toBe(false);
    expect(f.observedAbort).toBe(false);
    f.release.resolve(); await f.childSettled.promise; await prompt;
  } finally { await f.close(); }
});

it("settles invalid, blocked and failed nested Agent calls without leaving a result wait", async () => {
  const f = await fixture();
  try {
    const blocked = { ...f.args, prompt: "blocked" };
    const failed = { ...f.args, resume: "nonexistent-agent" };
    await f.run("codemode", { code: `await Promise.allSettled([tools.Agent({}), tools.Agent(${JSON.stringify(blocked)}), tools.Agent(${JSON.stringify(failed)})]); return "SETTLED";` });
    expect(f.trace.filter(event => event === "end:Agent")).toHaveLength(3);
    expect(JSON.stringify(f.session.messages)).toContain("SETTLED");
    expect(f.trace).not.toContain("child-start");
  } finally { await f.close(); }
});
