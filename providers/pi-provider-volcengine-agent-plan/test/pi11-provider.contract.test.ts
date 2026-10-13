import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";
import { createJiti } from "jiti";
import type {
  ApiKeyCredential, AssistantMessage, AssistantMessageEventStream, AuthContext, AuthCheck,
  Api, Model, ModelThinkingLevel, Provider,
} from "@earendil-works/pi-ai";
import {
  createAgentSession, DefaultResourceLoader, ModelRuntime,
  SessionManager, SettingsManager, type ExtensionFactory,
} from "@earendil-works/pi-coding-agent";
import { createProvider, InMemoryCredentialStore } from "@earendil-works/pi-ai/compat";
import { openAICompletionsApi } from "@earendil-works/pi-ai/api/openai-completions.lazy";
import { openAIResponsesApi } from "@earendil-works/pi-ai/api/openai-responses.lazy";

// Independent N4 contract. Only public entry points; no producer helpers or tests.
// All credentials and transcripts are synthetic. fetch never delegates to the network.
const PROVIDER = "volcengine-agent-plan";
const BASE = "https://ark.cn-beijing.volces.com/api/plan/v3";
const KEY = "synthetic-agent-plan-contract-key";
const OTHER_KEY = "synthetic-other-provider-key";
const USER = { role: "user" as const, content: "offline contract", timestamp: 1 };
const originalEnv = process.env;
const originalFetch = globalThis.fetch;
type Product = typeof import("../index.ts");
let product: Product;
const entry = fileURLToPath(new URL("../index.ts", import.meta.url));
let root: string;
const unexpected: string[] = [];
const deny: typeof fetch = async (input) => {
  const url = input instanceof Request ? input.url : String(input);
  unexpected.push(url);
  throw new Error(`Unexpected offline request: ${url}`);
};

before(async () => {
  process.env = { PATH: originalEnv.PATH, HOME: await mkdtemp(join(tmpdir(), "n4-home-")) };
  root = process.env.HOME!;
  globalThis.fetch = deny;
  process.env.PI_OFFLINE = "1";
  process.env.PI_CURSOR_SYSTEM_CREDENTIALS = "0";
  process.env.ARK_AGENT_PLAN_API_KEY = "synthetic-ambient-primary";
  process.env.VOLCENGINE_ARK_PLAN_API_KEY = "synthetic-ambient-alias";
  process.env.OPENAI_API_KEY = OTHER_KEY;
  process.env.MOONSHOT_API_KEY = OTHER_KEY;
  // Pi extensions use the SDK's public compatibility facade, not pi-ai's core-only barrel.
  const jiti = createJiti(import.meta.url, { interopDefault: false,
    alias: {
      "@earendil-works/pi-ai/providers": fileURLToPath(new URL("./providers", import.meta.resolve("@earendil-works/pi-ai"))),
      "@earendil-works/pi-ai": fileURLToPath(import.meta.resolve("@earendil-works/pi-ai/compat")),
    } });
  product = await jiti.import<Product>(entry);
});
after(async () => {
  globalThis.fetch = originalFetch;
  process.env = originalEnv;
  await rm(root, { recursive: true, force: true });
  assert.deepEqual(unexpected, [], "no unexpected HTTP, including auth/catalog/login");
});

