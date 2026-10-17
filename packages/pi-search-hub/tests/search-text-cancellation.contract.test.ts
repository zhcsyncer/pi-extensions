import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { beforeAll, describe, expect, it } from "vitest";
import type { TSchema } from "typebox";
import type { JsonObject } from "@earendil-works/pi-ai";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

// Independent N2 consumer tests: only the HTTP wire and model are synthetic.
// Each fixture gets a fresh process: the frozen module-global config is not a
// cross-session isolation contract. Never import product helpers or producer tests.
const entry = fileURLToPath(new URL("../extensions/search-hub.ts", import.meta.url));
const executeFile = promisify(execFile);
const endpoints = {
  exaSearch: "https://api.exa.ai/search",
  fireSearch: "https://api.firecrawl.dev/v2/search",
  exaRead: "https://api.exa.ai/contents",
  fireRead: "https://api.firecrawl.dev/v2/scrape",
};
const query = "offline N2 fixture";
const url = "https://fixture.example/article";
const longSnippet = "normalized snippet 🧪 ".repeat(40);
// The UTF-16 prefix intentionally ends inside a surrogate pair: do not silently
// turn the existing code-unit contract into a different Unicode clipping policy.
const longBody = "x".repeat(9_999) + "🧪" + "reader tail ".repeat(100);
const exaHit = (title: string, address: string, text: string) => ({ title, url: address, text, highlights: [] });
const fireHit = (title: string, address: string, description: string) => ({ title, url: address, description });

type Wire = { method?: "GET" | "POST"; body?: unknown; status?: number; abort?: boolean };
type Call = { name: string; args: JsonObject };
type Scenario = {
  enabled?: ("exa" | "firecrawl")[];
  calls: Call[];
  wire: Record<string, Wire>;
  codemode?: boolean;
  preAborted?: boolean;
};
type Result = {
  toolName: string;
  parentToolCallId?: string;
  isError: boolean;
  content: { type: string; text?: string }[];
  structuredContent?: unknown;
  details?: unknown;
};
type Observation = {
  tools: Record<string, {
    outputSchema?: TSchema;
    parameters: TSchema;
    exposure?: ToolDefinition["exposure"];
    executionMode?: ToolDefinition["executionMode"];
    renderCall: boolean;
    renderResult: boolean;
  }>;
  active: string[];
  results: Result[];
  ended: { toolName: string; isError: boolean }[];
  requests: { url: string; method: string; body: unknown }[];
  unknown: string[];
  abortObserved: boolean;
  shutdownObserved: boolean;
};
type ChildInput = Scenario & { entry: string; sdk: string; ai: string; fs: string; os: string; path: string };

