import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import searchHubExtension from "../extensions/search-hub.js";
import { FALLBACK_ENV_MAP } from "../extensions/credentials.js";
import { effectiveSearchConfig } from "../extensions/config.js";
import {
	applySetupSetting,
	buildPrioritySetupItems,
	buildProviderSetupItems,
	buildSearchSetupItems,
	mergePreservedKeys,
	parseApiKeysEditor,
} from "../extensions/setup-ui.js";
import type { SearchConfig } from "../extensions/types.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		getSettingsListTheme: () => ({
			label: (text: string) => text,
			value: (text: string) => text,
			description: (text: string) => text,
			cursor: ">",
			hint: (text: string) => text,
		}),
	};
});

type Selection = string | undefined | ((options: string[]) => string | undefined);
type CommandHandler = (args: string, ctx: any) => Promise<void> | void;
type EventHandler = (event: any, ctx: any) => Promise<void> | void;

type RegisteredTool = {
	execute: (
		toolCallId: string,
		params: Record<string, any>,
		signal: AbortSignal | undefined,
		onUpdate: ((result: any) => void) | undefined,
		ctx: any,
	) => Promise<any>;
};

function makeTheme() {
	return {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
}

function createHarness(cwd: string, options: {
	selections?: Selection[];
	editorResults?: Array<string | undefined>;
	custom?: (factory: (...args: any[]) => Component) => Promise<unknown>;
} = {}) {
	const selections = options.selections ?? [];
	const editorResults = options.editorResults ?? [];
	const commands = new Map<string, CommandHandler>();
	const events = new Map<string, EventHandler>();
	const tools = new Map<string, RegisteredTool>();
	const notifications: Array<{ message: string; level: string }> = [];
	const setStatus = vi.fn();
	const select = vi.fn(async (_title: string, opts: string[]) => {
		const next = selections.shift();
		return typeof next === "function" ? next(opts) : next;
	});
	const editor = vi.fn(async () => editorResults.shift());
	const custom = vi.fn(async (factory: (...args: any[]) => Component) => {
		if (options.custom) return options.custom(factory);
		const component = factory({ requestRender: vi.fn() }, makeTheme(), {}, vi.fn());
		return undefined;
	});
	const pi = {
		registerTool(tool: RegisteredTool & { name: string }) {
			tools.set(tool.name, tool);
		},
		registerCommand(name: string, definition: { handler: CommandHandler }) {
			commands.set(name, definition.handler);
		},
		on(name: string, handler: EventHandler) {
			events.set(name, handler);
		},
	} as unknown as ExtensionAPI;
	searchHubExtension(pi);

	const ctx = {
		hasUI: true,
		mode: "tui",
		cwd,
		isProjectTrusted: () => true,
		modelRegistry: {
			getProviderAuthStatus() {
				return { configured: false };
			},
			getApiKeyForProvider: vi.fn(async () => undefined),
		},
		ui: {
			select,
			input: vi.fn(),
			editor,
			custom,
			setStatus,
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	};

	return { commands, events, tools, ctx, notifications, select, editor, custom, setStatus };
}

function globalConfigPath(home: string): string {
	return join(home, ".pi", "agent", "extension-data", "pi-search-hub", "config.json");
}

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value, null, 2) + "\n");
}

function readGlobalConfig(home: string): SearchConfig {
	return JSON.parse(readFileSync(globalConfigPath(home), "utf-8")) as SearchConfig;
}

