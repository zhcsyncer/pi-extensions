/**
 * Integration tests for dispatch, config, and combine logic.
 *
 * These tests verify:
 * - Selection strategies
 * - RRF combiner
 * - Credential resolution
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import searchHubExtension from "../extensions/search-hub.js";
import { reciprocalRankFusion, runTargetedCombine, selectBackendsForFallback } from "../extensions/dispatch.js";
import type { EffectivenessState } from "../extensions/effectiveness.js";
import { resolveBackendKeys, resolveConfigValue, clearCredentialCache, FALLBACK_ENV_MAP } from "../extensions/credentials.js";
import { loadConfig } from "../extensions/config.js";


// ---------------------------------------------------------------------------
// Tool display integration
// ---------------------------------------------------------------------------

describe("tool display integration", () => {
	it("cooperatively decorates both tools with intent schemas and inherited output", () => {
		const apiKey = Symbol.for("pi-tool-display-intent.api.v1");
		const globalWithApi = globalThis as typeof globalThis & Record<symbol, unknown>;
		const previousApi = globalWithApi[apiKey];
		const adapters: Array<Record<string, unknown>> = [];
		const registeredTools: Array<Record<string, any>> = [];

		globalWithApi[apiKey] = {
			version: 1,
			decorateTool(tool: Record<string, unknown>, adapter: Record<string, unknown>) {
				adapters.push(adapter);
				return tool;
			},
		};

		const pi = {
			registerTool(tool: Record<string, unknown>) {
				registeredTools.push(tool);
			},
			registerCommand() {},
			on() {},
		} as unknown as ExtensionAPI;

		try {
			searchHubExtension(pi);

			expect(registeredTools.map((tool) => tool.name)).toEqual(["web_search", "web_read"]);
			expect(adapters).toHaveLength(2);
			for (const adapter of adapters) {
				expect(adapter).toMatchObject({
					kind: "generic",
					outputMode: "inherit",
					overrideExistingRenderers: true,
				});
				expect(adapter.getCallPresentation).toBeTypeOf("function");
				expect(adapter.getResultPresentation).toBeTypeOf("function");
			}

			const searchCall = (adapters[0].getCallPresentation as (args: unknown) => unknown)({
				query: "Pi coding agent latest release GitHub",
				numResults: 3,
				compact: false,
			});
			expect(searchCall).toEqual({
				target: "“Pi coding agent latest release GitHub”",
				metadata: ["top 3"],
			});
			const searchResult = (adapters[0].getResultPresentation as (result: unknown) => unknown)({
				content: [{ type: "text", text: "## Search Results: test\nBackend: tavily · Results: 3\n\nfirst" }],
				details: { backend: "tavily", resultCount: 3 },
			});
			expect(searchResult).toEqual({ summary: "Tavily · 3 results", previewStartLine: 3 });

			const readCall = (adapters[1].getCallPresentation as (args: unknown) => unknown)({
				url: "https://pi.dev/docs/latest/extensions",
			});
			expect(readCall).toEqual({
				target: "pi.dev/docs/latest/extensions",
				metadata: ["Firecrawl"],
			});
			const readResult = (adapters[1].getResultPresentation as (result: unknown) => unknown)({
				details: { reader: "firecrawl", length: 153010, truncated: true },
			});
			expect(readResult).toEqual({
				summary: "Firecrawl · 153k chars · truncated to 10k chars",
				previewStartLine: 0,
			});

			const searchSchema = registeredTools[0].parameters as {
				properties?: Record<string, unknown>;
				required?: string[];
			};
			expect(Object.keys(searchSchema.properties ?? {}).sort()).toEqual(["combine", "compact", "numResults", "query"]);
			expect(searchSchema.properties).not.toHaveProperty("backend");

			const readSchema = registeredTools[1].parameters as {
				properties?: Record<string, unknown>;
				required?: string[];
			};
			expect(Object.keys(readSchema.properties ?? {}).sort()).toEqual(["url"]);
			expect(readSchema.properties).not.toHaveProperty("reader");
			expect(readSchema.properties).not.toHaveProperty("fresh");
			expect(readSchema.properties).not.toHaveProperty("keywords");
			expect(readSchema.properties).not.toHaveProperty("mode");
			expect(readSchema.properties).not.toHaveProperty("objective");

			for (const tool of registeredTools) {
				const schema = tool.parameters as {
					properties?: Record<string, unknown>;
					required?: string[];
				};
				expect(schema.properties?.displaySummary).toBeUndefined();
				expect(schema.required?.includes("displaySummary") ?? false).toBe(false);
				expect(tool.promptGuidelines?.some((line: string) => line.includes("displaySummary")) ?? false).toBe(false);
			}
		} finally {
			if (previousApi === undefined) {
				delete globalWithApi[apiKey];
			} else {
				globalWithApi[apiKey] = previousApi;
			}
		}
	});
});

// ---------------------------------------------------------------------------
// RRF combiner tests
// ---------------------------------------------------------------------------

describe("reciprocalRankFusion", () => {
	it("merges results from two backends and deduplicates by URL", () => {
		const results = reciprocalRankFusion(
			[
				{
					backend: "a",
					results: [
						{ title: "First", url: "https://example.com/1", snippet: "from a", backend: "a" },
						{ title: "Second", url: "https://example.com/2", snippet: "from a", backend: "a" },
					],
				},
				{
					backend: "b",
					results: [
						{ title: "First", url: "https://example.com/1", snippet: "from b", backend: "b" },
						{ title: "Third", url: "https://example.com/3", snippet: "from b", backend: "b" },
					],
				},
			],
			10,
		);

		// Should have 3 unique URLs
		expect(results).toHaveLength(3);

		// URL that appears in both backends should rank highest
		expect(results[0].url).toBe("https://example.com/1");

		// All URLs present
		const urls = results.map(r => r.url);
		expect(urls).toContain("https://example.com/1");
		expect(urls).toContain("https://example.com/2");
		expect(urls).toContain("https://example.com/3");
	});

	it("respects maxResults limit", () => {
		const results = reciprocalRankFusion(
			[
				{
					backend: "a",
					results: Array.from({ length: 10 }, (_, i) => ({
						title: "Result " + i,
						url: "https://example.com/" + i,
						snippet: "snippet " + i,
						backend: "a",
					})),
				},
			],
			5,
		);

		expect(results).toHaveLength(5);
	});

	it("normalizes URLs for dedup (trailing slash, lowercase)", () => {
		const results = reciprocalRankFusion(
			[
				{
					backend: "a",
					results: [
						{ title: "A", url: "https://Example.COM/page/", snippet: "a", backend: "a" },
					],
				},
				{
					backend: "b",
					results: [
						{ title: "B", url: "https://example.com/page", snippet: "b", backend: "b" },
					],
				},
			],
			10,
		);

		// Should deduplicate to 1 result
		expect(results).toHaveLength(1);
	});

	it("prefers result with richer content on dedup", () => {
		const results = reciprocalRankFusion(
			[
				{
					backend: "a",
					results: [
						{ title: "A", url: "https://example.com/1", snippet: "short", backend: "a" },
					],
				},
				{
					backend: "b",
					results: [
						{ title: "B", url: "https://example.com/1", content: "much longer content with more details", backend: "b" },
					],
				},
			],
			10,
		);

		expect(results).toHaveLength(1);
		expect(results[0].content).toBe("much longer content with more details");
	});

	it("returns empty array when no successful backends", () => {
		const results = reciprocalRankFusion([], 10);
		expect(results).toHaveLength(0);
	});
});

// ---------------------------------------------------------------------------
// Targeted combine tests
// ---------------------------------------------------------------------------

describe("runTargetedCombine", () => {
	const resultFor = (backend: string) => [{
		title: `${backend} result`,
		url: `https://example.com/${backend}`,
		snippet: `${backend} snippet`,
	}];

	it("stops after the first three usable backends", async () => {
		const calls: Array<{ backend: string; numResults: number }> = [];
		const result = await runTargetedCombine({
			orderedBackends: ["a", "b", "c", "d"],
			query: "test query",
			numResults: 10,
			runBackend: async (backend, _query, numResults) => {
				calls.push({ backend, numResults });
				return resultFor(backend);
			},
		});

		expect(calls).toEqual([
			{ backend: "a", numResults: 4 },
			{ backend: "b", numResults: 4 },
			{ backend: "c", numResults: 4 },
		]);
		expect(result.usableBackendCount).toBe(3);
		expect(result.results).toHaveLength(3);
		expect(Array.from(result.backendStats.keys())).toEqual(["a", "b", "c"]);
	});

	it("tops up only the missing usable backend count", async () => {
		const calls: string[] = [];
		const result = await runTargetedCombine({
			orderedBackends: ["a", "b", "c", "d", "e"],
			query: "test query",
			numResults: 9,
			runBackend: async (backend) => {
				calls.push(backend);
				if (backend === "b") throw new Error("b failed");
				return resultFor(backend);
			},
		});

		expect(calls).toEqual(["a", "b", "c", "d"]);
		expect(result.usableBackendCount).toBe(3);
		expect(result.backendStats.get("b")).toMatchObject({ success: false, count: 0, error: "b failed" });
		expect(result.backendStats.has("e")).toBe(false);
	});

	it("runs the next three when the first three are not usable", async () => {
		const calls: string[] = [];
		const result = await runTargetedCombine({
			orderedBackends: ["a", "b", "c", "d", "e", "f", "g"],
			query: "test query",
			numResults: 6,
			runBackend: async (backend) => {
				calls.push(backend);
				if (["a", "b", "c"].includes(backend)) return [];
				return resultFor(backend);
			},
		});

		expect(calls).toEqual(["a", "b", "c", "d", "e", "f"]);
		expect(result.usableBackendCount).toBe(3);
		expect(result.backendStats.get("a")).toMatchObject({ success: true, count: 0 });
		expect(result.backendStats.has("g")).toBe(false);
	});

	it("returns partial results when active backends are exhausted", async () => {
		const result = await runTargetedCombine({
			orderedBackends: ["a", "b", "c"],
			query: "test query",
			numResults: 10,
			runBackend: async (backend) => {
				if (backend === "a") return resultFor(backend);
				if (backend === "b") return [];
				throw new Error("c failed");
			},
		});

		expect(result.usableBackendCount).toBe(1);
		expect(result.results).toEqual([{ ...resultFor("a")[0], backend: "a" }]);
		expect(result.backendStats.get("b")).toMatchObject({ success: true, count: 0 });
		expect(result.backendStats.get("c")).toMatchObject({ success: false, count: 0, error: "c failed" });
	});

	it("returns empty when all backends fail", async () => {
		const result = await runTargetedCombine({
			orderedBackends: ["a", "b"],
			query: "test query",
			numResults: 10,
			runBackend: async () => { throw new Error("fail"); },
		});

		expect(result.usableBackendCount).toBe(0);
		expect(result.results).toEqual([]);
	});

	it("returns empty when orderedBackends is empty", async () => {
		const result = await runTargetedCombine({
			orderedBackends: [],
			query: "test query",
			numResults: 10,
			runBackend: async () => [],
		});

		expect(result.usableBackendCount).toBe(0);
		expect(result.results).toEqual([]);
	});

	it("distributes numResults across targetUsableBackends", async () => {
		const calls: number[] = [];
		await runTargetedCombine({
			orderedBackends: ["a", "b", "c"],
			query: "test query",
			numResults: 9,
			targetUsableBackends: 3,
			runBackend: async (_, __, numResults) => {
				calls.push(numResults);
				return [{ title: "x", url: "https://x.com", snippet: "x" }];
			},
		});

		expect(calls).toEqual([3, 3, 3]);
	});

	it("uses single backend results directly without RRF", async () => {
		const result = await runTargetedCombine({
			orderedBackends: ["a", "b"],
			query: "test query",
			numResults: 10,
			runBackend: async (backend) => {
				if (backend === "a") return resultFor(backend);
				throw new Error("b fail");
			},
		});

		expect(result.usableBackendCount).toBe(1);
		expect(result.results).toHaveLength(1);
		expect(result.results[0].backend).toBe("a");
	});
});

// ---------------------------------------------------------------------------
// Selection strategy tests
// ---------------------------------------------------------------------------

describe("selectBackendsForFallback", () => {
	it("priority returns backends in original order", () => {
		const backends = ["exa", "tavily", "firecrawl"];
		const result = selectBackendsForFallback("priority", backends);
		expect(result).toEqual(backends);
	});

	it("random returns all backends (possibly reordered)", () => {
		const backends = ["exa", "tavily", "firecrawl"];
		const result = selectBackendsForFallback("random", backends);
		expect(result).toHaveLength(backends.length);
		for (const b of backends) {
			expect(result).toContain(b);
		}
		const results: string[][] = [];
		for (let i = 0; i < 20; i++) {
			results.push(selectBackendsForFallback("random", [...backends]));
		}
		const first = JSON.stringify(results[0]);
		const shuffled = results.some((r) => JSON.stringify(r) !== first);
		expect(shuffled).toBe(true);
	});

	it("best-latency ranks by persisted success rate then median latency", () => {
		const backends = ["slow-backend", "fast-backend", "broken-backend"];
		const attempt = (ok: boolean, latencyMs: number) => ({ t: 1, ok, latencyMs });
		const state: EffectivenessState = {
			"fast-backend:search": [attempt(true, 80), attempt(true, 120)],
			"slow-backend:search": [attempt(true, 4000), attempt(true, 5000)],
			"broken-backend:search": [attempt(false, 10), attempt(false, 12)],
		};

		const result = selectBackendsForFallback("best-latency", backends, state);

		expect(result).toEqual(["fast-backend", "slow-backend", "broken-backend"]);
	});

	it("does not mutate original array", () => {
		const backends = ["exa", "tavily", "firecrawl"];
		const copy = [...backends];
		selectBackendsForFallback("random", backends);
		expect(backends).toEqual(copy);
	});
});

// ---------------------------------------------------------------------------
// Credential resolution tests
// ---------------------------------------------------------------------------

describe("resolveConfigValue", () => {
	beforeEach(() => {
		clearCredentialCache();
	});

	afterEach(() => {
		clearCredentialCache();
	});

	it("returns undefined for undefined input", () => {
		expect(resolveConfigValue(undefined)).toBeUndefined();
	});

	it("returns undefined for empty or whitespace-only strings", () => {
		expect(resolveConfigValue("")).toBeUndefined();
		expect(resolveConfigValue("   ")).toBeUndefined();
	});

	it("returns literal key for non-ALL_CAPS strings", () => {
		expect(resolveConfigValue("sk-abc123")).toBe("sk-abc123");
	});

	it("resolves and trims ALL_CAPS values from env vars", () => {
		process.env.TEST_SEARCH_KEY_123 = "  secret-value  ";
		try {
			expect(resolveConfigValue("TEST_SEARCH_KEY_123")).toBe("secret-value");
		} finally {
			delete process.env.TEST_SEARCH_KEY_123;
		}
	});

	it("returns undefined for whitespace-only env var values", () => {
		process.env.TEST_SEARCH_KEY_123 = "   ";
		try {
			expect(resolveConfigValue("TEST_SEARCH_KEY_123")).toBeUndefined();
		} finally {
			delete process.env.TEST_SEARCH_KEY_123;
		}
	});

	it("reports an unset credential without writing to the terminal or echoing the reference", () => {
		const warnSpy = vi.spyOn(console, "warn").mockImplementation(() => {});
		const notices: string[] = [];
		try {
			const result = resolveConfigValue("DEFINITELY_NOT_SET_XYZ", (message) => notices.push(message));
			expect(result).toBeUndefined();
			expect(notices).toHaveLength(1);
			expect(notices[0]).toContain("unset");
			expect(notices[0]).not.toContain("DEFINITELY_NOT_SET_XYZ");
			expect(warnSpy).not.toHaveBeenCalled();
		} finally { warnSpy.mockRestore(); }
	});

	it("skips a failed credential command and still resolves later keys", () => {
		const notices: string[] = [];
		const keys = resolveBackendKeys("exa", {
			backends: { exa: { apiKeys: ["!printf 'credential-command-private-marker' >&2; exit 1", "sk-valid-literal"] } },
		}, (message) => notices.push(message));
		expect(keys).toEqual(["sk-valid-literal"]);
		expect(notices.join(" ")).toMatch(/credential command failed/i);
		expect(JSON.stringify(notices)).not.toContain("credential-command-private-marker");
	});
});

// ---------------------------------------------------------------------------
// Config loading tests
// ---------------------------------------------------------------------------

describe("loadConfig", () => {
	it("returns default config when no config files or backend env vars exist", () => {
		const envNames = [...new Set(Object.values(FALLBACK_ENV_MAP))];
		const previous = new Map(envNames.map((name) => [name, process.env[name]]));
		const previousHome = process.env.HOME;
		const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
		try {
			for (const name of envNames) delete process.env[name];
			process.env.HOME = "/nonexistent/pi-search-hub-test-home";
			delete process.env.PI_CODING_AGENT_DIR;
			const cfg = loadConfig("/nonexistent/path");
			expect(cfg.routing).toBeUndefined();
			expect(typeof cfg.backends).toBe("object");
		} finally {
			if (previousHome === undefined) delete process.env.HOME;
			else process.env.HOME = previousHome;
			if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
			else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
			for (const [name, value] of previous) {
				if (value === undefined) delete process.env[name];
				else process.env[name] = value;
			}
		}
	});
});