// Serialized into a native Node child, so the real SDK loader (including its
// wrapper/registry) executes outside Vitest's module mocking machinery.
async function runChild(input: ChildInput): Promise<Observation> {
  // Keep native imports out of Vite's SSR transform when serializing this function.
  const nativeImport = new Function("specifier", "return import(specifier)") as (specifier: string) => Promise<unknown>;
  const fs = await nativeImport(input.fs) as typeof import("node:fs/promises");
  const os = await nativeImport(input.os) as typeof import("node:os");
  const path = await nativeImport(input.path) as typeof import("node:path");
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "n2-consumer-"));
  const previousCwd = process.cwd();
  let session: import("@earendil-works/pi-coding-agent").AgentSession | undefined;
  const originalFetch = globalThis.fetch;
  try {
    const agentDir = path.join(root, "agent");
    const configDir = path.join(agentDir, "extension-data", "pi-search-hub");
    await fs.mkdir(configDir, { recursive: true });
    process.env.HOME = root;
    process.env.PI_CODING_AGENT_DIR = agentDir;
    process.env.XDG_CONFIG_HOME = path.join(root, "config");
    process.env.XDG_CACHE_HOME = path.join(root, "cache");
    process.env.XDG_DATA_HOME = path.join(root, "data");
    process.env.XDG_STATE_HOME = path.join(root, "state");
    process.chdir(root);
    const enabled = input.enabled ?? ["exa", "firecrawl"];
    await fs.writeFile(path.join(configDir, "config.json"), JSON.stringify({
      routing: "priority",
      priority: ["exa", "firecrawl"],
      backends: Object.fromEntries(["exa", "firecrawl", "tavily", "parallel", "openai-codex", "xai"].map(name => [name, {
        enabled: enabled.includes(name as "exa" | "firecrawl"),
        ...(enabled.includes(name as "exa" | "firecrawl") ? { apiKeys: [`fixture-${name}-key`] } : {}),
      }])),
    }));
    const observation: Observation = {
      tools: {}, active: [], results: [], ended: [], requests: [], unknown: [], abortObserved: false, shutdownObserved: false,
    };
    let requestStarted!: () => void;
    const started = new Promise<void>(resolve => { requestStarted = resolve; });
    globalThis.fetch = async (resource, init) => {
      const request = new Request(resource, init);
      const body = await request.text();
      observation.requests.push({ url: request.url, method: request.method, body: body ? JSON.parse(body) : undefined });
      const wire = input.wire[request.url];
      if (!wire || request.method !== (wire.method ?? "POST")) {
        observation.unknown.push(`${request.method} ${request.url}`);
        throw new Error(`Blocked unregistered offline HTTP fixture: ${request.method} ${request.url}`);
      }
      if (wire.abort) {
        requestStarted();
        return await new Promise<Response>((_resolve, reject) => {
          const cancel = () => {
            observation.abortObserved = true;
            reject(new DOMException("Fixture request aborted", "AbortError"));
          };
          if (request.signal.aborted) cancel();
          else request.signal.addEventListener("abort", cancel, { once: true });
        });
      }
      return new Response(JSON.stringify(wire.body), {
        status: wire.status ?? 200,
        headers: { "content-type": "application/json" },
      });
    };
    const sdk = await nativeImport(input.sdk) as typeof import("@earendil-works/pi-coding-agent");
    const ai = await nativeImport(input.ai) as typeof import("@earendil-works/pi-ai");
    const faux = ai.fauxProvider();
    const modelRuntime = await sdk.ModelRuntime.create({
      authPath: path.join(agentDir, "auth.json"), modelsPath: null,
      modelsStorePath: path.join(agentDir, "models-cache.json"),
      refreshOnCreate: false, allowModelNetwork: false,
    });
    modelRuntime.registerNativeProvider(faux.provider);
    const settingsManager = sdk.SettingsManager.inMemory({
      compaction: { enabled: false }, retry: { enabled: false },
    });
    const definitions = new Map<string, ToolDefinition>();
    const loader = new sdk.DefaultResourceLoader({
      cwd: root, agentDir, settingsManager,
      additionalExtensionPaths: [input.entry],
      noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
      extensionFactories: [
        ...(input.codemode ? [sdk.createCodemodeExtension({ mode: "on" })] : []),
        pi => {
          pi.on("session_shutdown", () => { observation.shutdownObserved = true; });
          if (input.preAborted) {
            // Invoke the actual loaded definition with an already-aborted signal.
            // Going through executeTool here could test only the SDK's early guard.
            pi.registerTool({
              name: "n2_preaborted", label: "Pre-aborted contract call", description: "Offline cancellation entry fixture",
              parameters: { type: "object", properties: {} } as TSchema,
              async execute(id, _args, _signal, update, ctx) {
                const controller = new AbortController();
                controller.abort();
                const call = input.calls[0]!;
                return await definitions.get(call.name)!.execute(id, call.args, controller.signal, update, ctx);
              },
            });
          }
          // Read-only SDK observation, not a replacement registry/tool/formatter.
          pi.on("tool_result", event => {
            observation.results.push(JSON.parse(JSON.stringify(event)) as Result);
          });
        },
      ],
    });
    await loader.reload();
    const loaded = loader.getExtensions();
    if (loaded.errors.length) throw new Error(`Fixture loader failure: ${JSON.stringify(loaded.errors)}`);
    for (const extension of loaded.extensions) {
      for (const [name, { definition }] of extension.tools) {
        if (name !== "web_search" && name !== "web_read") continue;
        definitions.set(name, definition);
        observation.tools[name] = {
          outputSchema: definition.outputSchema, parameters: definition.parameters,
          exposure: definition.exposure, executionMode: definition.executionMode,
          renderCall: typeof definition.renderCall === "function",
          renderResult: typeof definition.renderResult === "function",
        };
      }
    }
    ({ session } = await sdk.createAgentSession({
      cwd: root, agentDir, resourceLoader: loader, modelRuntime, model: faux.getModel(),
      thinkingLevel: "off", noTools: "builtin", settingsManager,
      sessionManager: sdk.SessionManager.inMemory(root),
    }));
    await session.bindExtensions({});
    if (input.codemode) session.setActiveToolsByName([...session.getActiveToolNames(), "codemode"]);
    observation.active = session.getActiveToolNames();
    session.subscribe(event => {
      if (event.type === "tool_execution_end") {
        observation.ended.push({ toolName: event.toolName, isError: event.isError });
      }
    });
    for (const [index, call] of input.calls.entries()) {
      faux.setResponses([
        ai.fauxAssistantMessage(ai.fauxToolCall(input.preAborted ? "n2_preaborted" : call.name, input.preAborted ? {} : call.args, { id: `n2-${index}` }), { stopReason: "toolUse" }),
        ai.fauxAssistantMessage("Offline fixture complete."),
      ]);
      const prompt = session.prompt("Execute the scripted offline contract call.");
      if (Object.values(input.wire).some(wire => wire.abort)) {
        // Abort only after transport entry, not while the faux model is emitting.
        await started;
        await session.abort();
      }
      await prompt;
    }
    return observation;
  } finally {
    try {
      if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
    } finally {
      session?.dispose();
      globalThis.fetch = originalFetch;
      process.chdir(previousCwd);
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

async function observe(scenario: Scenario): Promise<Observation> {
  const input: ChildInput = {
    ...scenario,
    wire: {
      // Public coordinator fixture: retain existing quota reads without testing
      // their implementation or treating them as search/scrape side effects.
      "https://api.firecrawl.dev/v2/team/credit-usage": {
        method: "GET", status: 200,
        body: { success: true, data: { remainingCredits: 1000, planCredits: 1000 } },
      },
      ...scenario.wire,
    },
    entry, sdk: import.meta.resolve("@earendil-works/pi-coding-agent"),
    ai: import.meta.resolve("@earendil-works/pi-ai"), fs: "node:fs/promises", os: "node:os", path: "node:path",
  };
  const { stdout } = await executeFile(process.execPath, ["--eval",
    `(${runChild.toString()})(${JSON.stringify(input)}).then(value => console.log('N2_RESULT:' + JSON.stringify(value))).catch(error => { console.error(error); process.exitCode = 1; });`,
  ], {
    timeout: 30_000, maxBuffer: 2 * 1024 * 1024,
    // No inherited account/model/provider credentials, profile or user config.
    env: Object.fromEntries(["PATH", "HOME", "TMPDIR", "LANG", "TERM"].flatMap(key => process.env[key] ? [[key, process.env[key]!]] : [])),
  });
  const line = stdout.split("\n").find(value => value.startsWith("N2_RESULT:"));
  if (!line) throw new Error(`Fixture child returned no observation: ${stdout}`);
  const result = JSON.parse(line.slice("N2_RESULT:".length)) as Observation;
  expect(result.shutdownObserved, "Real session_shutdown must complete before disposal").toBe(true);
  expect(result.unknown, "No unregistered HTTP traffic is permitted").toEqual([]);
  expect(Object.keys(result.tools).sort(), "Both real tool registrations must load").toEqual(["web_read", "web_search"]);
  return result;
}

function final(observation: Observation, name: string, index = 0): Result {
  const result = observation.results.filter(result => result.toolName === name)[index];
  expect(result, "The real SDK pipeline must emit a final tool_result").toBeDefined();
  return result!;
}
function text(result: Result): string {
  return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
}
function expectTextContract(observation: Observation, name: string, index = 0): void {
  const result = final(observation, name, index);
  expect(result.isError).toBe(false);
  expect(observation.tools[name]!.outputSchema, "Withdrawn object-output policy must not remain registered").toBeUndefined();
  expect(result.structuredContent, "Existing consumers receive text, not a parallel object result").toBeUndefined();
  expect(text(result).length).toBeGreaterThan(0);
  expect(JSON.stringify(result)).not.toContain("fixture-exa-key");
  expect(JSON.stringify(result)).not.toContain("fixture-firecrawl-key");
}

const searchCases = [
  {
    label: "direct", backend: "exa", enabled: ["exa"] as ("exa" | "firecrawl")[],
    wire: { [endpoints.exaSearch]: { body: { results: [exaHit("First", url, longSnippet), exaHit("Second", `${url}/2`, "second snippet")] } } },
    titles: ["First", "Second"], urls: [url, `${url}/2`],
  },
  {
    label: "fallback", backend: "firecrawl",
    wire: {
      [endpoints.exaSearch]: { status: 400, body: { error: "fixture exa unavailable" } },
      [endpoints.fireSearch]: { body: { data: { web: [fireHit("Fallback", url, "fallback snippet")] } } },
    },
    titles: ["Fallback"], urls: [url],
  },
  {
    // Shared result wins RRF despite being second in Exa. No score tie is asserted.
    label: "combined RRF", backend: "combined-targeted", combine: true,
    wire: {
      [endpoints.exaSearch]: { body: { results: [exaHit("Exa unique", `${url}/exa`, "exa snippet"), exaHit("Shared", url, "shared snippet")] } },
      [endpoints.fireSearch]: { body: { data: { web: [fireHit("Shared", url, "shared snippet"), fireHit("Fire unique", `${url}/fire`, "fire snippet")] } } },
    },
    titles: ["Shared", "Exa unique", "Fire unique"], urls: [url, `${url}/exa`, `${url}/fire`],
  },
  {
    label: "combined partial failure", backend: "combined-targeted", combine: true,
    wire: {
      [endpoints.exaSearch]: { status: 400, body: { error: "fixture exa unavailable" } },
      [endpoints.fireSearch]: { body: { data: { web: [fireHit("Survivor", url, "surviving snippet")] } } },
    },
    titles: ["Survivor"], urls: [url],
  },
  {
    label: "single zero results", backend: "exa", enabled: ["exa"] as ("exa" | "firecrawl")[],
    wire: { [endpoints.exaSearch]: { body: { results: [] } } }, titles: [], urls: [],
  },
];

for (const fixture of searchCases) {
  describe(`web_search ${fixture.label}`, () => {
    let observation: Observation;
    beforeAll(async () => {
      observation = await observe({ enabled: fixture.enabled, wire: fixture.wire,
        calls: [{ name: "web_search", args: { query, numResults: 5, ...(fixture.combine ? { combine: true } : {}) } }],
      });
    }, 40_000);
    it("preserves direct availability, renderers and model text", () => {
      expect(observation.active).toEqual(expect.arrayContaining(["web_search", "web_read"]));
      expect(observation.active).not.toContain("codemode");
      const tool = observation.tools.web_search!;
      expect(tool.exposure ?? "direct").toBe("direct");
      expect(tool.executionMode).not.toBe("sequential");
      expect((tool.parameters as { required?: string[] }).required ?? []).not.toContain("displaySummary");
      expect(tool.renderCall && tool.renderResult).toBe(true);
      const result = final(observation, "web_search");
      expect(result.isError).toBe(false);
      expect(result.details).toBeDefined();
      expect(text(result).length).toBeGreaterThan(0);
      for (const title of fixture.titles) expect(text(result)).toContain(title);
      for (const address of fixture.urls) expect(text(result)).toContain(address);
    });
    it("preserves ranked, deduplicated text and source diagnostics", () => {
      const result = final(observation, "web_search");
      const output = text(result);
      expect(result.details).toMatchObject({ backend: fixture.label === "fallback" ? "firecrawl (fallback)" : fixture.backend });
      // URLs share prefixes, so compare whole URL tokens rather than substring counts.
      const addresses = output.match(/https:\/\/fixture\.example[^\s)\]>"}]*/g) ?? [];
      expect(addresses).toEqual(fixture.urls);
      const titlePositions = fixture.titles.map(title => output.indexOf(title));
      expect(titlePositions.every(position => position >= 0)).toBe(true);
      expect(titlePositions).toEqual([...titlePositions].sort((a, b) => a - b));
      if (fixture.label === "direct") {
        expect(output).toContain(longSnippet.slice(0, 500));
        expect(output).not.toContain(longSnippet);
      }
      if (fixture.combine) expect(output).toMatch(/firecrawl/i);
      if (fixture.label === "combined RRF" || fixture.label === "combined partial failure") {
        expect(JSON.stringify(result)).toMatch(/exa/i);
      }
      expect(output).not.toMatch(/"highlights"|"statuses"/);
      const businessRequests = observation.requests.filter(request => Object.values(endpoints).includes(request.url));
      expect(businessRequests.map(request => request.url)).toEqual(
        fixture.enabled ? [endpoints.exaSearch] : [endpoints.exaSearch, endpoints.fireSearch],
      );
    });
    it("keeps the restored text-only return policy", () => {
      expectTextContract(observation, "web_search");
    });
  });
}

it("compact preserves title and URL while omitting the verbose snippet", async () => {
  const observation = await observe({ enabled: ["exa"],
    wire: { [endpoints.exaSearch]: { body: { results: [exaHit("Compact title", url, "distinctive verbose snippet")] } } },
    calls: [false, true].map(compact => ({ name: "web_search", args: { query, compact } })),
  });
  const verbose = final(observation, "web_search", 0);
  const compact = final(observation, "web_search", 1);
  expect(text(verbose)).toContain("distinctive verbose snippet");
  expect(text(compact)).not.toContain("distinctive verbose snippet");
  expect(text(compact)).toContain("Compact title");
  expect(text(compact)).toContain(url);
  expect(verbose.isError).toBe(false);
  expect(compact.isError).toBe(false);
  expect(compact.details).toEqual(verbose.details);
}, 40_000);

it.each(["empty", "failed"] as const)("combine with every backend %s is a real SDK failure, not successful []", async kind => {
  const observation = await observe({ calls: [{ name: "web_search", args: { query, combine: true } }],
    wire: kind === "empty" ? {
      [endpoints.exaSearch]: { body: { results: [] } },
      [endpoints.fireSearch]: { body: { data: { web: [] } } },
    } : {
      [endpoints.exaSearch]: { status: 400, body: { error: "fixture exa unavailable" } },
      [endpoints.fireSearch]: { status: 400, body: { error: "fixture firecrawl unavailable" } },
    },
  });
  const result = final(observation, "web_search");
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toBeUndefined();
  expect(observation.ended).toContainEqual({ toolName: "web_search", isError: true });
}, 40_000);

for (const fixture of [
  { label: "normal", request: url, reader: "firecrawl", body: "short reader body", fallback: false },
  { label: "bare domain", request: "fixture.example", reader: "firecrawl", body: "bare domain body", fallback: false },
  { label: "fallback", request: url, reader: "exa", body: "fallback reader body", fallback: true },
  { label: "body cap", request: url, reader: "firecrawl", body: longBody, fallback: false },
]) {
  describe(`web_read ${fixture.label}`, () => {
    let observation: Observation;
    const normalizedUrl = fixture.request.startsWith("https://") ? fixture.request : `https://${fixture.request}`;
    beforeAll(async () => {
      observation = await observe({ calls: [{ name: "web_read", args: { url: fixture.request } }], wire: {
        [endpoints.fireRead]: fixture.fallback ? { status: 400, body: { error: "fixture reader unavailable" } } :
          { body: { data: { markdown: fixture.body, metadata: { title: "Fixture title", sourceURL: normalizedUrl } } } },
        [endpoints.exaRead]: { body: { results: [{ title: "Fixture title", url: normalizedUrl, text: fixture.body }], statuses: [] } },
      } });
    }, 40_000);
    it("keeps existing model-facing body and truncation experience", () => {
      const result = final(observation, "web_read");
      expect(result.isError).toBe(false);
      expect(result.details).toBeDefined();
      expect(observation.tools.web_read!.renderCall && observation.tools.web_read!.renderResult).toBe(true);
      expect(text(result)).toContain(fixture.body.slice(0, 10_000));
      if (fixture.body.length > 10_000) {
        expect(text(result)).not.toContain(fixture.body);
        expect(text(result)).toMatch(/truncat/i);
      }
    });
    it("returns the actual URL, selected reader, original UTF-16 length and capped prefix", () => {
      const result = final(observation, "web_read");
      expect(result.details).toMatchObject({ url: normalizedUrl, reader: fixture.reader,
        length: fixture.body.length, truncated: fixture.body.length > 10_000,
      });
      const requests = observation.requests.filter(request => [endpoints.fireRead, endpoints.exaRead].includes(request.url));
      expect(requests.map(request => request.url)).toEqual(fixture.fallback ? [endpoints.fireRead, endpoints.exaRead] : [endpoints.fireRead]);
      for (const request of requests) expect(JSON.stringify(request.body)).toContain(normalizedUrl);
    });
    it("keeps the restored text-only return policy", () => {
      expectTextContract(observation, "web_read");
    });
  });
}

it.each(["web_search", "web_read"] as const)("%s already cancelled at entry makes no business request", async name => {
  const observation = await observe({ preAborted: true,
    calls: [{ name, args: name === "web_search" ? { query } : { url } }], wire: {
      [endpoints.exaSearch]: { body: { results: [exaHit("Must not run", url, "forbidden")] } },
      [endpoints.fireSearch]: { body: { data: { web: [fireHit("Must not run", url, "forbidden")] } } },
      [endpoints.fireRead]: { body: { data: { markdown: "forbidden", metadata: { sourceURL: url } } } },
      [endpoints.exaRead]: { body: { results: [{ title: "Must not run", url, text: "forbidden" }], statuses: [] } },
    },
  });
  expect(observation.requests.filter(request => Object.values(endpoints).includes(request.url))).toEqual([]);
  expect(final(observation, "n2_preaborted").isError).toBe(true);
}, 40_000);

it.each(["web_search", "web_read"] as const)("%s cancellation remains a failure and never starts the next provider", async name => {
  const first = name === "web_search" ? endpoints.exaSearch : endpoints.fireRead;
  const fallback = name === "web_search" ? endpoints.fireSearch : endpoints.exaRead;
  const observation = await observe({ calls: [{ name, args: name === "web_search" ? { query } : { url } }], wire: {
    [first]: { abort: true },
    // A valid next provider makes an accidental post-abort fallback observable.
    [fallback]: { body: name === "web_search" ? { data: { web: [fireHit("Must not run", url, "forbidden")] } } :
      { results: [{ title: "Must not run", url, text: "forbidden" }], statuses: [] } },
  } });
  expect(observation.abortObserved, "AbortSignal must reach HTTP transport").toBe(true);
  const businessRequests = observation.requests.filter(request => Object.values(endpoints).includes(request.url));
  expect(businessRequests.map(request => request.url)).toEqual([first]);
  expect(observation.ended).toContainEqual({ toolName: name, isError: true });
  expect(observation.results.filter(result => result.toolName === name && !result.isError)).toEqual([]);
}, 40_000);

it("combine cancellation cannot turn an available sibling result into final success", async () => {
  const observation = await observe({ calls: [{ name: "web_search", args: { query, combine: true } }], wire: {
    [endpoints.exaSearch]: { abort: true },
    [endpoints.fireSearch]: { body: { data: { web: [fireHit("Available sibling", url, "not a final success after cancellation")] } } },
  } });
  expect(observation.abortObserved).toBe(true);
  const business = observation.requests.filter(request => Object.values(endpoints).includes(request.url));
  expect(business.map(request => request.url)).toContain(endpoints.exaSearch);
  // Already-started siblings are allowed; no retries or later requests are.
  expect(new Set(business.map(request => request.url)).size).toBe(business.length);
  expect(business.every(request => [endpoints.exaSearch, endpoints.fireSearch].includes(request.url))).toBe(true);
  expect(observation.ended).toContainEqual({ toolName: "web_search", isError: true });
  expect(observation.results.filter(result => result.toolName === "web_search" && !result.isError)).toEqual([]);
}, 40_000);

it("native optional codemode receives strings and can process the original search/read text", async () => {
  const observation = await observe({ codemode: true, calls: [{ name: "codemode", args: { code: `
    const search = await tools.web_search({query: ${JSON.stringify(query)}});
    const page = await tools.web_read({url: ${JSON.stringify(url)}});
    if (typeof search !== "string" || typeof page !== "string") throw new Error("Search Hub must preserve string returns");
    text(JSON.stringify({searchType: typeof search, pageType: typeof page,
      foundTitle: search.split("\\n").some(line => line.includes("Script hit")),
      foundUrl: search.includes(${JSON.stringify(url)}),
      foundBody: page.includes("script body"), processedBody: page.toUpperCase().includes("SCRIPT BODY")}));
  ` } }], wire: {
    [endpoints.exaSearch]: { body: { results: [exaHit("Script hit", url, "script snippet")] } },
    [endpoints.fireRead]: { body: { data: { markdown: "script body", metadata: { sourceURL: url } } } },
  } });
  const result = final(observation, "codemode");
  expect(result.isError, text(result)).toBe(false);
  const output = text(result);
  expect(output).toContain("Script completed");
  // Match the script's projection, not an echo of input or a formatter-produced string.
  const projection = output.split("\n").find(line => line.trim().startsWith('{"searchType"'));
  expect(projection, output).toBeDefined();
  expect(JSON.parse(projection!)).toEqual({ searchType: "string", pageType: "string",
    foundTitle: true, foundUrl: true, foundBody: true, processedBody: true,
  });
  expect(final(observation, "web_search").parentToolCallId).toBeDefined();
  expect(final(observation, "web_read").parentToolCallId).toBeDefined();
  expectTextContract(observation, "web_search");
  expectTextContract(observation, "web_read");
}, 40_000);