describe("Search Hub setup draft helpers", () => {
	it("keeps providers and priority editing off the home page unless routing is priority", () => {
		const draft = {
			routing: "priority" as const,
			priority: ["tavily", "exa"] as SearchConfig["priority"],
			backends: {
				tavily: { enabled: true },
				exa: { enabled: true, apiKeys: ["sk-test"] },
			},
		};
		const priorityHome = buildSearchSetupItems(draft);
		expect(priorityHome.map((item) => item.label)).toEqual([
			"Routing",
			"Priority order",
			"Providers",
			"Compact",
		]);
		expect(priorityHome.find((item) => item.id === "priority")?.currentValue).toBe("Tavily → Exa");
		expect(buildPrioritySetupItems(draft).map((item) => item.label)).toEqual(["1. Tavily", "2. Exa"]);
		expect(buildPrioritySetupItems(draft, "priority-move.exa").find((item) => item.id === "priority-move.exa")?.currentValue).toBe("moving");
		expect(buildSearchSetupItems({
			routing: "random",
			priority: ["tavily", "exa"],
			backends: { tavily: { enabled: true }, exa: { enabled: true } },
		}).map((item) => item.label)).toEqual(["Routing", "Providers", "Compact"]);
		const providers = buildProviderSetupItems({
			backends: { exa: { enabled: true, apiKeys: ["sk-test"] } },
		});
		expect(providers.map((item) => item.label)).toEqual([
			"Exa",
			"Exa keys",
			"Tavily",
			"Tavily keys",
			"Firecrawl",
			"Firecrawl keys",
			"Parallel",
			"Parallel keys",
			"OpenAI Codex",
			"OpenAI Codex model",
			"Grok",
			"Grok model",
		]);
		expect(providers.find((item) => item.id === "model.openai-codex")?.currentValue).toBe("gpt-5.6-luna");
		expect(providers.find((item) => item.id === "model.xai")?.currentValue).toBe("grok-4.3");
		expect(providers.find((item) => item.id === "keys.exa")?.currentValue).toBe("1 key");
		expect(priorityHome.map((item) => item.label).join(" ")).not.toMatch(/Save|Discard|Exit|Search mode|Selection strategy|keyless bulk/i);
	});

	it("shows env auto-enabled backends and env credentials on the providers page", () => {
		vi.stubEnv("SEARCH_TAVILY_API_KEY", "tvly-from-env");
		try {
			const effective = effectiveSearchConfig({
				backends: { firecrawl: { enabled: true } },
			});
			const home = buildSearchSetupItems(effective);
			const providers = buildProviderSetupItems(effective);
			expect(home.find((item) => item.id === "providers")?.currentValue).toBe("2 on");
			expect(providers.find((item) => item.id === "enabled.tavily")?.currentValue).toBe("on");
			expect(providers.find((item) => item.id === "keys.tavily")?.currentValue).toBe("env SEARCH_TAVILY_API_KEY");
		} finally {
			vi.unstubAllEnvs();
		}
	});

	it("parses editor lines into apiKeys", () => {
		expect(parseApiKeysEditor("sk-a\n\n# comment\nEXA_API_KEY\nsk-a\n")).toEqual(["sk-a", "EXA_API_KEY"]);
	});

	it("cycles hosted-search models without writing apiKeys", () => {
		const next = applySetupSetting({
			backends: { "openai-codex": { enabled: true } },
		}, "model.openai-codex", "gpt-5.6-terra");
		expect(next.backends?.["openai-codex"]).toEqual({
			enabled: true,
			model: "gpt-5.6-terra",
		});
		expect(next.backends?.["openai-codex"]).not.toHaveProperty("apiKeys");
	});

	it("toggles enabled backends in memory without dropping keys", () => {
		const next = applySetupSetting({
			backends: { tavily: { enabled: true, apiKeys: ["sk-retained"] } },
			priority: ["tavily"],
		}, "enabled.tavily", "off");
		expect(next.backends?.tavily).toEqual({ enabled: false, apiKeys: ["sk-retained"] });
		expect(next.priority ?? []).not.toContain("tavily");
	});

	it("moves a priority backend up or down without accepting typed names", () => {
		const base: SearchConfig = {
			routing: "priority",
			priority: ["tavily", "exa"],
			backends: { tavily: { enabled: true }, exa: { enabled: true } },
		};
		expect(applySetupSetting(base, "priority-move.exa", "move up").priority).toEqual(["exa", "tavily"]);
		expect(applySetupSetting(base, "priority-move.tavily", "move down").priority).toEqual(["exa", "tavily"]);
	});

	it("keeps on-disk keys unless the editor explicitly cleared them", () => {
		const disk = { backends: { tavily: { enabled: true, apiKeys: ["sk-disk"] } } };
		const saved = { backends: { tavily: { enabled: false } } };
		expect(mergePreservedKeys(saved, disk, new Set()).backends?.tavily).toEqual({
			enabled: false,
			apiKeys: ["sk-disk"],
		});
		expect(mergePreservedKeys(saved, disk, new Set(["tavily"])).backends?.tavily).toEqual({
			enabled: false,
		});
	});
});

