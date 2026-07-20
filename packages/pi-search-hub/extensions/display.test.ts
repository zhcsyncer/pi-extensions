import { describe, expect, it } from "vitest";
import {
	getWebReadCallPresentation,
	getWebReadResultPresentation,
	getWebSearchCallPresentation,
	getWebSearchResultPresentation,
} from "./display.js";

describe("Search Hub display formatters", () => {
	it("formats search defaults and optional combine metadata", () => {
		expect(getWebSearchCallPresentation({ query: "current release" })).toEqual({
			target: "“current release”",
			metadata: ["auto", "top 10"],
		});
		expect(getWebSearchCallPresentation({
			query: "current release",
			backend: "auto",
			numResults: 50,
			combine: true,
			compact: true,
		})).toEqual({
			target: "“current release”",
			metadata: ["auto", "combine", "top 20", "compact"],
		});
	});

	it("formats normal, fallback, and combined search result status", () => {
		expect(getWebSearchResultPresentation({
			content: [{ type: "text", text: "1. First — https://example.com" }],
			details: { backend: "tavily", resultCount: 1 },
		})).toEqual({ summary: "Tavily · 1 result", previewStartLine: 0 });

		expect(getWebSearchResultPresentation({
			content: [{ type: "text", text: "duckduckgo failed\n\n## Search Results: test" }],
			details: { backend: "tavily (fallback)", resultCount: 3 },
		})).toEqual({ summary: "Tavily fallback · 3 results", previewStartLine: 0 });

		expect(getWebSearchResultPresentation({
			details: {
				backend: "combined-targeted",
				resultCount: 5,
				usableBackendCount: 2,
				backendStats: {
					tavily: { success: true, count: 3 },
					exa: { success: true, count: 2 },
					brave: { success: false, count: 0 },
				},
			},
		})).toEqual({
			summary: "Targeted combine · 5 results · 2/3 backends usable",
			previewStartLine: 0,
		});
	});

	it("shortens read URLs and formats reader options", () => {
		expect(getWebReadCallPresentation({
			url: "https://pi.dev/docs/latest/extensions?view=full",
			mode: "smart",
			keywords: ["renderCall"],
			fresh: true,
			objective: "main article",
		}, "firecrawl")).toEqual({
			target: "pi.dev/docs/latest/extensions?view=full",
			metadata: ["Firecrawl", "smart", "1 keyword", "fresh", "selector"],
		});
	});

	it("formats read lengths and truncation without presenting failed results", () => {
		expect(getWebReadResultPresentation({
			details: { reader: "jina", length: 153010, truncated: true },
		})).toEqual({
			summary: "Jina · 153k chars · truncated to 10k chars",
			previewStartLine: 0,
		});
		expect(getWebReadResultPresentation({ details: {} })).toBeUndefined();
	});

	it("normalizes multiline call targets and ignores malformed inputs", () => {
		expect(getWebSearchCallPresentation({ query: "first\nsecond" })).toEqual({
			target: "“first second”",
			metadata: ["auto", "top 10"],
		});
		expect(getWebSearchCallPresentation(null)).toBeUndefined();
		expect(getWebReadCallPresentation({ url: "   " })).toBeUndefined();
	});
});