function credential(tier?: string): ApiKeyCredential {
  return { type: "api_key", key: KEY, ...(tier ? { env: { ARK_AGENT_PLAN_TIER: tier } } : {}) };
}
function context(env: Record<string, string> = {}): AuthContext {
  return { env: async (name) => env[name], fileExists: async () => false };
}
async function runtime(tier?: string) {
  const credentials = new InMemoryCredentialStore();
  await credentials.modify(PROVIDER, async () => credential(tier));
  await credentials.modify("openai", async () => ({ type: "api_key", key: OTHER_KEY }));
  return ModelRuntime.create({
    credentials,
    modelsPath: null, modelsStorePath: join(root, "unused-models.json"),
    allowModelNetwork: false, refreshOnCreate: false,
  });
}
async function loadedProvider(): Promise<ReturnType<Product["createAgentPlanProvider"]>> {
  const models = await runtime();
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
    additionalExtensionPaths: [entry], noSkills: true, noPromptTemplates: true,
    noThemes: true, noContextFiles: true, systemPrompt: "Offline contract only." });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: models,
    resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root), tools: [] });
  try {
    const provider = models.getRegisteredNativeProvider(PROVIDER);
    assert.ok(provider, "real loader must register the native provider");
    return provider as ReturnType<Product["createAgentPlanProvider"]>;
  } finally { session.dispose(); }
}
function modelOf(provider: ReturnType<Product["createAgentPlanProvider"]>, id: string) {
  const model = provider.getModels().find((m) => m.id === id);
  assert.ok(model, `public catalog must expose ${id}`);
  return model;
}
function sse(events: unknown[]) {
  return new Response(events.map((event) => `data: ${JSON.stringify(event)}\n\n`).join("") + "data: [DONE]\n\n", {
    headers: { "content-type": "text/event-stream" },
  });
}
// OpenAI public SSE protocol: item added -> text delta -> item done -> completed.
function responses(model: string) {
  const item = { id: "msg_fixture", type: "message", role: "assistant", status: "completed",
    content: [{ type: "output_text", text: "fixture answer", annotations: [] }] };
  const response = { id: "resp_fixture", object: "response", created_at: 1, model,
    status: "completed", output: [item], error: null, incomplete_details: null,
    usage: { input_tokens: 10, output_tokens: 2, total_tokens: 12,
      input_tokens_details: { cached_tokens: 0 }, output_tokens_details: { reasoning_tokens: 0 } } };
  return sse([
    { type: "response.created", sequence_number: 0, response: { ...response, status: "in_progress", output: [] } },
    { type: "response.output_item.added", sequence_number: 1, output_index: 0,
      item: { ...item, status: "in_progress", content: [] } },
    { type: "response.content_part.added", sequence_number: 2, item_id: item.id, output_index: 0, content_index: 0,
      part: { type: "output_text", text: "", annotations: [] } },
    { type: "response.output_text.delta", sequence_number: 3, item_id: item.id, output_index: 0, content_index: 0, delta: "fixture answer" },
    { type: "response.output_text.done", sequence_number: 4, item_id: item.id, output_index: 0, content_index: 0, text: "fixture answer" },
    { type: "response.output_item.done", sequence_number: 5, output_index: 0, item },
    { type: "response.completed", sequence_number: 6, response },
  ]);
}
function chat(model: string) {
  const chunk = { id: "chat_fixture", object: "chat.completion.chunk", created: 1, model };
  return sse([
    { ...chunk, choices: [{ index: 0, delta: { role: "assistant", reasoning_content: "fixture thought" }, finish_reason: null }] },
    { ...chunk, choices: [{ index: 0, delta: { content: "fixture answer" }, finish_reason: null }] },
    { ...chunk, choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
      usage: { prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 } },
  ]);
}
type Body = Record<string, unknown>;
function fixture(model: Model<Api>, mode: "success" | "error" | "cancel" = "success", key = KEY) {
  const requests: Body[] = [];
  const violations: string[] = [];
  let requestStarted!: () => void;
  const started = new Promise<void>((resolve) => { requestStarted = resolve; });
  const fetchImpl: typeof fetch = async (input, init) => {
    const request = new Request(input, init);
    const expected = `${model.baseUrl}/${model.api === "openai-completions" ? "chat/completions" : "responses"}`;
    try {
      assert.equal(request.url, expected);
      assert.equal(request.method, "POST");
      assert.equal(request.headers.get("authorization"), `Bearer ${key}`);
      const body = await request.json() as Body;
      assert.equal(body.model, model.id);
      assert.equal(body.stream, true);
      requests.push(body);
      requestStarted();
    } catch (error) {
      violations.push(String(error));
      throw error;
    }
    if (mode === "error") return Response.json({ error: { message: "synthetic unavailable", type: "server_error" } }, { status: 503 });
    if (mode === "cancel") {
      return new Promise<Response>((_resolve, reject) => {
        const abort = () => reject(new DOMException("synthetic cancellation", "AbortError"));
        if (request.signal.aborted) abort();
        else request.signal.addEventListener("abort", abort, { once: true });
      });
    }
    return model.api === "openai-completions" ? chat(model.id) : responses(model.id);
  };
  return { fetchImpl, requests, started, verify(count: number) {
    assert.deepEqual(violations, [], "strict transport expectations");
    assert.equal(requests.length, count, "no fallback channel or unexpected retry");
  } };
}
async function collect(stream: AssistantMessageEventStream) {
  const events: string[] = [];
  for await (const event of stream) events.push(event.type);
  return { events, message: await stream.result() };
}
function success(result: Awaited<ReturnType<typeof collect>>, provider = PROVIDER) {
  assert.equal(result.message.stopReason, "stop", result.message.errorMessage);
  assert.equal(result.message.provider, provider);
  assert.ok(result.events.includes("start"));
  assert.ok(result.events.includes("text_delta"));
  assert.equal(result.events.at(-1), "done");
  assert.ok(!result.events.includes("error"));
  assert.equal(result.message.content.filter((b) => b.type === "text").map((b) => b.text).join(""), "fixture answer");
  assert.equal(result.message.usage.input, 10);
  assert.equal(result.message.usage.output, 2);
}

