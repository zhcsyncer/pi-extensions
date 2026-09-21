import { describe, it, expect } from "vitest";
import {
	parseTavily,
	parseExa,
	parseFirecrawl,
	parseParallel,
} from "./parsers.js";

describe("parseTavily", () => {
	it("maps content to snippet and preserves content field", () => {
		const data = { results: [{ title: "T", url: "https://t.com", content: "full content" }] };
		const results = parseTavily(data, 10);
		expect(results[0].snippet).toBe("full content");
		expect(results[0].content).toBe("full content");
	});
});

describe("parseExa", () => {
	it("prefers text over highlight for snippet", () => {
		const data = { results: [{ title: "E", url: "https://e.com", text: "text val", highlight: "high val" }] };
		const results = parseExa(data, 10);
		expect(results[0].snippet).toBe("text val");
	});

	it("falls back to highlight when no text", () => {
		const data = { results: [{ title: "E", url: "https://e.com", highlight: "high val" }] };
		const results = parseExa(data, 10);
		expect(results[0].snippet).toBe("high val");
	});
});

describe("parseFirecrawl", () => {
	it("parses v2 object response with web array", () => {
		const data = { data: { web: [{ title: "FC", url: "https://fc.com", description: "d" }] } };
		const results = parseFirecrawl(data, 10);
		expect(results[0]).toEqual({ title: "FC", url: "https://fc.com", snippet: "d" });
	});

	it("parses v2 flat array response", () => {
		const data = { data: [{ title: "FC", url: "https://fc.com" }] };
		const results = parseFirecrawl(data, 10);
		expect(results).toHaveLength(1);
	});

	it("falls back to v1 results field", () => {
		const data = { results: [{ title: "FC1", url: "https://fc.com/1" }] };
		const results = parseFirecrawl(data, 10);
		expect(results).toHaveLength(1);
	});

	it("falls back to images when web is empty", () => {
		const data = { data: { web: [], images: [{ title: "Img", url: "https://img.com" }] } };
		const results = parseFirecrawl(data, 10);
		expect(results[0].title).toBe("Img");
	});
});

describe("parseParallel", () => {
	it("joins excerpts into a snippet", () => {
		const data = {
			results: [{
				title: "Sample webpage title",
				url: "https://www.example.com",
				excerpts: ["Sample excerpt 1", "Sample excerpt 2"],
			}],
		};
		const results = parseParallel(data, 10);
		expect(results[0]).toEqual({
			title: "Sample webpage title",
			url: "https://www.example.com",
			snippet: "Sample excerpt 1 Sample excerpt 2",
		});
	});

	it("handles missing excerpts", () => {
		const results = parseParallel({ results: [{ title: "T", url: "https://e.com" }] }, 10);
		expect(results[0].snippet).toBe("");
	});
});
