import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { initTheme, type ExtensionAPI, type Theme, type ToolDefinition } from "@earendil-works/pi-coding-agent";
import { Markdown, Text, type Component } from "@earendil-works/pi-tui";
import extension from "../extensions/context7.ts";
import {
  clearContext7ConfigCache,
  getContext7ConfigPath,
  resolveContext7ApiKey,
} from "../lib/config.ts";
import {
  formatByteSize,
  measureText,
  textContent,
} from "../lib/result.ts";
import {
  queryDetailsFromResult,
  renderQueryCall,
  renderQueryResult,
  renderResolveCall,
  renderResolveResult,
  resolveDetailsFromResult,
} from "../lib/render.ts";

const theme = {
  fg: (_color: string, text: string) => text,
  bold: (text: string) => text,
} as unknown as Theme;

function plain(component: Component, width = 120): string {
  return component
    .render(width)
    .map((line) => line.replace(/\x1b\[[0-9;]*m/g, "").trimEnd())
    .join("\n")
    .replace(/\s+$/u, "");
}

function collectTools(): Map<string, ToolDefinition> {
  const tools = new Map<string, ToolDefinition>();
  const pi = {
    registerTool(def: ToolDefinition) {
      tools.set(def.name, def);
    },
  } as unknown as ExtensionAPI;
  extension(pi);
  return tools;
}

function mockJsonResponse(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

function mockTextResponse(status: number, body: string): Response {
  return new Response(body, {
    status,
    headers: { "Content-Type": "text/plain; charset=utf-8" },
  });
}

const extensionContext = {} as never;

describe("extension registration", () => {
  const tools = collectTools();

  it("registers resolve-library-id and query-docs", () => {
    expect([...tools.keys()].sort()).toEqual(["query-docs", "resolve-library-id"]);
  });

  function paramKeys(def: ToolDefinition): string[] {
    const schema = def.parameters as { properties: Record<string, unknown> };
    return Object.keys(schema.properties).sort();
  }

  it("resolve-library-id has query + libraryName params and long description", () => {
    const def = tools.get("resolve-library-id")!;
    expect(paramKeys(def)).toEqual(["libraryName", "query"]);
    expect(def.description).toContain("Context7");
    expect(def.description).toContain("Do not call this tool more than 3 times");
    expect(def.renderCall).toBeTypeOf("function");
    expect(def.renderResult).toBeTypeOf("function");
  });

  it("query-docs has libraryId + query params and long description", () => {
    const def = tools.get("query-docs")!;
    expect(paramKeys(def)).toEqual(["libraryId", "query"]);
    expect(def.description).toContain("Context7");
    expect(def.description).toContain("Do not call this tool more than 3 times");
    expect(def.renderCall).toBeTypeOf("function");
    expect(def.renderResult).toBeTypeOf("function");
  });
});

describe("formatByteSize", () => {
  it("uses binary units with one decimal place", () => {
    expect(formatByteSize(0)).toBe("0 B");
    expect(formatByteSize(512)).toBe("512 B");
    expect(formatByteSize(1023)).toBe("1023 B");
    expect(formatByteSize(1024)).toBe("1.0 KiB");
    expect(formatByteSize(1536)).toBe("1.5 KiB");
    expect(formatByteSize(18842)).toBe("18.4 KiB");
    expect(formatByteSize(1024 * 1024)).toBe("1.0 MiB");
    expect(formatByteSize(1024 * 1024 + 512 * 1024)).toBe("1.5 MiB");
  });

  it("does not label binary sizes as KB/MB", () => {
    expect(formatByteSize(18842)).not.toMatch(/\bKB\b|\bMB\b/);
    expect(formatByteSize(18842)).toMatch(/KiB/);
  });
});

describe("tool rendering", () => {
  beforeAll(() => {
    initTheme("dark", false);
  });

  const longDocs = [
    "# Next.js caching",
    "",
    "Use `unstable_cache` for data caching.",
    "",
    "```ts",
    "export const getCached = unstable_cache(async () => data);",
    "```",
    "",
    "Do not leak this full body into collapsed rows.",
  ].join("\n");

  const resolveBody = [
    "Available Libraries:",
    "",
    "- Title: Next.js",
    "- Context7-compatible library ID: /vercel/next.js",
    "- Description: The React Framework",
    "----------",
    "- Title: Next.js Docs",
    "- Context7-compatible library ID: /vercel/next.js/docs",
    "- Description: Documentation",
  ].join("\n");

  it("renderCall shows Context7 Resolve/Query with target identifiers", () => {
    expect(plain(renderResolveCall({ libraryName: "Next.js" }, theme))).toBe(
      "Context7 Resolve Next.js",
    );
    expect(plain(renderQueryCall({ libraryId: "/vercel/next.js" }, theme))).toBe(
      "Context7 Query /vercel/next.js",
    );
  });

  it("collapsed query result stays compact and does not leak full text", () => {
    const result = {
      content: [{ type: "text" as const, text: longDocs }],
      details: {
        kind: "query" as const,
        byteLength: 18842,
        lineCount: 236,
      },
    };
    const collapsed = plain(
      renderQueryResult(result, { expanded: false, isPartial: false }, theme, {
        isError: false,
      }),
    );
    expect(collapsed).toBe("✓ 18.4 KiB · 236 lines (Ctrl+O to expand)");
    expect(collapsed).not.toContain("unstable_cache");
    expect(collapsed).not.toContain("Do not leak this full body");
    expect(collapsed.split("\n")).toHaveLength(1);
  });

  it("expanded query result uses Markdown and shows the full content", () => {
    const result = {
      content: [{ type: "text" as const, text: longDocs }],
      details: {
        kind: "query" as const,
        byteLength: 10,
        lineCount: 2,
      },
    };
    const component = renderQueryResult(
      result,
      { expanded: true, isPartial: false },
      theme,
      { isError: false },
    );
    expect(component).toBeInstanceOf(Markdown);
    expect(component).not.toBeInstanceOf(Text);
    const expanded = plain(component);
    expect(expanded).toContain("Next.js caching");
    expect(expanded).toContain("unstable_cache");
    expect(expanded).toContain("Do not leak this full body into collapsed rows.");
  });

  it("collapsed resolve result shows candidate count and top library id", () => {
    const result = {
      content: [{ type: "text" as const, text: resolveBody }],
      details: {
        kind: "resolve" as const,
        candidateCount: 2,
        topLibraryId: "/vercel/next.js",
      },
    };
    const collapsed = plain(
      renderResolveResult(result, { expanded: false, isPartial: false }, theme, {
        isError: false,
      }),
    );
    expect(collapsed).toBe("✓ 2 candidates · top /vercel/next.js (Ctrl+O to expand)");
    expect(collapsed).not.toContain("The React Framework");
    expect(collapsed.split("\n")).toHaveLength(1);
  });

  it("expanded resolve result uses Markdown and shows the full candidate listing", () => {
    const result = {
      content: [{ type: "text" as const, text: resolveBody }],
      details: {
        kind: "resolve" as const,
        candidateCount: 2,
        topLibraryId: "/vercel/next.js",
      },
    };
    const component = renderResolveResult(
      result,
      { expanded: true, isPartial: false },
      theme,
      { isError: false },
    );
    expect(component).toBeInstanceOf(Markdown);
    expect(component).not.toBeInstanceOf(Text);
    const expanded = plain(component);
    expect(expanded).toContain("Available Libraries");
    expect(expanded).toContain("/vercel/next.js");
    expect(expanded).toContain("/vercel/next.js/docs");
    expect(expanded).toContain("The React Framework");
  });

  it("collapsed results stay single-line Text components", () => {
    const queryComponent = renderQueryResult(
      {
        content: [{ type: "text" as const, text: longDocs }],
        details: { kind: "query" as const, byteLength: 12, lineCount: 3 },
      },
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    );
    const resolveComponent = renderResolveResult(
      {
        content: [{ type: "text" as const, text: resolveBody }],
        details: {
          kind: "resolve" as const,
          candidateCount: 2,
          topLibraryId: "/vercel/next.js",
        },
      },
      { expanded: false, isPartial: false },
      theme,
      { isError: false },
    );
    expect(queryComponent).toBeInstanceOf(Text);
    expect(resolveComponent).toBeInstanceOf(Text);
    expect(plain(queryComponent).split("\n")).toHaveLength(1);
    expect(plain(resolveComponent).split("\n")).toHaveLength(1);
  });

  it("falls back when historical details are missing", () => {
    const resolveFallback = resolveDetailsFromResult({
      content: [{ type: "text", text: resolveBody }],
      details: undefined,
    });
    expect(resolveFallback).toEqual({
      kind: "resolve",
      candidateCount: 2,
      topLibraryId: "/vercel/next.js",
    });

    const queryFallback = queryDetailsFromResult({
      content: [{ type: "text", text: longDocs }],
      details: undefined,
    });
    expect(queryFallback).toEqual({
      kind: "query",
      ...measureText(longDocs),
    });
  });

  it("renders errors with error styling text", () => {
    const result = {
      content: [{ type: "text" as const, text: "Invalid API key. Please check your API key." }],
      details: undefined,
    };
    expect(
      plain(
        renderQueryResult(result, { expanded: false, isPartial: false }, theme, {
          isError: true,
        }),
      ),
    ).toBe("✗ Invalid API key. Please check your API key.");
    expect(
      plain(
        renderResolveResult(result, { expanded: false, isPartial: false }, theme, {
          isError: true,
        }),
      ),
    ).toBe("✗ Invalid API key. Please check your API key.");
  });
});

describe("config api key resolution", () => {
  const originalKey = process.env.CONTEXT7_API_KEY;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(path.join(tmpdir(), "pi-context7-config-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.CONTEXT7_API_KEY;
    clearContext7ConfigCache();
  });

  afterEach(() => {
    clearContext7ConfigCache();
    rmSync(agentDir, { recursive: true, force: true });
    if (originalKey === undefined) delete process.env.CONTEXT7_API_KEY;
    else process.env.CONTEXT7_API_KEY = originalKey;
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
  });

  function writeConfig(apiKey: string): void {
    const configPath = getContext7ConfigPath(agentDir);
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify({ apiKey }, null, 2)}\n`, "utf8");
    clearContext7ConfigCache();
  }

  it("reads apiKey from extension-data config.json", () => {
    writeConfig("ctx7sk_from_config");
    expect(resolveContext7ApiKey(agentDir)).toBe("ctx7sk_from_config");
  });

  it("falls back to CONTEXT7_API_KEY when config is absent", () => {
    process.env.CONTEXT7_API_KEY = "ctx7sk_from_env";
    expect(resolveContext7ApiKey(agentDir)).toBe("ctx7sk_from_env");
  });

  it("prefers config.json over CONTEXT7_API_KEY", () => {
    writeConfig("ctx7sk_from_config");
    process.env.CONTEXT7_API_KEY = "ctx7sk_from_env";
    expect(resolveContext7ApiKey(agentDir)).toBe("ctx7sk_from_config");
  });
});

describe("API execute behavior", () => {
  const tools = collectTools();
  const originalFetch = globalThis.fetch;
  const originalKey = process.env.CONTEXT7_API_KEY;
  const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
  let agentDir: string;

  beforeEach(() => {
    agentDir = mkdtempSync(path.join(tmpdir(), "pi-context7-api-"));
    process.env.PI_CODING_AGENT_DIR = agentDir;
    delete process.env.CONTEXT7_API_KEY;
    clearContext7ConfigCache();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    clearContext7ConfigCache();
    rmSync(agentDir, { recursive: true, force: true });
    if (originalKey === undefined) {
      delete process.env.CONTEXT7_API_KEY;
    } else {
      process.env.CONTEXT7_API_KEY = originalKey;
    }
    if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
    else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
    vi.restoreAllMocks();
  });

  function writeConfig(apiKey: string): void {
    const configPath = getContext7ConfigPath(agentDir);
    mkdirSync(path.dirname(configPath), { recursive: true });
    writeFileSync(configPath, `${JSON.stringify({ apiKey }, null, 2)}\n`, "utf8");
    clearContext7ConfigCache();
  }

  it("forwards AbortSignal and Authorization header from config.json", async () => {
    writeConfig("ctx7sk_test_key");
    const controller = new AbortController();
    const fetchMock = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBe("Bearer ctx7sk_test_key");
      const url = String(input);
      expect(url).toContain("/v2/libs/search");
      expect(url).toContain("libraryName=React");
      return mockJsonResponse(200, {
        results: [
          {
            id: "/facebook/react",
            title: "React",
            description: "A JavaScript library for building user interfaces",
            branch: "main",
            lastUpdateDate: "2026-01-01",
            state: "finalized",
            totalTokens: 1000,
            totalSnippets: 100,
            trustScore: 9,
            benchmarkScore: 90,
          },
        ],
      });
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const def = tools.get("resolve-library-id")!;
    const result = await def.execute(
      "call-1",
      { query: "hooks", libraryName: "React" },
      controller.signal,
      undefined,
      extensionContext,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(textContent(result)).toContain("/facebook/react");
    expect(result.details).toEqual({
      kind: "resolve",
      candidateCount: 1,
      topLibraryId: "/facebook/react",
    });
  });

  it("forwards AbortSignal and omits auth header when no API key is set for query-docs", async () => {
    const controller = new AbortController();
    const docs = "# Docs\n\nExample body";
    const fetchMock = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      expect(init?.signal).toBe(controller.signal);
      const headers = new Headers(init?.headers);
      expect(headers.get("Authorization")).toBeNull();
      return mockTextResponse(200, docs);
    });
    globalThis.fetch = fetchMock as typeof fetch;

    const def = tools.get("query-docs")!;
    const result = await def.execute(
      "call-2",
      { libraryId: "/vercel/next.js", query: "caching" },
      controller.signal,
      undefined,
      extensionContext,
    );

    expect(fetchMock).toHaveBeenCalledOnce();
    expect(textContent(result)).toBe(docs);
    expect(result.details).toEqual({
      kind: "query",
      ...measureText(docs),
    });
  });

  it("throws friendly upstream messages on HTTP non-2xx", async () => {
    writeConfig("ctx7sk_bad");
    globalThis.fetch = vi.fn(async () =>
      mockJsonResponse(401, { message: "Invalid API key from upstream." }),
    ) as typeof fetch;

    const def = tools.get("query-docs")!;
    await expect(
      def.execute(
        "call-3",
        { libraryId: "/vercel/next.js", query: "caching" },
        undefined,
        undefined,
        extensionContext,
      ),
    ).rejects.toThrow("Invalid API key from upstream.");
  });

  it("returns upstream empty-doc text on HTTP 200 with empty body", async () => {
    globalThis.fetch = vi.fn(async () => mockTextResponse(200, "")) as typeof fetch;
    const def = tools.get("query-docs")!;
    const result = await def.execute(
      "call-4",
      { libraryId: "/acme/missing", query: "anything" },
      undefined,
      undefined,
      extensionContext,
    );
    expect(textContent(result)).toContain("Documentation not found or not finalized");
    expect(result.details).toMatchObject({ kind: "query" });
  });

  it("propagates abort errors from fetch", async () => {
    const controller = new AbortController();
    controller.abort();
    globalThis.fetch = vi.fn(async (_input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      const signal = init?.signal;
      if (signal?.aborted) {
        throw new DOMException("The operation was aborted.", "AbortError");
      }
      return mockTextResponse(200, "ok");
    }) as typeof fetch;

    const def = tools.get("resolve-library-id")!;
    await expect(
      def.execute(
        "call-5",
        { query: "hooks", libraryName: "React" },
        controller.signal,
        undefined,
        extensionContext,
      ),
    ).rejects.toMatchObject({ name: "AbortError" });
  });
});
