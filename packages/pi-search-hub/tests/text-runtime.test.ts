import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type JsonObject, type ToolResultMessage } from "@earendil-works/pi-ai";
import {
	createAgentSession, createCodemodeExtension, DefaultResourceLoader,
	ModelRuntime, SessionManager, SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";

// Only the HTTP boundary is replaced; loader, routing, normalization, and nested
// codemode execution are real SDK/product code. Unknown URLs never reach the network.
describe("text results through SDK 1.2", { timeout: 30_000 }, () => {
	const faux = fauxProvider();
	const root = mkdtempSync(join(tmpdir(), "search-text-"));
	const agentDir = join(root, "agent");
	let session: AgentSession;
	let loader: DefaultResourceLoader;
	let body = "reader body";
	let failExa = false;
	let failRead = false;
	let empty = false;
	let pending = false;
	let entered: (() => void) | undefined;
	const requests: string[] = [];
	const unexpected: string[] = [];

	beforeAll(async () => {
		mkdirSync(join(agentDir, "extension-data/pi-search-hub"), { recursive: true });
		writeFileSync(join(agentDir, "extension-data/pi-search-hub/config.json"), JSON.stringify({
			routing: "priority", priority: ["exa", "firecrawl"],
			backends: {
				exa: { enabled: true, apiKeys: ["fixture-key"] }, firecrawl: { enabled: true },
				tavily: { enabled: false }, parallel: { enabled: false },
				"openai-codex": { enabled: false }, xai: { enabled: false },
			},
		}));
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		vi.stubEnv("PI_OFFLINE", "1");
		vi.stubEnv("PI_CURSOR_SYSTEM_CREDENTIALS", "0");
		vi.stubGlobal("fetch", async (input: string | URL | Request, init?: RequestInit) => {
			const url = String(input);
			requests.push(url);
			const known = ["https://api.exa.ai/search", "https://api.exa.ai/contents",
				"https://api.firecrawl.dev/v2/search", "https://api.firecrawl.dev/v2/scrape"];
			if (!known.includes(url)) {
				unexpected.push(url);
				throw new Error(`Unexpected offline URL: ${url}`);
			}
			if (pending) {
				entered?.();
				return new Promise<Response>((_resolve, reject) => {
					const abort = () => reject(init?.signal?.reason ?? new Error("aborted"));
					if (init?.signal?.aborted) abort();
					else init?.signal?.addEventListener("abort", abort, { once: true });
				});
			}
			if (url === "https://api.exa.ai/search") {
				if (failExa) return Response.json({ error: "fixture unavailable" }, { status: 503 });
				return Response.json({ results: empty ? [] : [{ title: "Exa", url: "https://example.com/page", text: "E".repeat(700), highlights: [] }] });
			}
			if (url.endsWith("/search")) return Response.json({ data: { web: empty ? [] : [
				{ title: "Firecrawl", url: "https://example.com/page/", description: "F".repeat(600) },
				{ title: "Unique", url: "https://example.com/unique", description: "unique" },
			] } });
			if (url.endsWith("/scrape")) {
				if (failRead) return Response.json({ error: "fixture unavailable" }, { status: 503 });
				return Response.json({ data: { markdown: body, metadata: { title: "Page" } } });
			}
			return Response.json({ results: [{ title: "Page", url: "https://example.com", text: body }], statuses: [] });
		});
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		loader = new DefaultResourceLoader({
			cwd: root, agentDir, settingsManager,
			additionalExtensionPaths: [resolve("extensions/search-hub.ts")],
			extensionFactories: [createCodemodeExtension({ mode: "on" })],
			noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		});
		await loader.reload();
		expect(loader.getExtensions().errors).toEqual([]);
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"), modelsPath: null, refreshOnCreate: false,
		});
		modelRuntime.registerNativeProvider(faux.provider);
		({ session } = await createAgentSession({
			cwd: root, agentDir, resourceLoader: loader, settingsManager,
			modelRuntime, model: faux.getModel(), thinkingLevel: "off",
			sessionManager: SessionManager.inMemory(root), noTools: "builtin",
		}));
		await session.bindExtensions({});
	}, 30_000);

	afterAll(async () => {
		try {
			if (session) await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		} finally {
			session?.dispose();
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			rmSync(root, { recursive: true, force: true });
			expect(unexpected).toEqual([]);
		}
	});

	async function call(name: string, args: JsonObject) {
		session.setActiveToolsByName(name === "codemode" ? ["web_search", "web_read", "codemode"] : [name]);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		let final: Pick<ToolResultMessage, "isError" | "content" | "details"> | undefined;
		const unsubscribe = session.subscribe((event) => {
			if (event.type === "tool_execution_end" && event.toolName === name && !event.parentToolCallId) {
				final = { ...event.result, isError: event.isError };
			}
		});
		try {
			await session.prompt("Run the fixture tool call.");
			if (!final) throw new Error("No final tool execution event");
			return final;
		} finally { unsubscribe(); }
	}

	function text(result: Pick<ToolResultMessage, "content">): string {
		return result.content.filter(block => block.type === "text").map(block => block.text).join("\n");
	}

	function checkRenderers(name: string) {
		const tool = loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.values()])
			.find((registered) => registered.definition.name === name)?.definition;
		expect(tool?.renderCall).toBeTypeOf("function");
		expect(tool?.renderResult).toBeTypeOf("function");
	}

	it("keeps normalized search data across compact, fallback, and RRF combine", async () => {
		const verbose = await call("web_search", { query: "fixture", numResults: 6 });
		const compact = await call("web_search", { query: "fixture", numResults: 6, compact: true });
		expect(verbose.isError, JSON.stringify(verbose.content)).toBe(false);
		checkRenderers("web_search");
		expect(verbose.details).toMatchObject({ backend: "exa", resultCount: 1 });
		expect(compact.details).toMatchObject({ backend: "exa", resultCount: 1 });
		expect(compact.content).not.toEqual(verbose.content);
		expect(text(verbose)).toContain('## Search Results: "fixture"');
		expect(text(verbose)).toContain("E".repeat(500));
		expect(text(verbose)).not.toContain("E".repeat(501));
		expect(text(compact)).toBe("1. Exa [exa] — https://example.com/page");
		failExa = true;
		const fallback = await call("web_search", { query: "fixture" });
		expect(fallback.isError).toBe(false);
		expect(fallback.details).toMatchObject({ backend: "firecrawl (fallback)", resultCount: 2, errors: [expect.stringContaining("exa:")] });
		expect(text(fallback)).toContain("exa:");
		expect(text(fallback)).toContain("Backend: firecrawl");
		try {
			const partial = await call("web_search", { query: "fixture", combine: true });
			expect(partial.isError).toBe(false);
			expect(partial.details).toMatchObject({ backend: "combined-targeted", resultCount: 2, usableBackendCount: 1,
				backendStats: { exa: { success: false }, firecrawl: { success: true, count: 2 } } });
			expect(text(partial)).toContain("Exa: failed");
			expect(text(partial)).toContain("Source: Firecrawl");
		} finally { failExa = false; }
		const combined = await call("web_search", { query: "fixture", numResults: 6, combine: true });
		expect(combined.isError).toBe(false);
		expect(combined.details).toMatchObject({ backend: "combined-targeted", resultCount: 2, usableBackendCount: 2 });
		expect(text(combined)).toContain("### 1. Exa\n   *Source: Exa*\n   URL: https://example.com/page");
		expect(text(combined)).toContain("### 2. Unique\n   *Source: Firecrawl*\n   URL: https://example.com/unique");
		expect(text(combined).match(/   URL:/g)).toHaveLength(2);
	});

	it("preserves empty direct success but reports unusable combine as error", async () => {
		empty = true;
		try {
			const direct = await call("web_search", { query: "empty" });
			expect(direct.isError).toBe(false);
			expect(direct.details).toMatchObject({ resultCount: 0 });
			expect(text(direct)).toContain("Results: 0");
			const combined = await call("web_search", { query: "empty", combine: true });
			expect(combined.isError).toBe(true);
			expect(text(combined)).toContain("Targeted combine found no usable backend results");
		} finally { empty = false; }
	});

	it("returns only the existing UTF-16 prefix, with actual reader and original length", async () => {
		body = "a".repeat(9_999) + "😀tail";
		const direct = await call("web_read", { url: "example.com" });
		checkRenderers("web_read");
		expect(direct.isError).toBe(false);
		expect(direct.details).toMatchObject({ url: "https://example.com", reader: "firecrawl", length: body.length, truncated: true });
		expect(direct.content).toEqual([{ type: "text", text: body.slice(0, 10_000) + `\n\n[... truncated, full length: ${body.length} chars]` }]);
		failRead = true;
		body = "short";
		try {
			const fallback = await call("web_read", { url: "example.com" });
			expect(fallback.isError).toBe(false);
			expect(text(fallback)).toBe("short");
			expect(fallback.details).toMatchObject({ reader: "exa", length: 5, truncated: false,
				fallbackErrors: [expect.stringContaining("firecrawl:")] });
		} finally { failRead = false; }
	});

	it("gives real codemode scripts the existing formatted strings", async () => {
		body = "script body";
		const result = await call("codemode", { code: `
			const search = await tools.web_search({query: "fixture", compact: true});
			const page = await tools.web_read({url: "example.com"});
			console.log(JSON.stringify({searchType: typeof search, pageType: typeof page,
				search, body: page}));
		` });
		expect(result.isError, JSON.stringify(result.content)).toBe(false);
		expect(JSON.stringify(result.content)).toContain('\\"searchType\\":\\"string\\"');
		expect(JSON.stringify(result.content)).toContain('\\"pageType\\":\\"string\\"');
		expect(JSON.stringify(result.content)).toContain("1. Exa [exa] — https://example.com/page");
		expect(JSON.stringify(result.content)).toContain('\\"body\\":\\"script body\\"');
	});

	it.each([false, true])("does not advance search fallback after cancellation (combine=%s)", async (combine) => {
		pending = true;
		requests.length = 0;
		const started = new Promise<void>((resolve) => { entered = resolve; });
		const running = call("web_search", { query: "abort", combine });
		await started;
		await session.abort();
		await running;
		pending = false;
		expect(requests).toHaveLength(combine ? 2 : 1);
		const results = session.messages.filter((message) => message.role === "toolResult");
		expect(results.at(-1)).toMatchObject({ isError: true });
		expect(results.at(-1)).not.toHaveProperty("structuredContent");
	});
});
