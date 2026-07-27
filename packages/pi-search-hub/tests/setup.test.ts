import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import searchHubExtension from "../extensions/search-hub.js";
import { FALLBACK_ENV_MAP } from "../extensions/credentials.js";
import type { SearchConfig } from "../extensions/types.js";

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

function createHarness(cwd: string, selections: Selection[] = [], inputs: Array<string | undefined> = []) {
	const commands = new Map<string, CommandHandler>();
	const events = new Map<string, EventHandler>();
	const tools = new Map<string, RegisteredTool>();
	const notifications: Array<{ message: string; level: string }> = [];
	const setStatus = vi.fn();
	const select = vi.fn(async (_title: string, options: string[]) => {
		const next = selections.shift();
		return typeof next === "function" ? next(options) : next;
	});
	const input = vi.fn(async () => inputs.shift());
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
			input,
			setStatus,
			notify(message: string, level: string) {
				notifications.push({ message, level });
			},
		},
	};

	return { commands, events, tools, ctx, notifications, select, input, setStatus };
}

function pickOption(fragment: string): Selection {
	return (options) => options.find((option) => option.includes(fragment));
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
		for (const name of new Set([...Object.values(FALLBACK_ENV_MAP), "JINA_API_KEY", "SERPER_API_KEY"])) {
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
		rmSync(home, { recursive: true, force: true });
	});

	it("integrates readiness status into search-setup and removes search-status", async () => {
		writeJson(globalConfigPath(home), {
			backends: {
				jina: { enabled: true, apiKey: "JINA_API_KEY" },
				serper: { enabled: true, apiKey: "SERPER_API_KEY" },
				tavily: { enabled: true, apiKey: "   " },
				"openai-codex": { enabled: true },
			},
		});
		const harness = createHarness(cwd, ["🔌 Backends", "↩ Back", "✅ Close"]);

		await harness.commands.get("search-setup")!("", harness.ctx);

		expect(harness.commands.has("search-status")).toBe(false);
		expect(harness.select.mock.calls[0][0]).toContain("Search:");
		const homeOptions = harness.select.mock.calls[0][1] as string[];
		expect(homeOptions).toContain("🔌 Backends");
		expect(homeOptions.some((option) => option.includes("Jina AI"))).toBe(false);
		const backendOptions = harness.select.mock.calls[1][1] as string[];
		expect(backendOptions.find((option) => option.includes("Jina AI"))).toContain("auth — optional");
		expect(backendOptions.find((option) => option.includes("Jina AI"))).not.toContain("JINA_API_KEY");
		expect(backendOptions.find((option) => option.includes("Serper"))).toContain("auth ✗ missing");
		expect(backendOptions.find((option) => option.includes("Tavily"))).toContain("auth ✗ missing");
		expect(backendOptions.find((option) => option.includes("OpenAI Codex"))).toContain("auth ✗ run /login openai-codex");
	});

	it("presents stored OpenAI Codex auth as a Pi login credential", async () => {
		writeJson(globalConfigPath(home), {
			backends: { "openai-codex": { enabled: true } },
		});
		const harness = createHarness(cwd, ["🔌 Backends", "↩ Back", "✅ Close"]);
		harness.ctx.modelRegistry.getProviderAuthStatus = () => ({ configured: true, source: "stored" });

		await harness.commands.get("search-setup")!("", harness.ctx);

		const options = harness.select.mock.calls[1][1] as string[];
		expect(options.find((option) => option.includes("OpenAI Codex"))).toContain("auth ✓ Pi /login");
	});

	it("shows global/effective state and re-enables a backend with retained credentials", async () => {
		writeJson(globalConfigPath(home), {
			backends: {
				serper: { enabled: true, apiKey: "sk-retained", maxResults: 7 },
			},
		});
		const disableHarness = createHarness(cwd, [
			"🔌 Backends",
			pickOption("Serper"),
			"Disable globally (keep credentials)",
			"↩ Back",
			"💾 Save & apply",
			"✅ Close",
		]);

		await disableHarness.commands.get("search-setup")!("", disableHarness.ctx);

		expect(disableHarness.select.mock.calls[2][0]).toContain("Global draft:         [ON] auth ✓ saved key");
		expect(disableHarness.select.mock.calls[2][0]).toContain("Effective after save: [ON] auth ✓ saved key");
		expect(readGlobalConfig(home).backends?.serper).toEqual({
			enabled: false,
			apiKey: "sk-retained",
			maxResults: 7,
		});

		const enableHarness = createHarness(cwd, [
			"🔌 Backends",
			pickOption("Serper"),
			"Enable in global configuration",
			"↩ Back",
			"💾 Save & apply",
			"✅ Close",
		]);
		await enableHarness.commands.get("search-setup")!("", enableHarness.ctx);
		expect(enableHarness.input).not.toHaveBeenCalled();
		expect(readGlobalConfig(home).backends?.serper).toEqual({
			enabled: true,
			apiKey: "sk-retained",
			maxResults: 7,
		});
		expect(enableHarness.notifications.some(({ message }) => message.includes("saved and applied"))).toBe(true);
		expect(enableHarness.setStatus).not.toHaveBeenCalled();
	});

	it("does not enable a required-key backend for whitespace input", async () => {
		const harness = createHarness(
			cwd,
			["🔌 Backends", pickOption("Serper"), "Enable in global configuration", "↩ Back", "✅ Close"],
			["   "],
		);

		await harness.commands.get("search-setup")!("", harness.ctx);

		expect(existsSync(globalConfigPath(home))).toBe(false);
		expect(harness.notifications).toContainEqual({
			level: "warning",
			message: expect.stringContaining("Draft unchanged"),
		});
	});

	it("trims required keys and enables optional-key backends without empty fields", async () => {
		const required = createHarness(
			cwd,
			[
				"🔌 Backends",
				pickOption("Serper"),
				"Enable in global configuration",
				"↩ Back",
				"💾 Save & apply",
				"✅ Close",
			],
			["  sk-test-value  "],
		);
		await required.commands.get("search-setup")!("", required.ctx);
		expect(readGlobalConfig(home).backends?.serper).toEqual({ enabled: true, apiKey: "sk-test-value" });

		rmSync(globalConfigPath(home));
		const optional = createHarness(
			cwd,
			[
				"🔌 Backends",
				pickOption("Jina AI"),
				"Enable in global configuration",
				"↩ Back",
				"💾 Save & apply",
				"✅ Close",
			],
			[undefined],
		);
		await optional.commands.get("search-setup")!("", optional.ctx);
		expect(readGlobalConfig(home).backends?.jina).toEqual({ enabled: true });
		expect(readGlobalConfig(home).backends?.jina).not.toHaveProperty("apiKey");
	});

	it("updates and removes a saved key independently from the backend switch", async () => {
		writeJson(globalConfigPath(home), {
			backends: { serper: { enabled: false, apiKey: "sk-old" } },
		});
		const updateHarness = createHarness(
			cwd,
			[
				"🔌 Backends",
				pickOption("Serper"),
				"Update API key or reference",
				"↩ Back",
				"💾 Save & apply",
				"✅ Close",
			],
			["  sk-new  "],
		);
		await updateHarness.commands.get("search-setup")!("", updateHarness.ctx);
		expect(readGlobalConfig(home).backends?.serper).toMatchObject({ enabled: false, apiKey: "sk-new" });

		const removeHarness = createHarness(cwd, [
			"🔌 Backends",
			pickOption("Serper"),
			"Remove saved API key or reference",
			"↩ Back",
			"💾 Save & apply",
			"✅ Close",
		]);
		await removeHarness.commands.get("search-setup")!("", removeHarness.ctx);
		expect(readGlobalConfig(home).backends?.serper).toEqual({ enabled: false });
	});

	it("bulk-enables only ready keyless backends", async () => {
		const harness = createHarness(cwd, [
			"🔌 Backends",
			"⚡ Enable ready keyless backends",
			"↩ Back",
			"💾 Save & apply",
			"✅ Close",
		]);
		await harness.commands.get("search-setup")!("", harness.ctx);

		const backends = readGlobalConfig(home).backends;
		for (const backend of ["duckduckgo", "jina", "marginalia", "exa_mcp"]) {
			expect(backends?.[backend]?.enabled).toBe(true);
		}
		expect(backends?.searxng).toBeUndefined();
	});

	it("keeps edits in a shared draft and discards them without writing", async () => {
		const harness = createHarness(cwd, [
			"🖥 Output",
			pickOption("Compact output:"),
			"On",
			"↩ Back",
			"✅ Close",
			"Discard changes",
		]);

		await harness.commands.get("search-setup")!("", harness.ctx);

		expect(existsSync(globalConfigPath(home))).toBe(false);
		expect(harness.select.mock.calls[4][0]).toContain("Unsaved changes");
		expect(harness.notifications.some(({ message }) => message.includes("saved and applied"))).toBe(false);
	});

	it("can save the shared draft from the close confirmation", async () => {
		const harness = createHarness(cwd, [
			"🖥 Output",
			pickOption("Compact output:"),
			"On",
			"↩ Back",
			"✅ Close",
			"Save & apply",
		]);

		await harness.commands.get("search-setup")!("", harness.ctx);

		expect(readGlobalConfig(home).compact).toBe(true);
		expect(harness.notifications.some(({ message }) => message.includes("saved and applied"))).toBe(true);
	});

	it("reports a project override when it keeps a globally disabled backend enabled", async () => {
		writeJson(globalConfigPath(home), {
			backends: { serper: { enabled: true, apiKey: "sk-global" } },
		});
		writeJson(join(cwd, ".pi", "search.json"), {
			backends: { serper: { enabled: true } },
		});
		const harness = createHarness(cwd, [
			"🔌 Backends",
			pickOption("Serper"),
			"Disable globally (keep credentials)",
			"↩ Back",
			"💾 Save & apply",
			"✅ Close",
		]);

		await harness.commands.get("search-setup")!("", harness.ctx);

		expect(readGlobalConfig(home).backends?.serper?.enabled).toBe(false);
		expect(harness.notifications.some(({ message }) => message.includes("project overrides remain effective"))).toBe(true);
	});

	it("presents search mode as one setting and removes legacy status/cache fields on save", async () => {
		writeJson(globalConfigPath(home), {
			showStatus: true,
			cacheTtl: 300000,
			cacheMax: 100,
			backends: { duckduckgo: { enabled: true } },
		});
		const harness = createHarness(cwd, [
			"🔀 Search routing",
			pickOption("Search mode:"),
			"Targeted combine",
			"↩ Back",
			"💾 Save & apply",
			"✅ Close",
		]);

		await harness.commands.get("search-setup")!("", harness.ctx);

		const saved = JSON.parse(readFileSync(globalConfigPath(home), "utf-8")) as Record<string, unknown>;
		expect(saved).toMatchObject({ combine: true, combineMode: "targeted" });
		expect(saved).not.toHaveProperty("showStatus");
		expect(saved).not.toHaveProperty("cacheTtl");
		expect(saved).not.toHaveProperty("cacheMax");
	});

	it("configures ordered reader fallbacks and keeps the previous default when switching", async () => {
		const fallbackHarness = createHarness(
			cwd,
			[
				"📖 Web reading",
				pickOption("Reader fallback order:"),
				"Edit ordered fallback list",
				"↩ Back",
				"💾 Save & apply",
				"✅ Close",
			],
			["firecrawl, exa_mcp, jina"],
		);
		await fallbackHarness.commands.get("search-setup")!("", fallbackHarness.ctx);
		expect(readGlobalConfig(home).reader).toBeUndefined();
		expect(readGlobalConfig(home).readerFallback).toEqual(["firecrawl", "exa_mcp"]);

		const defaultHarness = createHarness(cwd, [
			"📖 Web reading",
			pickOption("Default reader:"),
			"Firecrawl (firecrawl)",
			"↩ Back",
			"💾 Save & apply",
			"✅ Close",
		]);
		await defaultHarness.commands.get("search-setup")!("", defaultHarness.ctx);
		expect(readGlobalConfig(home).reader).toBe("firecrawl");
		expect(readGlobalConfig(home).readerFallback).toEqual(["jina", "exa_mcp"]);
	});

	it("falls back across configured readers but honors an explicit reader", async () => {
		writeJson(globalConfigPath(home), {
			reader: "exa",
			readerFallback: ["jina"],
		});
		const harness = createHarness(cwd);
		const webRead = harness.tools.get("web_read")!;
		await harness.events.get("session_start")!({ reason: "startup" }, harness.ctx);
		const onUpdate = vi.fn();
		const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue({
			ok: true,
			status: 200,
			headers: new Headers(),
			text: async () => "page content",
		} as Response);

		try {
			const result = await webRead.execute(
				"read-1",
				{ url: "https://example.com", displaySummary: "Read example" },
				undefined,
				onUpdate,
				harness.ctx,
			);
			expect(result.details.reader).toBe("jina");
			expect(result.details.fallbackErrors[0]).toContain("exa:");
			expect(onUpdate.mock.calls.map(([update]) => update.details.reader)).toEqual(["exa", "exa", "jina", "jina"]);
			expect(harness.setStatus).not.toHaveBeenCalled();

			fetchSpy.mockClear();
			await expect(webRead.execute(
				"read-2",
				{ url: "https://example.com", reader: "exa", displaySummary: "Read with Exa" },
				undefined,
				onUpdate,
				harness.ctx,
			)).rejects.toThrow("Exa reader selected but no API key configured");
			expect(fetchSpy).not.toHaveBeenCalled();
		} finally {
			fetchSpy.mockRestore();
		}
	});

	it("resolves Codex auth through the current Pi model registry", async () => {
		const harness = createHarness(cwd);
		const onUpdate = vi.fn();

		await expect(harness.tools.get("web_search")!.execute(
			"search-codex",
			{ query: "test", backend: "openai-codex", displaySummary: "Search with Codex" },
			undefined,
			onUpdate,
			harness.ctx,
		)).rejects.toThrow("OpenAI Codex authentication not found");

		expect(harness.ctx.modelRegistry.getApiKeyForProvider).toHaveBeenCalledWith("openai-codex");
	});

	it("emits tool activity without creating footer status", async () => {
		const harness = createHarness(cwd);
		await harness.events.get("session_start")!({ reason: "startup" }, harness.ctx);
		const onUpdate = vi.fn();

		await expect(harness.tools.get("web_search")!.execute(
			"search-1",
			{ query: "test", backend: "serper", displaySummary: "Search test" },
			undefined,
			onUpdate,
			harness.ctx,
		)).rejects.toThrow("Serper backend not configured");

		expect(onUpdate).toHaveBeenCalledTimes(2);
		expect(onUpdate.mock.calls[0][0].details.activity).toContain("searching");
		expect(onUpdate.mock.calls[1][0].details.activity).toContain("failed");
		expect(harness.setStatus).not.toHaveBeenCalled();
	});
});