describe("Search Hub setup and reader configuration", () => {
	let home: string;
	let cwd: string;
	let previousHome: string | undefined;
	const previousEnv = new Map<string, string | undefined>();

	beforeEach(() => {
		home = mkdtempSync(join(tmpdir(), "pi-search-hub-setup-"));
		cwd = join(home, "project");
		mkdirSync(cwd, { recursive: true });
		previousHome = process.env.HOME;
		process.env.HOME = home;
		vi.stubEnv("PI_CODING_AGENT_DIR", join(home, ".pi", "agent"));
		vi.stubGlobal("fetch", vi.fn(async () => { throw new Error("Unexpected network request in setup test"); }));
		for (const name of Object.values(FALLBACK_ENV_MAP)) {
			previousEnv.set(name, process.env[name]);
			delete process.env[name];
		}
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		for (const [name, value] of previousEnv) {
			if (value === undefined) delete process.env[name];
			else process.env[name] = value;
		}
		previousEnv.clear();
		vi.unstubAllEnvs();
		vi.unstubAllGlobals();
		rmSync(home, { recursive: true, force: true });
	});

	it("opens a SettingsList page with search disabled and no nested select wizard", async () => {
		const rendered: string[] = [];
		const harness = createHarness(cwd, {
			custom: async (factory) => {
				const component = factory({ requestRender: vi.fn() }, makeTheme(), {}, vi.fn());
				rendered.push(component.render(100).join("\n"));
				return { type: "close" };
			},
		});

		await harness.commands.get("search-setup")!("", harness.ctx);

		expect(harness.commands.has("search-status")).toBe(false);
		expect(harness.select).not.toHaveBeenCalled();
		expect(rendered[0]).toContain("Routing");
		expect(rendered[0]).toContain("Providers");
		expect(rendered[0]).toContain("s save");
		expect(rendered[0]).not.toContain("Enter/Space to change");
		expect(rendered[0]).not.toContain("Exa keys");
		expect(rendered[0]).not.toContain("Type to search");
		expect(rendered[0]).not.toContain("Save & apply");
		expect(rendered[0]).not.toContain("Search mode");
		expect(rendered[0]).not.toContain("Enable ready keyless");
	});

	it("saves the draft with s and does not write keys until then", async () => {
		writeJson(globalConfigPath(home), {
			backends: { tavily: { enabled: false, apiKeys: ["sk-old"] } },
		});
		let stage = 0;
		const harness = createHarness(cwd, {
			editorResults: ["sk-new\nTAVILY_API_KEY"],
			custom: async (factory) => {
				stage += 1;
				if (stage === 1) return { type: "edit-keys", backend: "tavily" };
				const component = factory({ requestRender: vi.fn() }, makeTheme(), {}, vi.fn());
				component.handleInput?.("s");
				return { type: "close" };
			},
		});

		await harness.commands.get("search-setup")!("", harness.ctx);

		expect(harness.editor).toHaveBeenCalledOnce();
		expect(readGlobalConfig(home).backends?.tavily).toMatchObject({
			enabled: false,
			apiKeys: ["sk-new", "TAVILY_API_KEY"],
		});
		expect(harness.notifications.some(({ message }) => message.includes("saved and applied"))).toBe(true);
	});

	it("confirms dirty Esc without a Save option and discards without writing", async () => {
		const harness = createHarness(cwd, {
			selections: ["Discard changes"],
			custom: async () => ({ type: "esc-dirty" }),
		});

		await harness.commands.get("search-setup")!("", harness.ctx);

		expect(harness.select.mock.calls[0][0]).toBe("Unsaved Search Hub changes");
		expect(harness.select.mock.calls[0][1]).toEqual(["Discard changes", "Keep editing"]);
		expect(existsSync(globalConfigPath(home))).toBe(false);
		expect(harness.notifications.some(({ message }) => message.includes("saved and applied"))).toBe(false);
	});

	it("reports a project override after saving global config", async () => {
		writeJson(globalConfigPath(home), {
			backends: { tavily: { enabled: true, apiKeys: ["sk-global"] } },
		});
		writeJson(join(cwd, ".pi", "search.json"), {
			backends: { tavily: { enabled: true } },
		});
		const harness = createHarness(cwd, {
			custom: async (factory) => {
				const component = factory({ requestRender: vi.fn() }, makeTheme(), {}, vi.fn());
				component.handleInput?.("s");
				return { type: "close" };
			},
		});

		await harness.commands.get("search-setup")!("", harness.ctx);

		expect(harness.notifications.some(({ message }) => message.includes("project overrides remain effective"))).toBe(true);
		expect(existsSync(join(cwd, ".pi", "extension-data", "pi-search-hub", "config.json")) || existsSync(join(cwd, ".pi", "search.json"))).toBe(true);
	});

	it("falls back across readers in firecrawl → exa → parallel order", async () => {
		writeJson(globalConfigPath(home), {
			backends: { exa: { apiKeys: ["exa-fixture"] } },
		});
		const harness = createHarness(cwd);
		const webRead = harness.tools.get("web_read")!;
		await harness.events.get("session_start")!({ reason: "startup" }, harness.ctx);
		const onUpdate = vi.fn();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
			const url = String(input);
			if (url.includes("api.firecrawl.dev")) {
				return new Response("fixture upstream unavailable", { status: 503 });
			}
			if (url === "https://api.exa.ai/contents") {
				return Response.json({
					statuses: [{ id: "https://example.com", status: "success" }],
					results: [{ url: "https://example.com", title: "Example", text: "page content" }],
				});
			}
			throw new Error(`Unexpected request: ${url}`);
		});

		try {
			const result = await webRead.execute(
				"read-1",
				{ url: "https://example.com" },
				undefined,
				onUpdate,
				harness.ctx,
			);
			expect(result.details.reader).toBe("exa");
			expect(result.details.fallbackErrors[0]).toContain("firecrawl:");
			expect(onUpdate.mock.calls[0][0].details.reader).toBe("firecrawl");
			expect(harness.setStatus).not.toHaveBeenCalled();
			expect(webRead).not.toHaveProperty("parameters.properties.reader");
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("emits tool activity without creating footer status", async () => {
		writeJson(globalConfigPath(home), {
			backends: { tavily: { enabled: true } },
		});
		const harness = createHarness(cwd);
		await harness.events.get("session_start")!({ reason: "startup" }, harness.ctx);
		const onUpdate = vi.fn();

		await expect(harness.tools.get("web_search")!.execute(
			"search-1",
			{ query: "test" },
			undefined,
			onUpdate,
			harness.ctx,
		)).rejects.toThrow("All backends failed");

		expect(onUpdate.mock.calls[0][0].details.activity).toContain("searching");
		expect(onUpdate.mock.calls.at(-1)?.[0].details.activity).toContain("all backends failed");
		expect(harness.setStatus).not.toHaveBeenCalled();
	});

	it("rejects Parallel search without a key instead of using MCP", async () => {
		writeJson(globalConfigPath(home), {
			backends: { parallel: { enabled: true } },
		});
		const harness = createHarness(cwd);
		await harness.events.get("session_start")!({ reason: "startup" }, harness.ctx);

		await expect(harness.tools.get("web_search")!.execute(
			"search-parallel",
			{ query: "test" },
			undefined,
			undefined,
			harness.ctx,
		)).rejects.toThrow("Parallel backend not configured");
	});
});