test("public factory and validation signatures remain available in the Pi host module surface", () => {
  const factory: (options?: { fetchImpl?: typeof fetch }) => Provider = product.createAgentPlanProvider;
  const validate: (key: string, options?: { fetchImpl?: typeof fetch; signal?: AbortSignal; timeoutMs?: number }) => ReturnType<typeof product.validateAgentPlanKey> = product.validateAgentPlanKey;
  const extension: ExtensionFactory = product.default;
  assert.equal(typeof validate, "function");
  assert.equal(typeof extension, "function");
  assert.equal(factory({ fetchImpl: deny }).id, PROVIDER);
});

test("auth precedence is stored, primary env, alias env; ordinary API keys do not configure this channel", async () => {
  const provider = await loadedProvider();
  const auth = provider.auth.apiKey;
  assert.ok(auth?.check);
  const signal = new AbortController().signal;
  const both = { ARK_AGENT_PLAN_API_KEY: "synthetic-primary", VOLCENGINE_ARK_PLAN_API_KEY: "synthetic-alias", OPENAI_API_KEY: OTHER_KEY, ARK_API_KEY: OTHER_KEY };
  for (const [stored, env, expected] of [
    [credential(), both, KEY],
    [undefined, both, "synthetic-primary"],
    [undefined, { VOLCENGINE_ARK_PLAN_API_KEY: "synthetic-alias" }, "synthetic-alias"],
    [undefined, { OPENAI_API_KEY: OTHER_KEY, ARK_API_KEY: OTHER_KEY }, undefined],
  ] as const) {
    const input = { ctx: context(env), credential: stored, signal };
    const check: AuthCheck | undefined = await auth.check(input);
    const resolved = await auth.resolve(input);
    assert.equal(Boolean(check), expected !== undefined);
    assert.equal(resolved?.auth.apiKey, expected);
  }
});

test("tier boundary uses stored tier before environment and medium when absent", async () => {
  const provider = await loadedProvider();
  for (const [stored, ambient, count] of [
    ["small", "max", 11], ["medium", "small", 12], ["large", "small", 12],
    ["max", "small", 12], [undefined, "small", 11], [undefined, undefined, 12],
  ] as const) {
    if (ambient) process.env.ARK_AGENT_PLAN_TIER = ambient;
    else delete process.env.ARK_AGENT_PLAN_TIER;
    const models = await runtime(stored);
    models.registerNativeProvider(provider);
    const available = await models.getAvailable(PROVIDER);
    assert.equal(available.length, count, `stored=${stored}, ambient=${ambient}`);
    assert.equal(available.some((m) => m.id === "kimi-k3"), count === 12);
    for (const model of available) {
      assert.equal(model.provider, PROVIDER);
      assert.equal(model.baseUrl, BASE);
      assert.equal(model.api, model.id === "kimi-k2.7-code" ? "openai-completions" : "openai-responses");
    }
  }
  delete process.env.ARK_AGENT_PLAN_TIER;
});

for (const id of ["deepseek-v4.1-flash", "kimi-k2.7-code"]) {
  test(`${id}: actual native SDK adapter success and replay`, async () => {
    const provider = await loadedProvider();
    const model = modelOf(provider, id);
    const http = fixture(model);
    const models = await runtime();
    models.registerNativeProvider(provider);
    const first = await collect(models.streamSimple(model, { messages: [USER] }, { fetch: http.fetchImpl, maxRetries: 0, reasoning: "high" }));
    success(first);
    if (model.api === "openai-completions") {
      assert.ok(first.events.includes("thinking_delta"));
      const second = await collect(models.streamSimple(model, { messages: [USER, first.message, USER] }, { fetch: http.fetchImpl, maxRetries: 0, reasoning: "high" }));
      success(second);
      const replay = (http.requests[1].messages as Body[]).find((m) => m.role === "assistant");
      assert.equal(replay?.reasoning_content, "fixture thought");
      assert.equal(replay?.content, "fixture answer");
      http.verify(2);
    } else http.verify(1);
  });
  for (const mode of ["error", "cancel"] as const) {
    test(`${id}: ${mode} never emits success or changes channel`, { timeout: 5_000 }, async () => {
      const provider = await loadedProvider();
      const model = modelOf(provider, id);
      const http = fixture(model, mode);
      const models = await runtime();
      models.registerNativeProvider(provider);
      const controller = new AbortController();
      const pending = collect(models.streamSimple(model, { messages: [USER] }, {
        fetch: http.fetchImpl, signal: controller.signal, maxRetries: 0,
      }));
      if (mode === "cancel") {
        await http.started;
        controller.abort();
      }
      const result = await pending;
      assert.equal(result.message.stopReason, mode === "cancel" ? "aborted" : "error");
      assert.equal(result.message.provider, PROVIDER);
      assert.equal(result.events.at(-1), "error");
      assert.ok(!result.events.includes("done"));
      if (mode === "error") assert.match(result.message.errorMessage ?? "", /synthetic unavailable|503/);
      http.verify(1);
    });
  }
}

