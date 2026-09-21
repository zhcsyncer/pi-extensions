import { describe, expect, it } from "vitest";
import {
	getWebReadCallPresentation,
	getWebReadResultPresentation,
	getWebSearchCallPresentation,
	getWebSearchResultPresentation,
	formatWebSearchCallLine,
	formatWebReadCallLine,
	formatWebSearchResultLine,
} from "./display.js";

describe("Search Hub display formatters", () => {
	it("formats search defaults and optional combine metadata", () => {
		expect(getWebSearchCallPresentation({ query: "current release" })).toEqual({
			target: "“current release”",
			metadata: ["top 10"],
		});
		expect(getWebSearchCallPresentation({
			query: "current release",
			numResults: 50,
			combine: true,
			compact: true,
		})).toEqual({
			target: "“current release”",
			metadata: ["combine", "top 20", "compact"],
		});
	});

	it("formats normal, fallback, and combined search result status", () => {
		expect(getWebSearchResultPresentation({
			content: [{ type: "text", text: "1. First — https://example.com" }],
			details: { backend: "tavily", resultCount: 1 },
		})).toEqual({ summary: "Tavily · 1 result", previewStartLine: 0 });

		expect(getWebSearchResultPresentation({
			content: [{ type: "text", text: "exa failed\n\n## Search Results: test" }],
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
					firecrawl: { success: false, count: 0 },
				},
			},
		})).toEqual({
			summary: "Targeted combine · 5 results · 2/3 backends usable",
			previewStartLine: 0,
		});
	});

	it("shortens read URLs and shows only the reader", () => {
		expect(getWebReadCallPresentation({
			url: "https://pi.dev/docs/latest/extensions?view=full",
			mode: "smart",
			keywords: ["renderCall"],
			fresh: true,
			objective: "main article",
		}, "firecrawl")).toEqual({
			target: "pi.dev/docs/latest/extensions?view=full",
			metadata: ["Firecrawl"],
		});
	});

	it("formats read lengths and truncation without presenting failed results", () => {
		expect(getWebReadResultPresentation({
			details: { reader: "firecrawl", length: 153010, truncated: true },
		})).toEqual({
			summary: "Firecrawl · 153k chars · truncated to 10k chars",
			previewStartLine: 0,
		});
		expect(getWebReadResultPresentation({ details: {} })).toBeUndefined();
	});

	it("draws Claude-style call and result rows", () => {
		const theme = {
			fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
			bold: (text: string) => text,
		};
		expect(formatWebSearchCallLine({ query: "current release" }, theme)).toContain("Web Search");
		expect(formatWebSearchCallLine({ query: "current release" }, theme)).toContain("current release");
		expect(formatWebReadCallLine({ url: "https://pi.dev/docs" }, theme)).toContain("Read Web Page");
		expect(formatWebSearchResultLine({ details: { backend: "tavily", resultCount: 2 } }, theme)).toContain("Tavily");
		expect(formatWebSearchCallLine({ query: "q" }, theme, { isError: true })).toContain("<error>●</error>");
	});

	it("normalizes multiline call targets and ignores malformed inputs", () => {
		expect(getWebSearchCallPresentation({ query: "first\nsecond" })).toEqual({
			target: "“first second”",
			metadata: ["top 10"],
		});
		expect(getWebSearchCallPresentation(null)).toBeUndefined();
		expect(getWebReadCallPresentation({ url: "   " })).toBeUndefined();
	});
});
