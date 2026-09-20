import { describe, expect, it, vi } from "vitest";
import type { Api, AssistantMessage, Context, Model } from "@earendil-works/pi-ai";
import {
	HOSTED_SEARCH_BACKENDS,
	injectHostedWebSearch,
	looksLikeDomainOrPath,
	normalizeHttpUrl,
	normalizeSubmitSearchResults,
	normalizeUrlForDedup,
	resolveHostedSearchModel,
	searchHostedWebSearch,
} from "../extensions/backends/hosted-search.js";
import type { HostedSearchRuntime } from "../extensions/types.js";

function model(provider: string, id: string): Model<Api> {
	return { id, provider } as Model<Api>;
}

function runtimeWith(models: Model<Api>[], complete: HostedSearchRuntime["complete"]): HostedSearchRuntime {
	return {
		find(provider, id) {
			return models.find((entry) => entry.provider === provider && entry.id === id);
		},
		getProvider(provider) {
			const owned = models.filter((entry) => entry.provider === provider);
			return { getModels: () => owned };
		},
		hasConfiguredAuth: () => true,
		complete,
	};
}

function successMessage(results: unknown): AssistantMessage {
	return {
		stopReason: "stop",
		content: [
			{
				type: "toolCall",
				id: "call_1",
				name: "submit_search_results",
				arguments: { results },
			},
		],
	} as unknown as AssistantMessage;
}

function completeArgs(complete: ReturnType<typeof vi.fn>): [Model<Api>, Context, Record<string, any>] {
	return complete.mock.calls[0] as [Model<Api>, Context, Record<string, any>];
}

describe("hosted web search helpers", () => {
	it("injects Codex hosted search in front of function tools", () => {
		const payload = injectHostedWebSearch({
			tools: [
				{ type: "web_search", external_web_access: false },
				{ type: "function", name: "submit_search_results" },
			],
			include: ["reasoning.encrypted_content"],
			parallel_tool_calls: true,
		}, "codex") as {
			tools: Array<Record<string, unknown>>;
			include: string[];
			parallel_tool_calls: boolean;
			tool_choice: string;
		};

		expect(payload.tools).toHaveLength(2);
		expect(payload.tools[0]).toMatchObject({
			type: "web_search",
			external_web_access: true,
			search_context_size: "low",
		});
		expect(payload.tools[1]).toMatchObject({ type: "function", name: "submit_search_results" });
		expect(payload.parallel_tool_calls).toBe(false);
		expect(payload.tool_choice).toBe("auto");
		expect(payload.include).toEqual([
			"reasoning.encrypted_content",
			"web_search_call.action.sources",
		]);
	});

	it("injects a plain web_search tool for Grok without Codex-only fields", () => {
		const payload = injectHostedWebSearch({
			tools: [{ type: "function", name: "submit_search_results" }],
		}, "xai") as { tools: Array<Record<string, unknown>>; include?: unknown };

		expect(payload.tools[0]).toEqual({ type: "web_search" });
		expect(payload.tools[1]).toMatchObject({ type: "function", name: "submit_search_results" });
		expect(payload).not.toHaveProperty("include");
	});

	it("normalizeSubmitSearchResults drops invalid URLs, dedupes, and falls back to content", () => {
		const results = normalizeSubmitSearchResults(
			{
				results: [
					{ title: "", url: "example.com", snippet: "Primary source summary", content: "Ignored model content" },
					{ title: "Content only", url: "https://content-only.example/", content: "Falls back to content when no snippet" },
					{ title: "Duplicate", url: "https://example.com/#section", snippet: "duplicate" },
					{ title: "Bad", url: "javascript:alert(1)", snippet: "ignore me" },
					{ title: "Docs", url: "https://docs.digitalocean.com/reference/doctl/", snippet: "CLI docs" },
				],
			},
			3,
		);

		expect(results).toEqual([
			{
				title: "example.com",
				url: "https://example.com/",
				snippet: "Primary source summary",
				content: "Primary source summary",
			},
			{
				title: "Content only",
				url: "https://content-only.example/",
				snippet: "Falls back to content when no snippet",
				content: "Falls back to content when no snippet",
			},
			{
				title: "Docs",
				url: "https://docs.digitalocean.com/reference/doctl/",
				snippet: "CLI docs",
				content: "CLI docs",
			},
		]);
	});

	it("normalizeHttpUrl rejects non-http protocols and accepts bare domains", () => {
		expect(normalizeHttpUrl("example.com")).toBe("https://example.com/");
		expect(normalizeHttpUrl("javascript:alert(1)")).toBeUndefined();
		expect(normalizeUrlForDedup("https://Example.COM/Page/")).toBe("https://example.com/page");
		expect(looksLikeDomainOrPath("example.com")).toBe(true);
		expect(looksLikeDomainOrPath("justaword")).toBe(false);
	});
});

describe("hosted web search complete()", () => {
	it("calls modelRegistry.complete with the default Codex model", async () => {
		const complete = vi.fn(async () => successMessage([
			{ title: "Docs", url: "https://example.com/docs", snippet: "Example docs" },
		]));
		const luna = model("openai-codex", HOSTED_SEARCH_BACKENDS["openai-codex"].defaultModel);
		const runtime = runtimeWith([luna], complete);

		const { results } = await searchHostedWebSearch("openai-codex", "test query", 3, runtime);

		expect(complete).toHaveBeenCalledOnce();
		const [usedModel, context, options] = completeArgs(complete);
		expect(usedModel).toBe(luna);
		expect(context.systemPrompt).toContain("hosted web_search");
		expect(context.tools?.[0]?.name).toBe("submit_search_results");
		expect(options.reasoningEffort).toBe("minimal");
		expect(typeof options.onPayload).toBe("function");
		expect(results).toHaveLength(1);
		expect(results[0].url).toBe("https://example.com/docs");
	});

	it("falls back from an unknown model id with a notice", () => {
		const notices: string[] = [];
		const luna = model("openai-codex", "gpt-5.6-luna");
		const runtime = runtimeWith([luna], async () => successMessage([]));
		expect(resolveHostedSearchModel(runtime, "openai-codex", "not-a-model", (message) => notices.push(message))).toBe(luna);
		expect(notices.join(" ")).toContain("unknown model");
		expect(notices.join(" ")).toContain("gpt-5.6-luna");
	});

	it("asks for /login when Codex auth is missing", async () => {
		const runtime: HostedSearchRuntime = {
			find: () => model("openai-codex", "gpt-5.6-luna"),
			getProvider: () => ({ getModels: () => [model("openai-codex", "gpt-5.6-luna")] }),
			hasConfiguredAuth: () => false,
			complete: async () => {
				throw new Error("should not complete");
			},
		};
		await expect(searchHostedWebSearch("openai-codex", "q", 1, runtime)).rejects.toThrow("/login openai-codex");
	});

	it("uses Grok 4.3 by default and does not pass Codex stream options", async () => {
		const complete = vi.fn(async () => successMessage([
			{ title: "xAI", url: "https://x.ai/", snippet: "xAI site" },
		]));
		const grok = model("xai", "grok-4.3");
		await searchHostedWebSearch("xai", "what is xai", 1, runtimeWith([grok], complete));
		const [usedModel, , options] = completeArgs(complete);
		expect(usedModel).toBe(grok);
		expect(options).not.toHaveProperty("reasoningEffort");
		expect(options).not.toHaveProperty("textVerbosity");
		expect(options.onPayload({ tools: [] }).tools[0]).toEqual({ type: "web_search" });
	});
});