// Same model id under another provider catches id-only thinking rewrites.
async function sessionRequest(id: string, thinkingLevel: ModelThinkingLevel, other = false) {
  const native = await loadedProvider();
  const source = modelOf(native, id);
  const marker = { effort: "high", summary: "auto" };
  const include = ["reasoning.encrypted_content"];
  const model = { ...source,
    ...(other ? { provider: "n4-control", baseUrl: "https://n4-control.invalid/v1" } : {}) };
  const http = fixture(model, "success", other ? OTHER_KEY : KEY);
  const models = await runtime();
  const settingsManager = SettingsManager.inMemory({ retry: { enabled: false }, compaction: { enabled: false } });
  const before: Body[] = [];
  const after: Body[] = [];
  const factories: ExtensionFactory[] = [
    (pi) => { pi.on("before_provider_request", (event) => {
      const payload = { ...(event.payload as Body), reasoning: marker, include };
      before.push(structuredClone(payload));
      return payload;
    }); },
    product.default,
    (pi) => { pi.on("before_provider_request", (event) => { after.push(structuredClone(event.payload as Body)); }); },
  ];
  if (other) factories.push((pi) => pi.registerProvider(createProvider({
    id: model.provider, models: [model], auth: { apiKey: { name: "synthetic", resolve: async () => ({ auth: { apiKey: OTHER_KEY } }) } },
    api: { "openai-responses": openAIResponsesApi(), "openai-completions": openAICompletionsApi() },
  })));
  const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager,
    noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
    extensionFactories: factories, systemPrompt: "Offline contract only." });
  await loader.reload();
  assert.deepEqual(loader.getExtensions().errors, []);
  globalThis.fetch = http.fetchImpl;
  const { session } = await createAgentSession({ cwd: root, agentDir: root, modelRuntime: models,
    model, thinkingLevel, resourceLoader: loader, settingsManager, sessionManager: SessionManager.inMemory(root), tools: [] });
  try {
    await session.bindExtensions({});
    assert.ok(models.getRegisteredNativeProvider(PROVIDER), "default export must register a native provider");
    await session.prompt("offline contract");
    const answer = session.messages.findLast((message): message is AssistantMessage => message.role === "assistant");
    assert.equal(answer?.stopReason, "stop", answer?.errorMessage);
    http.verify(1);
    assert.equal(before.length, 1);
    assert.equal(after.length, 1);
    assert.deepEqual(http.requests[0].reasoning, marker);
    assert.deepEqual(http.requests[0].include, include);
    if (other) assert.deepEqual(after[0], before[0], "other provider must not be rewritten");
    else assert.deepEqual(http.requests[0].thinking, { type: thinkingLevel === "off" ? "disabled" : "enabled" });
  } finally {
    session.dispose();
    globalThis.fetch = deny;
  }
}
for (const id of ["deepseek-v4.1-flash", "doubao-seed-2.1-turbo"]) {
  for (const level of ["off", "high"] as const) {
    test(`${id}: native extension thinking ${level} preserves reasoning/include`, () => sessionRequest(id, level));
  }
}
test("other-provider negative control: same model id is not rewritten", () => sessionRequest("deepseek-v4.1-flash", "off", true));

for (const api of ["openai-responses", "openai-completions"] as const) {
  test(`fixture control: public ${api} adapter accepts offline protocol`, async () => {
    const model: Model<typeof api> = { id: "fixture-control", name: "Fixture control", provider: "n4-control",
      api, baseUrl: "https://n4-control.invalid/v1", input: ["text"], reasoning: false,
      contextWindow: 4096, maxTokens: 64, cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 } };
    const models = await runtime();
    models.registerNativeProvider(createProvider({ id: model.provider, models: [model],
      auth: { apiKey: { name: "synthetic", resolve: async () => ({ auth: { apiKey: OTHER_KEY } }) } },
      api: api === "openai-responses" ? openAIResponsesApi() : openAICompletionsApi() }));
    const http = fixture(model, "success", OTHER_KEY);
    const result = await collect(models.streamSimple(model, { messages: [USER] }, { fetch: http.fetchImpl, maxRetries: 0 }));
    success(result, model.provider);
    // Fixed synthetic reference rates exercise SDK arithmetic, not subscription billing.
    assert.ok(Math.abs(result.message.usage.cost.total - 0.000014) < 1e-15);
    http.verify(1);
  });
}
