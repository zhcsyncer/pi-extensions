// A fresh process for each phase: no runner/session/module state survives restart.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { fauxProvider, fauxAssistantMessage, fauxToolCall } from "@earendil-works/pi-ai";
import { ModelRuntime, ModelRegistry, SessionManager } from "@earendil-works/pi-coding-agent";

const require = createRequire(import.meta.resolve("@earendil-works/pi-coding-agent"));
const { createJiti } = require("jiti");
const jiti = createJiti(import.meta.url, { nativeModules: ["@earendil-works/pi-coding-agent", "@earendil-works/pi-ai"] });
const { runAgent, resumeAgent, restoreAgentSession, setDefaultMaxTurns, setGraceTurns } = await jiti.import(
  fileURLToPath(new URL("../../src/agent-runner.ts", import.meta.url)),
);
const [phase, root] = process.argv.slice(2);
const cwd = join(root, "work");
const configCwd = join(root, "config");
const metadataFile = join(root, "metadata.json");
const pi = { exec: async () => ({ code: 1, stdout: "", stderr: "" }) };
const faux = fauxProvider({ provider: "restart-faux", models: [{ id: "original", contextWindow: 200_000 }], tokensPerSecond: 1_000_000 });
const runtime = await ModelRuntime.create({ modelsPath: null });
runtime.registerNativeProvider(faux.provider);
await runtime.setRuntimeApiKey("restart-faux", "local-test-only");
await runtime.getAvailable();
const registry = new ModelRegistry(runtime);
const parent = SessionManager.inMemory(cwd);
parent.appendMessage({ role: "user", content: "ORIGINAL_PARENT_HISTORY", timestamp: Date.now() });
const ctx = {
  cwd, model: faux.getModel(), modelRegistry: registry,
  sessionManager: parent,
  getSystemPrompt: () => "ORIGINAL_PARENT_SYSTEM",
};
let session;
try {
  if (phase === "limit") {
    faux.setResponses([fauxAssistantMessage("TERMINAL_ON_TURN_ONE")]);
    const first = await runAgent(ctx, "limit-test", "Answer immediately", {
      pi, maxTurns: 1, graceTurns: 2,
      inlineAgentConfig: {
        name: "limit-test", description: "limit contract", builtinToolNames: ["read"],
        extensions: false, skills: false, promptMode: "replace", systemPrompt: "LIMIT_ROLE", persistSession: false,
      },
      onSessionCreated: (created) => { session = created; },
    });
    const firstCalls = faux.state.callCount;
    const firstQueues = [[...session.getSteeringMessages()], [...session.getFollowUpMessages()]];
    const inputFile = join(root, "input.txt");
    writeFileSync(inputFile, "READ_CONTENT");
    faux.setResponses([
      fauxAssistantMessage(fauxToolCall("read", { path: inputFile }), { stopReason: "toolUse" }),
      (context) => fauxAssistantMessage(context.systemPrompt.includes("You have reached your turn limit") ? "GUIDED_FINAL" : "GUIDANCE_MISSING"),
    ]);
    const resumed = await resumeAgent(session, "Read the file then finish");
    const queues = [[...session.getSteeringMessages()], [...session.getFollowUpMessages()]];
    await session.steer("USER_STEER");
    await session.followUp("USER_FOLLOWUP");
    await resumeAgent(session, "Must not run", { signal: AbortSignal.abort() });
    console.log(JSON.stringify({ first, firstCalls, firstQueues, resumed, queues,
      preservedQueues: [session.getSteeringMessages(), session.getFollowUpMessages()],
    }, (key, value) => key === "session" ? undefined : value));
  } else if (phase === "create") {
    let snapshot;
    faux.setResponses([fauxAssistantMessage("FIRST_ANSWER"), fauxAssistantMessage("RETAINED_ANSWER")]);
    const first = await runAgent(ctx, "restart-test", "ORIGINAL_TASK", {
      pi, cwd, configCwd, inheritContext: true, maxTurns: 2, graceTurns: 1,
      inlineAgentConfig: {
        name: "restart-test", description: "restart contract", builtinToolNames: ["read"],
        extensions: false, skills: true, promptMode: "append", systemPrompt: "ORIGINAL_ROLE",
        persistSession: true, sessionDir: join(root, "sessions"),
      },
      onResumeSnapshot: (saved) => { snapshot = saved; },
      onSessionCreated: (created) => { session = created; },
    });
    if (first.failure) throw new Error(first.failure);
    await resumeAgent(session, "RETAINED_TASK");
    // Use the SDK's persisted compaction checkpoint, not a reconstructed message array.
    const sm = session.sessionManager;
    const kept = sm.getBranch().find((entry) => entry.type === "message" && entry.message.role === "user" && JSON.stringify(entry.message.content).includes("RETAINED_TASK"));
    if (!kept) throw new Error("No retained user turn");
    sm.appendCompaction("COMPACTED_ORIGINAL_CONTEXT", kept.id, 20_000);
    sm.appendCustomEntry("restart-proof", { original: true });
    writeFileSync(metadataFile, JSON.stringify({ snapshot, sessionFile: session.sessionFile }));
    console.log(JSON.stringify({ pid: process.pid, snapshot, sessionFile: session.sessionFile }));
  } else {
    const saved = JSON.parse(readFileSync(metadataFile, "utf8"));
    // Any use of the new parent's prompt/history is a contract failure.
    ctx.getSystemPrompt = () => { throw new Error("Restoration inherited NEW parent prompt"); };
    ctx.sessionManager = { getBranch: () => { throw new Error("Restoration inherited NEW parent context"); } };
    setDefaultMaxTurns(99);
    setGraceTurns(99);
    if (phase === "unavailable") runtime.unregisterProvider("restart-faux");
    session = await restoreAgentSession(ctx, saved.sessionFile, saved.snapshot, { pi });
    const before = session.messages;
    const originalPrompt = session.systemPrompt;
    let request;
    faux.setResponses([(context) => {
      request = { systemPrompt: context.systemPrompt, messages: context.messages };
      return fauxAssistantMessage("RESTORED_ANSWER");
    }]);
    const result = await resumeAgent(session, "NEW_TASK");
    console.log(JSON.stringify({
      pid: process.pid, result, before, originalPrompt, request,
      sessionFile: session.sessionFile, tools: session.getActiveToolNames(),
      custom: session.sessionManager.getEntries().find((entry) => entry.type === "custom" && entry.customType === "restart-proof"),
    }));
  }
} catch (error) {
  console.log(JSON.stringify({ pid: process.pid, error: error.message }));
} finally {
  session?.dispose();
}
