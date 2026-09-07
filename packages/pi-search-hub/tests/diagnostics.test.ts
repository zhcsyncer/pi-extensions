import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import searchHubExtension from "../extensions/search-hub.js";
import { clearCredentialCache, FALLBACK_ENV_MAP } from "../extensions/credentials.js";
import { clearCooldowns } from "../extensions/utils.js";
import { getExaUsagePath, getGlobalConfigPath, getLegacyProjectConfigPath, getProjectConfigPath } from "../extensions/paths.js";

const MISSING_ENV = "DIAGNOSTICS_TEST_UNSET_CREDENTIAL";
const PAGE_URL = "https://example.com/diagnostics";
const PAGE_TEXT = "Diagnostic fixture page content";

type ToolName = "web_search" | "web_read";
type ToolResult = {
	content: Array<{ type: string; text: string }>;
	details: Record<string, unknown> & { warnings?: string[]; errors?: string[]; fallbackErrors?: string[] };
};
type RegisteredTool = {
	name: string;
	execute(id: string, params: Record<string, unknown>, signal: undefined, onUpdate: undefined, ctx: ExtensionContext): Promise<ToolResult>;
};
type EventHandler = (event: { type: string; reason: string }, ctx: ExtensionContext) => void | Promise<void>;

function createContext(cwd: string, hasUI = true) {
	return {
		cwd,
		hasUI,
		mode: hasUI ? "tui" : "json",
		isProjectTrusted: () => true,
		modelRegistry: { getApiKeyForProvider: vi.fn(async () => undefined) },
		ui: { notify: vi.fn<(message: string, level: string) => void>() },
	};
}
type TestContext = ReturnType<typeof createContext>;

function createHarness() {
	const tools = new Map<string, RegisteredTool>();
	const events = new Map<string, EventHandler>();
	searchHubExtension({
		registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
		registerCommand() {},
		on: (name: string, handler: EventHandler) => events.set(name, handler),
	} as unknown as ExtensionAPI);
	return {
		execute(name: ToolName, ctx: TestContext, params: Record<string, unknown> = {}) {
			return tools.get(name)!.execute(name, {
				...(name === "web_search" ? { query: "diagnostic fixture", numResults: 1 } : { url: PAGE_URL }),
				...params,
			}, undefined, undefined, ctx as unknown as ExtensionContext);
		},
		start(ctx: TestContext) {
			return events.get("session_start")!({ type: "session_start", reason: "startup" }, ctx as unknown as ExtensionContext);
		},
	};
}

function writeJson(path: string, value: unknown) {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, JSON.stringify(value));
}

function corruptExaUsage() {
	mkdirSync(dirname(getExaUsagePath()), { recursive: true });
	writeFileSync(getExaUsagePath(), "{");
}

function exaReply() {
	return Response.json({
		results: [{ title: "Diagnostic fixture", url: PAGE_URL, text: PAGE_TEXT }],
		statuses: [{ id: PAGE_URL, status: "success" }],
	});
}

/** Only these fixture endpoints are supported; unexpected requests never reach the network. */
function successfulFetch(input: string | URL | Request): Response {
	const url = new URL(input instanceof Request ? input.url : String(input));
	if (url.origin === "https://api.exa.ai" && ["/search", "/contents"].includes(url.pathname)) return exaReply();
	if (url.origin === "https://s.jina.ai") {
		return Response.json({ data: [{ title: "Diagnostic fixture", url: PAGE_URL, description: PAGE_TEXT }] });
	}
	if (url.origin === "https://r.jina.ai") return new Response(PAGE_TEXT);
	throw new Error(`Unexpected fixture request: ${url.origin}${url.pathname}`);
}

function deferred<T>() {
	let resolve!: (value: T) => void;
	const promise = new Promise<T>((done) => { resolve = done; });
	return { promise, resolve };
}

