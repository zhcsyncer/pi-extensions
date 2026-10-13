import assert from "node:assert/strict";
import childProcess from "node:child_process";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { syncBuiltinESMExports } from "node:module";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test, type TestContext } from "node:test";
import {
  createAssistantMessageEventStream, fauxAssistantMessage, fauxProvider,
  type Model, type Provider, type StreamOptions, type TranscriptContext,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
  type ExtensionAPI, type ExtensionContext, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import recapExtension, { DEFAULT_CONFIG, createRecapState, runRecap } from "../extensions/recap.ts";

type Config = Parameters<typeof runRecap>[2];
type Call = { model: Model<string>; context: TranscriptContext; options?: StreamOptions };
const SUMMARY = "完成离线回顾合同验证";
const TITLE = "离线回顾验证";
const HISTORY = "N3-recent-history-marker: 检查原生模型请求，保留当前用户身份。";
const REPLY = JSON.stringify({ recap: SUMMARY, title: TITLE });

function config(model = "current", policy: Config["title"]["applyPolicy"] = "off"): Config {
  return {
    ...structuredClone(DEFAULT_CONFIG),
    recap: { ...DEFAULT_CONFIG.recap, auto: false, model, language: "zh-CN" },
    title: { applyPolicy: policy },
    multiplexer: { ...DEFAULT_CONFIG.multiplexer, enabled: false },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

async function bounded<T>(promise: Promise<T>, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([promise, new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`Fixture did not reach ${label}`)), 3000);
    })]);
  } finally { clearTimeout(timer); }
}

