import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { fauxAssistantMessage, fauxProvider, fauxText, fauxToolCall, type JsonObject } from "@earendil-works/pi-ai";
import {
	createAgentSession, createCodemodeExtension, DefaultResourceLoader,
	ModelRuntime, SessionManager, SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";

// Only the HTTP boundary is replaced; loader, routing, normalization, and nested
// codemode execution are real SDK/product code. Unknown URLs never reach the network.
describe("structured results through SDK 1.1", { timeout: 30_000 }, () => {
	const faux = fauxProvider();
	const root = mkdtempSync(join(tmpdir(), "search-structured-"));
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

	afterAll(() => {
		session?.dispose();
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
		expect(unexpected).toEqual([]);
	});

	async function call(name: string, args: JsonObject) {
		session.setActiveToolsByName(name === "codemode" ? ["web_search", "web_read", "codemode"] : [name]);
		faux.setResponses([
			fauxAssistantMessage([fauxToolCall(name, args)], { stopReason: "toolUse" }),
			fauxAssistantMessage([fauxText("done")]),
		]);
		let final: { isError: boolean; content: unknown; details: unknown; structuredContent?: unknown } | undefined;
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

	function validate(name: string, data: unknown) {
		const tool = loader.getExtensions().extensions.flatMap((extension) => [...extension.tools.values()])
			.find((registered) => registered.definition.name === name)?.definition;
		expect(tool?.outputSchema).toBeDefined();
		expect(tool?.renderCall).toBeTypeOf("function");
		expect(tool?.renderResult).toBeTypeOf("function");
		expect(Value.Check(tool!.outputSchema!, data)).toBe(true);
	}

	it("keeps normalized search data across compact, fallback, and RRF combine", async () => {
		const verbose = await call("web_search", { query: "fixture", numResults: 6 });
		const compact = await call("web_search", { query: "fixture", numResults: 6, compact: true });
		expect(verbose.isError, JSON.stringify(verbose.content)).toBe(false);
		validate("web_search", verbose.structuredContent);
		expect(compact.structuredContent).toEqual(verbose.structuredContent);
		expect(compact.content).not.toEqual(verbose.content);
		expect(verbose.structuredContent).toMatchObject({ backend: "exa", resultCount: 1,
			results: [{ snippet: "E".repeat(500), backend: "exa" }] });
		failExa = true;
		const fallback = await call("web_search", { query: "fixture" });
		validate("web_search", fallback.structuredContent);
		expect(fallback.structuredContent).toMatchObject({ backend: "firecrawl", resultCount: 2, errors: [expect.stringContaining("exa:")] });
		expect(fallback.details).toMatchObject({ backend: "firecrawl (fallback)" });
		failExa = false;
		const combined = await call("web_search", { query: "fixture", numResults: 6, combine: true });
		validate("web_search", combined.structuredContent);
		expect(combined.structuredContent).toMatchObject({ backend: "combined-targeted", resultCount: 2, usableBackendCount: 2,
			results: [{ url: "https://example.com/page", backend: "exa" }, { url: "https://example.com/unique", backend: "firecrawl" }] });
	});

	it("preserves empty direct success but reports unusable combine as error", async () => {
		empty = true;
		try {
			const direct = await call("web_search", { query: "empty" });
			expect(direct.isError).toBe(false);
			expect(direct.structuredContent).toMatchObject({ resultCount: 0, results: [] });
			const combined = await call("web_search", { query: "empty", combine: true });
			expect(combined.isError).toBe(true);
			expect(combined.structuredContent).toBeUndefined();
		} finally { empty = false; }
	});

	it("returns only the existing UTF-16 prefix, with actual reader and original length", async () => {
		body = "a".repeat(9_999) + "😀tail";
		const direct = await call("web_read", { url: "example.com" });
		validate("web_read", direct.structuredContent);
		expect(direct.structuredContent).toMatchObject({ url: "https://example.com", reader: "firecrawl",
			content: body.slice(0, 10_000), length: body.length, truncated: true });
		expect(direct.content).toEqual([{ type: "text", text: body.slice(0, 10_000) + `\n\n[... truncated, full length: ${body.length} chars]` }]);
		failRead = true;
		body = "short";
		try {
			const fallback = await call("web_read", { url: "example.com" });
			validate("web_read", fallback.structuredContent);
			expect(fallback.structuredContent).toMatchObject({ reader: "exa", content: "short", length: 5, truncated: false,
				fallbackErrors: [expect.stringContaining("firecrawl:")] });
		} finally { failRead = false; }
	});

	it("gives real codemode scripts objects rather than formatted text", async () => {
		body = "script body";
		const result = await call("codemode", { code: `
			const search = await tools.web_search({query: "fixture", compact: true});
			const page = await tools.web_read({url: "example.com"});
			console.log(JSON.stringify({count: search.resultCount, source: search.results[0].backend,
				reader: page.reader, body: page.content, truncated: page.truncated}));
		` });
		expect(result.isError, JSON.stringify(result.content)).toBe(false);
		expect(JSON.stringify(result.content)).toContain('\\"count\\":1');
		expect(JSON.stringify(result.content)).toContain('\\"source\\":\\"exa\\"');
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