describe("Search Hub diagnostics through registered tools", () => {
	let root: string;
	let cwd: string;
	let fetchMock: ReturnType<typeof vi.fn<typeof fetch>>;
	let terminalSpies: Array<{ mockRestore(): void }>;
	let assertNoTerminalOutput: () => void;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-search-diagnostics-"));
		cwd = join(root, "project");
		mkdirSync(cwd);
		vi.stubEnv("HOME", root);
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		for (const name of new Set([...Object.values(FALLBACK_ENV_MAP), MISSING_ENV])) vi.stubEnv(name, undefined);
		clearCredentialCache();
		clearCooldowns();
		writeJson(getGlobalConfigPath(), { backends: {} });
		fetchMock = vi.fn<typeof fetch>(async (input) => successfulFetch(input));
		vi.stubGlobal("fetch", fetchMock);
		const spies = [
			vi.spyOn(console, "warn").mockImplementation(() => {}),
			vi.spyOn(console, "error").mockImplementation(() => {}),
			vi.spyOn(console, "log").mockImplementation(() => {}),
			vi.spyOn(process.stderr, "write").mockImplementation(() => true),
			vi.spyOn(process.stdout, "write").mockImplementation(() => true),
		];
		terminalSpies = spies;
		assertNoTerminalOutput = () => {
			for (const spy of spies) expect(spy).not.toHaveBeenCalled();
		};
	});

	afterEach(() => {
		try {
			assertNoTerminalOutput();
		} finally {
			for (const spy of terminalSpies) spy.mockRestore();
			vi.unstubAllGlobals();
			vi.unstubAllEnvs();
			clearCredentialCache();
			clearCooldowns();
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("reports missing-env credentials once while every successful fallback retains its warning", async () => {
		writeJson(getProjectConfigPath(cwd), {
			defaultBackend: "serper",
			backends: { serper: { enabled: true, apiKey: MISSING_ENV }, jina: { enabled: true } },
		});
		const hub = createHarness();
		const ctx = createContext(cwd);
		const first = await hub.execute("web_search", ctx);
		clearCooldowns();
		const second = await hub.execute("web_search", ctx);

		expect(first.details).toMatchObject({ backend: "jina (fallback)", resultCount: 1 });
		expect(first.details.errors?.join(" ")).toContain("Serper backend not configured");
		expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/credential|environment|env.var/i), "warning");
		const message = ctx.ui.notify.mock.calls[0][0];
		expect(message).not.toContain(MISSING_ENV);
		expect(first.details.warnings).toEqual([message]);
		expect(second.details.warnings).toEqual([message]);
		expect(fetchMock.mock.calls.map(([url]) => new URL(String(url)).host)).toEqual(["s.jina.ai", "s.jina.ai"]);
	});

	it("keeps a failed shell credential command and its stderr out of diagnostics and fallback errors", async () => {
		writeJson(getProjectConfigPath(cwd), {
			defaultBackend: "serper",
			backends: {
				serper: { enabled: true, apiKey: "!printf 'credential-command-private-marker' >&2; exit 1" },
				jina: { enabled: true },
			},
		});
		const ctx = createContext(cwd);
		const result = await createHarness().execute("web_search", ctx);

		expect(result.details).toMatchObject({ backend: "jina (fallback)", resultCount: 1 });
		expect(result.details.errors?.join(" ")).toMatch(/credential|command/i);
		expect(JSON.stringify([result, ctx.ui.notify.mock.calls])).not.toContain("credential-command-private-marker");
		expect(JSON.stringify([result, ctx.ui.notify.mock.calls])).not.toContain("printf");
	});

	it("deduplicates corrupt Exa state across search and read precheck/increment without losing call details", async () => {
		writeJson(getProjectConfigPath(cwd), { backends: { exa: { enabled: true, apiKey: "diagnostics-exa-fixture" } } });
		corruptExaUsage();
		const hub = createHarness();
		const ctx = createContext(cwd);
		const search = await hub.execute("web_search", ctx, { backend: "exa" });
		const read = await hub.execute("web_read", ctx, { reader: "exa" });

		expect(search.details.resultCount).toBe(1);
		expect(read.content[0].text).toBe(PAGE_TEXT);
		expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Exa usage"), "warning");
		const message = ctx.ui.notify.mock.calls[0][0];
		expect(search.details.warnings).toEqual([message]);
		expect(read.details.warnings).toEqual([message]);
		expect(readFileSync(getExaUsagePath(), "utf8")).toBe("{");
	});

	it.each(["web_search", "web_read"] as const)("keeps corrupt-state warnings on headless %s success without touching UI", async (tool) => {
		writeJson(getProjectConfigPath(cwd), { backends: { exa: { enabled: true, apiKey: "diagnostics-exa-fixture" } } });
		corruptExaUsage();
		const ctx = createContext(cwd, false);
		const result = await createHarness().execute(tool, ctx, { backend: "exa", reader: "exa" });

		expect(result.content[0].text).toContain(PAGE_TEXT);
		expect(result.details.warnings).toEqual([expect.stringContaining("Exa usage")]);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("routes an Exa quota threshold warning to Pi and the successful search details", async () => {
		writeJson(getProjectConfigPath(cwd), { backends: { exa: { enabled: true, apiKey: "diagnostics-exa-fixture" } } });
		const now = new Date();
		writeJson(getExaUsagePath(), { count: 799, resetAt: new Date(now.getFullYear(), now.getMonth(), 1).toISOString() });
		const ctx = createContext(cwd);
		const result = await createHarness().execute("web_search", ctx, { backend: "exa" });

		expect(result.details.resultCount).toBe(1);
		expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/Exa quota.*800/), "warning");
		expect(result.details.warnings).toEqual([ctx.ui.notify.mock.calls[0][0]]);
	});

	it.each(["shared extension", "independent extensions"])("keeps overlapping call warnings attached to their own contexts: %s", async (scope) => {
		writeJson(getProjectConfigPath(cwd), {
			backends: { exa: { enabled: true, apiKey: "diagnostics-exa-fixture" }, jina: { apiKey: MISSING_ENV } },
		});
		corruptExaUsage();
		const firstHub = createHarness();
		const secondHub = scope === "shared extension" ? firstHub : createHarness();
		const firstCtx = createContext(cwd);
		const secondCtx = createContext(cwd);
		const searchEntered = deferred<void>();
		const readEntered = deferred<void>();
		const releaseSearch = deferred<Response>();
		const releaseRead = deferred<Response>();
		fetchMock.mockImplementation(async (input) => {
			if (String(input) === "https://api.exa.ai/search") {
				searchEntered.resolve();
				return releaseSearch.promise;
			}
			if (String(input).startsWith("https://r.jina.ai/")) {
				readEntered.resolve();
				return releaseRead.promise;
			}
			return successfulFetch(input);
		});
		const firstCall = firstHub.execute("web_search", firstCtx, { backend: "exa" });
		await searchEntered.promise;
		const secondCall = secondHub.execute("web_read", secondCtx, { reader: "jina" });
		await readEntered.promise;
		// Finish the older call while the newer call still owns an in-flight fetch.
		releaseSearch.resolve(exaReply());
		let search: ToolResult;
		try {
			search = await firstCall;
		} finally {
			releaseRead.resolve(new Response(PAGE_TEXT));
		}
		const read = await secondCall;

		expect(firstCtx.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Exa usage"), "warning");
		expect(secondCtx.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/credential|environment|env.var/i), "warning");
		expect(search.details.warnings).toEqual([firstCtx.ui.notify.mock.calls[0][0]]);
		expect(read.details.warnings).toEqual([secondCtx.ui.notify.mock.calls[0][0]]);
	});

	it("does not let one extension instance suppress another instance's identical Exa warning", async () => {
		writeJson(getProjectConfigPath(cwd), { backends: { exa: { enabled: true, apiKey: "diagnostics-exa-fixture" } } });
		corruptExaUsage();
		const first = createContext(cwd);
		const second = createContext(cwd);
		const [search, read] = await Promise.all([
			createHarness().execute("web_search", first, { backend: "exa" }),
			createHarness().execute("web_read", second, { reader: "exa" }),
		]);

		expect(first.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringContaining("Exa usage"), "warning");
		expect(second.ui.notify.mock.calls).toEqual(first.ui.notify.mock.calls);
		expect(search.details.warnings).toEqual(read.details.warnings);
	});

	it("preserves HTTP search fallback errors without converting ordinary failures to Pi warnings", async () => {
		writeJson(getProjectConfigPath(cwd), {
			defaultBackend: "serper",
			backends: { serper: { enabled: true, apiKey: "diagnostics-serper-fixture" }, jina: { enabled: true } },
		});
		fetchMock.mockImplementation(async (input) => String(input).startsWith("https://google.serper.dev/")
			? new Response("fixture upstream unavailable", { status: 503 }) : successfulFetch(input));
		const ctx = createContext(cwd);
		const result = await createHarness().execute("web_search", ctx);

		expect(result.details).toMatchObject({ backend: "jina (fallback)", resultCount: 1 });
		expect(result.details.errors).toEqual([expect.stringMatching(/serper:.*503.*fixture upstream unavailable/i)]);
		expect(result.content[0].text).toContain("fixture upstream unavailable");
		expect(result.details).not.toHaveProperty("warnings");
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("preserves reader fallback and explicit-reader rejection without notifying on HTTP failures", async () => {
		writeJson(getProjectConfigPath(cwd), {
			reader: "exa", readerFallback: ["jina"],
			backends: { exa: { apiKey: "diagnostics-exa-fixture" } },
		});
		fetchMock.mockImplementation(async (input) => String(input) === "https://api.exa.ai/contents"
			? new Response("fixture upstream unavailable", { status: 503 }) : successfulFetch(input));
		const hub = createHarness();
		const ctx = createContext(cwd);
		const result = await hub.execute("web_read", ctx);

		expect(result.content[0].text).toBe(PAGE_TEXT);
		expect(result.details.reader).toBe("jina");
		expect(result.details.fallbackErrors).toEqual([expect.stringMatching(/exa:.*503.*fixture upstream unavailable/i)]);
		expect(result.details).not.toHaveProperty("warnings");
		await expect(hub.execute("web_read", ctx, { reader: "exa" })).rejects.toThrow(/Exa contents.*503/);
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("drains a headless startup migration notice into only the next tool result", async () => {
		writeJson(getLegacyProjectConfigPath(cwd), { backends: { jina: { enabled: true } } });
		const hub = createHarness();
		const ctx = createContext(cwd, false);
		await hub.start(ctx);
		const first = await hub.execute("web_read", ctx, { reader: "jina" });
		const next = await hub.execute("web_read", ctx, { reader: "jina" });

		expect(first.content[0].text).toBe(PAGE_TEXT);
		expect(first.details.warnings).toEqual([expect.stringMatching(/migrated.*project config/i)]);
		expect(next.details).not.toHaveProperty("warnings");
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("sanitizes real config migration notices before displaying or retaining them", async () => {
		const unsafeField = "\u001b[31mapi_key=fixture-private-token\u001b[0m\r\npassword=fixture-private-password\u0007";
		writeJson(getProjectConfigPath(cwd), { backends: { jina: { enabled: true } }, [unsafeField]: true });
		const ctx = createContext(cwd);
		const result = await createHarness().execute("web_read", ctx, { reader: "jina" });

		expect(ctx.ui.notify).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/upgraded.*project config/i), "warning");
		const notice = ctx.ui.notify.mock.calls[0][0];
		expect(notice).not.toMatch(/[\u0000-\u001f\u007f-\u009f]/);
		expect(notice).not.toContain("fixture-private-token");
		expect(notice).not.toContain("fixture-private-password");
		expect(notice.length).toBeLessThanOrEqual(300);
		expect(result.details.warnings).toEqual([notice]);
	});

	it("resets reporter session deduplication and discards stale pending notices", async () => {
		const { createDiagnosticReporter } = await import("../extensions/diagnostics.js");
		const reporter = createDiagnosticReporter();
		const ctx = createContext(cwd);
		const asContext = ctx as unknown as ExtensionContext;
		reporter.sink(asContext)("Search Hub session notice");
		reporter.sink(createContext(cwd, false) as unknown as ExtensionContext)("Search Hub stale pending notice");
		reporter.reset();
		const warnings: string[] = [];
		reporter.sink(asContext, warnings)("Search Hub session notice");

		expect(ctx.ui.notify.mock.calls).toEqual([
			["Search Hub session notice", "warning"],
			["Search Hub session notice", "warning"],
		]);
		expect(warnings).toEqual(["Search Hub session notice"]);
	});

	it("retains diagnostics if a closed UI rejects notification instead of throwing or printing", async () => {
		const { createDiagnosticReporter } = await import("../extensions/diagnostics.js");
		const ctx = createContext(cwd);
		ctx.ui.notify.mockImplementation(() => { throw new Error("UI already closed"); });
		const warnings: string[] = [];
		const sink = createDiagnosticReporter().sink(ctx as unknown as ExtensionContext, warnings);

		expect(() => sink("Search Hub unavailable usage state")).not.toThrow();
		expect(warnings).toEqual(["Search Hub unavailable usage state"]);
	});
});
