import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { searchParallel, fetchParallel } from "../extensions/backends/parallel.js";

describe("searchParallel", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("posts official REST search with x-api-key and fast mode", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{ title: "T", url: "https://example.com", excerpts: ["one", "two"] }],
			}),
		} as Response);

		const result = await searchParallel("latest Parallel API", 5, "pk-test");
		expect(result.results[0]).toEqual({
			title: "T",
			url: "https://example.com",
			snippet: "one two",
		});

		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.parallel.ai/v1/search");
		const headers = init.headers as Record<string, string>;
		expect(headers["x-api-key"]).toBe("pk-test");
		expect(JSON.parse(init.body as string)).toEqual({
			objective: "latest Parallel API",
			search_queries: ["latest Parallel API"],
			mode: "fast",
		});
	});

	it("throws on HTTP errors", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: false,
			status: 401,
			text: async () => JSON.stringify({ error: { message: "invalid key" } }),
		} as Response);

		await expect(searchParallel("q", 3, "bad")).rejects.toThrow(/Parallel .*401/);
	});
});

describe("fetchParallel", () => {
	let fetchSpy: ReturnType<typeof vi.spyOn>;

	beforeEach(() => {
		fetchSpy = vi.spyOn(global, "fetch");
	});

	afterEach(() => {
		fetchSpy.mockRestore();
	});

	it("prefers full_content over excerpts", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{
					url: "https://example.com",
					title: "Example",
					full_content: "Full page",
					excerpts: ["ignored"],
				}],
			}),
		} as Response);

		const result = await fetchParallel("https://example.com", "pk-test");
		expect(result.content).toBe("Full page");
		const [url, init] = fetchSpy.mock.calls[0] as [string, RequestInit];
		expect(url).toBe("https://api.parallel.ai/v1/extract");
		expect(JSON.parse(init.body as string)).toEqual({
			urls: ["https://example.com"],
			full_content: true,
		});
	});

	it("joins excerpts when full_content is missing", async () => {
		fetchSpy.mockResolvedValueOnce({
			ok: true,
			json: async () => ({
				results: [{
					url: "https://example.com",
					title: "Example",
					excerpts: ["a", "b"],
				}],
			}),
		} as Response);

		const result = await fetchParallel("https://example.com", "pk-test");
		expect(result.content).toBe("a\n\nb");
	});
});