async function fixture(t: TestContext, cfg = config(), oauth = false) {
  const root = mkdtempSync(join(tmpdir(), "n3-recap-contract-"));
  const savedEnv = { ...process.env };
  // No inherited accounts, mux sockets, executable paths, or user configuration.
  for (const key of Object.keys(process.env)) delete process.env[key];
  Object.assign(process.env, {
    HOME: root, PI_CODING_AGENT_DIR: join(root, "agent"),
    XDG_CONFIG_HOME: join(root, "config"), XDG_CACHE_HOME: join(root, "cache"),
    PATH: join(root, "empty-bin"), PI_OFFLINE: "1",
  });
  mkdirSync(join(root, "agent", "extension-data", "pi-recap"), { recursive: true });
  const configPath = join(root, "agent", "extension-data", "pi-recap", "config.json");
  writeFileSync(configPath, JSON.stringify(cfg));
  const denied: string[] = [];
  const deny = (boundary: string) => (..._args: unknown[]): never => {
    denied.push(boundary);
    throw new Error(`N3 fixture blocks ${boundary}`);
  };
  // Fail closed even if configuration loading or an assertion fails. These are
  // transport/process boundaries, not substitutes for registry.complete().
  for (const name of ["exec", "execSync", "execFile", "execFileSync", "spawn", "spawnSync", "fork"] as const) {
    t.mock.method(childProcess, name, deny(`external command:${name}`));
  }
  t.mock.method(globalThis, "fetch", deny("fetch"));
  t.mock.method(http, "request", deny("http"));
  t.mock.method(http, "get", deny("http"));
  t.mock.method(https, "request", deny("https"));
  t.mock.method(https, "get", deny("https"));
  t.mock.method(net.Socket.prototype, "connect", deny("socket"));
  syncBuiltinESMExports();
  let session: Awaited<ReturnType<typeof createAgentSession>>["session"] | undefined;
  const releases: Array<() => void> = [];
  t.after(async () => {
    try {
      await session?.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      for (const release of releases) release();
      try { session?.dispose(); } finally {
        t.mock.restoreAll();
        syncBuiltinESMExports();
        for (const key of Object.keys(process.env)) delete process.env[key];
        Object.assign(process.env, savedEnv);
        rmSync(root, { recursive: true, force: true });
      }
    }
    assert.deepEqual(denied, [], "fixture must not attempt external commands or network");
  });

  const calls: Call[] = [];
  let nextReply: () => Promise<string> = async () => REPLY;
  let arrival = deferred<Call>();
  if (oauth) writeFileSync(join(root, "auth.json"), JSON.stringify({
    "n3-fixed": { type: "oauth", access: "offline-access", refresh: "offline-refresh", expires: Date.now() + 86_400_000 },
  }));
  const runtime = await ModelRuntime.create({
    authPath: join(root, "auth.json"), modelsPath: null,
    modelsStorePath: join(root, "models-cache.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
  function provider(id: string): Provider {
    const faux = fauxProvider({ provider: id, models: [{ id: "same-model" }] });
    const stream: Provider["stream"] = (model, context, options) => {
      const call = { model, context: structuredClone(context), options };
      calls.push(call);
      arrival.resolve(call);
      const events = createAssistantMessageEventStream();
      // Intentionally non-cooperative: cancellation must be checked by recap,
      // not accidentally implemented by a friendly fake transport.
      void nextReply().then((text) => {
        const message = { ...fauxAssistantMessage(text), model: model.id, provider: model.provider, api: model.api };
        events.push({ type: "done", reason: "stop", message });
      });
      return events;
    };
    return {
      ...faux.provider,
      auth: {
        apiKey: { name: "offline route", resolve: async () => ({
          auth: { apiKey: `test-only-${id}`, headers: { "x-contract-route": id } },
        }) },
        oauth: {
          name: "offline subscription", isSubscription: true,
          login: async () => { throw new Error("fixture forbids login"); },
          refresh: async () => { throw new Error("fixture must use its unexpired credential"); },
          toAuth: async (credential) => ({ apiKey: credential.access, headers: { "x-contract-route": id } }),
        },
      },
      stream, streamSimple: stream,
    };
  }
  for (const id of ["n3-current", "n3-fixed", "opencode"]) runtime.registerNativeProvider(provider(id));
  const current = runtime.getModel("n3-current", "same-model");
  assert.ok(current, "fixture physical current model exists");
  const manager = SessionManager.create(root, join(root, "sessions"));
  manager.appendMessage({ role: "user", content: HISTORY, timestamp: Date.now() });
  manager.appendMessage(fauxAssistantMessage("已检查最近请求，准备回顾。"));
  const settings = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
  let pi!: ExtensionAPI;
  let ctx!: ExtensionContext;
  const loader = new DefaultResourceLoader({
    cwd: root, agentDir: join(root, "agent"), settingsManager: settings,
    noExtensions: true, noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
    extensionFactories: [(api) => {
      pi = api;
      api.on("session_start", (_event, context) => { ctx = context; });
      recapExtension(api);
    }],
  });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, [], "fixture extension loads");
  ({ session } = await createAgentSession({
    cwd: root, agentDir: join(root, "agent"), resourceLoader: loader,
    modelRuntime: runtime, model: current, sessionManager: manager,
    settingsManager: settings, noTools: "all",
  }));
  const notices: string[] = [];
  const widgets = new Map<string, unknown>();
  const errors: unknown[] = [];
  let editedConfig: string | undefined;
  let editorCalls = 0;
  const ui: ExtensionUIContext = {
    ...session.extensionRunner.getUIContext(),
    notify: (text) => { notices.push(text); },
    editor: async () => { editorCalls++; return editedConfig; },
    setWidget: (key, content) => { widgets.set(key, content); },
  };
  await session.bindExtensions({ mode: "tui", uiContext: ui, onError: (error) => errors.push(error) });
  assert.ok(pi && ctx, "fixture captures the real factory API/context");
  assert.equal(ctx.mode, "tui");
  assert.equal(ctx.hasUI, true);
  assert.deepEqual(errors, [], "fixture startup succeeds");
  // Independent positive control: the native SDK route works before any
  // negative assertion about recap (including 'no call' / cancellation).
  const control = await ctx.modelRegistry.complete(current, {
    messages: [{ role: "system", content: "native fixture control", timestamp: Date.now() },
      { role: "user", content: "control", timestamp: Date.now() }],
  }, { maxTokens: 17, sessionId: manager.getSessionId() });
  assert.equal(control.stopReason, "stop");
  assert.equal(calls.at(-1)?.model.provider, "n3-current");
  assert.equal(calls.at(-1)?.context.messages[0]?.role, "system");
  calls.length = 0;
  arrival = deferred<Call>();
  const state = createRecapState(cfg);
  return {
    pi, ctx, manager, session, cfg, state, calls, notices, widgets, denied, errors,
    async enableAutomaticRecap() {
      // Initial startup remains auto:false. Only this explicit lifecycle test
      // enables the timer through the public command, inside the offline jail.
      editedConfig = JSON.stringify({ ...cfg, recap: { ...cfg.recap, auto: true, idleAfterTurnMs: 1000 } });
      assert.ok(session!.extensionRunner.getCommand("recap-config"));
      await session!.prompt("/recap-config json");
      assert.deepEqual(errors, [], "public config command succeeds");
      assert.equal(editorCalls, 1, "public JSON config editor opened");
      const saved = JSON.parse(readFileSync(configPath, "utf8"));
      assert.equal(saved.recap.auto, true);
      assert.equal(saved.recap.idleAfterTurnMs, 1000, "fixture timer agrees with saved public config");
    },
    entries: () => manager.getEntries().filter((entry) => entry.type === "custom" && entry.customType === "recap"),
    run: (reason: "manual" | "auto" = "manual", signal?: AbortSignal) =>
      runRecap(pi, ctx, cfg, state, reason, { signal, showProgress: false, force: reason === "manual" }),
    hold() {
      const gate = deferred<string>();
      releases.push(() => gate.resolve(REPLY));
      arrival = deferred<Call>();
      nextReply = () => gate.promise;
      return { arrived: () => bounded(arrival.promise, "physical provider dispatch"), release: gate.resolve };
    },
  };
}

for (const [selected, oauth] of [
  ["current", false], ["n3-fixed/same-model", false], ["opencode/same-model", false],
  ["n3-fixed/same-model", true],
] as const) {
  test(`native contract: ${selected} (${oauth ? "OAuth subscription" : "API key"}) receives instructions, history and identity`, async (t) => {
    const f = await fixture(t, config(selected), oauth);
    const abort = new AbortController();
    const result = await f.run("manual", abort.signal);
    assert.ok(result, "a valid JSON recap must succeed");
    assert.equal(f.calls.length, 1);
    const call = f.calls[0]!;
    const provider = selected === "current" ? "n3-current" : selected.split("/")[0];
    assert.equal(call.model.provider, provider, "do not substitute a same-named model on another route");
    assert.equal(call.model.id, "same-model");
    assert.equal(call.options?.apiKey, oauth ? "offline-access" : `test-only-${provider}`);
    assert.equal(call.options?.headers?.["x-contract-route"], provider);
    assert.equal(call.options?.sessionId, f.manager.getSessionId());
    assert.equal(call.options?.maxTokens, 300);
    assert.ok(call.options?.signal, "cancellation reaches the physical provider");
    assert.equal(call.options.signal.aborted, false);
    const systems = call.context.messages.filter((message) => message.role === "system");
    assert.ok(systems.length > 0, "native Context needs an actual system message, not legacy systemPrompt");
    const instructions = JSON.stringify(systems);
    assert.match(instructions, /zh-CN/);
    assert.match(instructions, /json/i);
    assert.match(instructions, /recap/i);
    assert.match(instructions, /title/i);
    assert.match(JSON.stringify(call.context.messages.filter((message) => message.role !== "system")), /N3-recent-history-marker/);
    if (provider === "opencode") {
      assert.ok(Object.entries(call.options.headers ?? {}).some(([key, value]) =>
        /session/i.test(key) && value === f.manager.getSessionId()), "OpenCode session header is retained");
    }
    assert.equal(f.entries().length, 1);
    assert.match(JSON.stringify(f.entries()[0]), new RegExp(SUMMARY));
    assert.equal(f.manager.getSessionName(), undefined, "title off must not rename");
    assert.deepEqual(f.denied, [], "no external commands or network attempted");
  });
}

test("successful JSON applies an allowed title and unchanged source does not request again", async (t) => {
  const f = await fixture(t, config("current", "always"));
  assert.ok(await f.run());
  assert.equal(f.entries().length, 1);
  assert.equal(f.manager.getSessionName(), TITLE);
  f.cfg.recap.auto = true;
  f.manager.appendMessage({ role: "user", content: "new completed turn", timestamp: Date.now() });
  f.manager.appendMessage(fauxAssistantMessage("new assistant activity"));
  assert.ok(await f.run("auto"), "fixture: positive automatic dispatch before unchanged-source assertion");
  const before = f.calls.length;
  assert.equal(await f.run("auto"), undefined);
  assert.equal(f.calls.length, before, "recap metadata/title is not new source activity");
  assert.equal(f.entries().length, 2);
});

test("if-empty-or-auto preserves a manual rename across reload", async (t) => {
  const f = await fixture(t, config("current", "if-empty-or-auto"));
  assert.ok(await f.run());
  assert.equal(f.manager.getSessionName(), TITLE);
  f.pi.setSessionName("user-owned title");
  const entries = f.entries();
  const calls = f.calls.length;
  await f.session.reload();
  assert.equal(f.manager.getSessionName(), "user-owned title");
  assert.deepEqual(f.entries(), entries, "reload restores rather than appends recap state");
  assert.equal(f.calls.length, calls, "reload with auto disabled does not request a recap");
  assert.deepEqual(f.errors, []);
});

for (const fallback of [false, true]) {
  test(`missing fixed route: fallbackToCurrentModel=${fallback}`, async (t) => {
    const cfg = config("missing-channel/same-model");
    cfg.recap.fallbackToCurrentModel = fallback;
    const f = await fixture(t, cfg);
    const result = await f.run();
    if (fallback) {
      assert.ok(result);
      assert.equal(f.calls.length, 1);
      assert.equal(f.calls[0]!.model.provider, "n3-current");
      assert.ok(f.notices.some((text) => /missing-channel/.test(text)), "fallback must be visible");
    } else {
      assert.equal(result, undefined);
      assert.equal(f.calls.length, 0, "never silently choose the other same-model channel");
      assert.equal(f.entries().length, 0);
    }
  });
}

for (const reason of ["manual", "auto"] as const) {
  test(`${reason} abort: a non-cooperative late completion cannot append or overwrite title/widget`, async (t) => {
    const f = await fixture(t, config("current", "always"));
    assert.ok(await f.run(), "positive recap control before testing cancellation");
    f.manager.appendMessage({ role: "user", content: "new activity after positive control", timestamp: Date.now() });
    f.cfg.recap.auto = true;
    f.manager.appendMessage(fauxAssistantMessage("completed new activity"));
    const controller = new AbortController();
    const held = f.hold();
    const pending = f.run(reason, controller.signal);
    const call = await held.arrived();
    assert.ok(call.options?.signal);
    controller.abort();
    assert.equal(call.options.signal.aborted, true);
    f.pi.setSessionName("user name after cancellation");
    const widgets = new Map(f.widgets);
    const entries = f.entries();
    held.release(JSON.stringify({ recap: "STALE-RECAP", title: "STALE-TITLE" }));
    assert.equal(await bounded(pending, "cancelled recap settlement"), undefined);
    assert.deepEqual(f.entries(), entries);
    assert.equal(f.manager.getSessionName(), "user name after cancellation");
    for (const [key, widget] of f.widgets) {
      assert.ok(widget === undefined || widget === widgets.get(key), "cancel may clear but never publish a late result");
    }
  });
}

for (const event of ["input", "agent_start", "session_shutdown"] as const) {
  test(`automatic ${event} cancellation ignores a non-cooperative late result`, async (t) => {
    const f = await fixture(t, config("current", "always"));
    assert.ok(await f.run(), "successful recap control precedes lifecycle assertions");
    await f.enableAutomaticRecap();
    await f.session.prompt("new completed turn for automatic recap");
    const held = f.hold();
    const call = await held.arrived();
    assert.ok(call.options?.signal, "an automatic request is really in flight");
    if (event === "input") await f.session.extensionRunner.emitInput("new input", undefined, "interactive");
    else if (event === "agent_start") await f.session.extensionRunner.emit({ type: "agent_start" });
    else await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    assert.equal(call.options.signal.aborted, true, `${event} cancels the physical request`);
    const before = f.entries();
    const widgets = new Map(f.widgets);
    f.pi.setSessionName("newer user title");
    held.release(JSON.stringify({ recap: "STALE-RECAP", title: "STALE-TITLE" }));
    // A public completion has no timer job handle. Drain the provider/registry
    // promise chain and one event-loop turn, rather than sleeping for success.
    await new Promise<void>((resolve) => setImmediate(resolve));
    assert.deepEqual(f.entries(), before);
    assert.equal(f.manager.getSessionName(), "newer user title");
    assert.deepEqual(f.widgets, widgets);
    assert.deepEqual(f.errors, []);
  });
}

