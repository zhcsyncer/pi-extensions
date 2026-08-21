import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findConflictingUsageCommand } from "../src/conflict.ts";
import { createLedgerStore, parseUsageLine, serializeUsageRecord } from "../src/ledger/store.ts";
import { getMeterPaths } from "../src/paths.ts";
import type { UsageRecord } from "../src/ledger/types.ts";

const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let agentDir: string;

beforeEach(() => {
	agentDir = mkdtempSync(join(tmpdir(), "pi-meter-ext-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;
});

afterEach(() => {
	rmSync(agentDir, { recursive: true, force: true });
	if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
	else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	vi.resetModules();
	vi.restoreAllMocks();
});

type Handler = (event: any, ctx: ExtensionContext) => unknown | Promise<unknown>;

interface TestCustomComponent {
	render: (width: number) => string[];
	invalidate: () => void;
	handleInput?: (data: string) => void;
}

type TestCustomFactory = (
	tui: { requestRender: () => void },
	theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
	keybindings: unknown,
	done: (value?: unknown) => void,
) => TestCustomComponent;

function harness(options: {
	hasUI?: boolean;
	mode?: "tui" | "print";
	sessionFile?: string;
	model?: { provider?: string; id?: string };
	getApiKeyForProvider?: (provider: string) => Promise<string | undefined>;
	customInputs?: string[];
} = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const widgets = new Map<string, { content: unknown; placement?: string }>();
	const statuses = new Map<string, string>();
	const notifications: Array<{ message: string; type?: string }> = [];
	const customComponents: TestCustomComponent[] = [];
	const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
	const pi = {
		on(name: string, handler: Handler) {
			const list = handlers.get(name) ?? [];
			list.push(handler);
			handlers.set(name, list);
		},
		registerCommand(name: string, definition: unknown) {
			commands.set(name, definition);
		},
		getCommands() {
			return [];
		},
	} as unknown as ExtensionAPI;
	const ctx = {
		hasUI: options.hasUI ?? false,
		mode: options.mode ?? (options.hasUI ? "tui" : "print"),
		cwd: "/work",
		model: options.model ?? { provider: "xai", id: "grok-4" },
		modelRegistry: {
			getApiKeyForProvider: options.getApiKeyForProvider ?? (async () => undefined),
		},
		sessionManager: {
			getSessionFile: () => options.sessionFile,
			getSessionId: () => "sess",
		},
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			theme,
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			setWidget: (key: string, content: unknown, widgetOptions?: { placement?: string }) => {
				if (content === undefined) widgets.delete(key);
				else widgets.set(key, { content, placement: widgetOptions?.placement });
			},
			custom: async (factory: TestCustomFactory) => {
				let result: unknown;
				const component = factory({ requestRender() {} }, theme, {}, (value) => { result = value; });
				customComponents.push(component);
				for (const input of options.customInputs ?? []) component.handleInput?.(input);
				return result;
			},
		},
	} as unknown as ExtensionContext;
	return { pi, ctx, handlers, commands, widgets, statuses, notifications, customComponents };
}

describe("conflict detection", () => {
	it("warns when @pi-plugins/usage already owns /usage", () => {
		expect(findConflictingUsageCommand([
			{
				name: "usage",
				source: "extension",
				sourceInfo: { path: "/npm/node_modules/@pi-plugins/usage/dist/index.mjs", source: "npm:@pi-plugins/usage", scope: "user", origin: "package" },
			},
		])?.sourceInfo.source).toContain("@pi-plugins/usage");
		expect(findConflictingUsageCommand([
			{
				name: "usage",
				source: "extension",
				sourceInfo: { path: "/repo/packages/pi-meter/extensions/meter.ts", source: "pi-meter", scope: "user", origin: "package" },
			},
		])).toBeUndefined();
	});
});

describe("extension runtime", () => {
	it("registers only /usage", async () => {
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, commands } = harness();
		piMeter(pi);
		expect([...commands.keys()]).toEqual(["usage"]);
	});

	it("exposes only the consolidated footer and quota arguments", async () => {
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, commands } = harness();
		piMeter(pi);
		const definition = commands.get("usage");
		const values = definition.getArgumentCompletions("").map((item: { value: string }) => item.value);
		expect(values).toContain("footer");
		expect(values).toContain("quota");
		expect(values).toContain("quota refresh");
		for (const removed of [
			"quota on",
			"quota off",
			"quota used",
			"quota remaining",
			"footer today-spend",
			"footer today-tokens",
			"footer today-cost",
			"footer budget",
			"footer model",
			"footer off",
		]) {
			expect(values).not.toContain(removed);
		}
	});

	it("appends a local ledger row on message_end even without a session file", async () => {
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers } = harness({ hasUI: false, mode: "print" });
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await handlers.get("message_end")?.[0]?.({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "xai",
				model: "grok-4",
				timestamp: 1_700_000_000_000,
				usage: { input: 11, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 20, cost: { total: 0.01 } },
			},
		}, ctx);
		const raw = readFileSync(getMeterPaths(agentDir).usageFile, "utf8");
		expect(raw).toContain("xai/grok-4");
		expect(raw).toContain("ephemeral");
		expect(raw).toContain("11");
		expect(raw).not.toContain("creditUsagePercent");
	});

	it("does not import a live-captured turn when the session entry timestamp is later", async () => {
		const messageTs = 1_700_000_000_000;
		const sid = "hist-sess";
		const sessionFile = join(agentDir, "sessions", `${sid}.jsonl`);
		mkdirSync(join(agentDir, "sessions"), { recursive: true });
		writeFileSync(sessionFile, `${JSON.stringify({
			type: "message",
			timestamp: new Date(messageTs + 30_000).toISOString(),
			message: {
				role: "assistant",
				provider: "xai",
				model: "grok-4",
				timestamp: messageTs,
				usage: { input: 11, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 20, cost: { total: 0.01 } },
			},
		})}\n`);
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, commands, notifications } = harness({
			hasUI: true,
			mode: "print",
			sessionFile,
		});
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await handlers.get("message_end")?.[0]?.({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "xai",
				model: "grok-4",
				timestamp: messageTs,
				usage: { input: 11, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 20, cost: { total: 0.01 } },
			},
		}, ctx);
		await commands.get("usage").handler("import", ctx);
		const rows = readFileSync(getMeterPaths(agentDir).usageFile, "utf8").trim().split("\n").map(parseUsageLine);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.ts).toBe(messageTs);
		expect(notifications.some((item) => item.message.includes("Nothing new to import"))).toBe(true);
	});

	it("collapses already-written live/import duplicates when the ledger opens", async () => {
		const messageTs = 1_700_000_000_000;
		const live: UsageRecord = {
			ts: messageTs,
			sid: "hist-sess",
			cwd: "/work",
			model: "xai/grok-4",
			in: 11,
			out: 2,
			cR: 3,
			cW: 4,
			tot: 20,
			cost: 0.01,
			costKnown: true,
		};
		const duplicate = { ...live, ts: messageTs + 30_000 };
		const paths = getMeterPaths(agentDir);
		mkdirSync(paths.dataDir, { recursive: true });
		writeFileSync(paths.usageFile, `${JSON.stringify(serializeUsageRecord(live))}\n${JSON.stringify(serializeUsageRecord(duplicate))}\n`);
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, notifications } = harness({ hasUI: true, mode: "print" });
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		const rows = readFileSync(paths.usageFile, "utf8").trim().split("\n").map(parseUsageLine);
		expect(rows).toHaveLength(1);
		expect(rows[0]?.ts).toBe(messageTs);
		expect(notifications.some((item) => item.message.includes("duplicate usage records"))).toBe(true);
	});

	it("publishes one footer status instead of a widget row", async () => {
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, widgets, statuses } = harness({ hasUI: true, mode: "tui" });
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		expect(widgets.size).toBe(0);
		expect(statuses.get("pi-meter")).toContain("24h");
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});

	it("writes all footer settings from one dashboard into config.json", async () => {
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, commands, statuses, notifications, customComponents } = harness({
			hasUI: true,
			mode: "tui",
			customInputs: [" ", "\x1b[B", " ", "\x1b[B", " ", "q"],
		});
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await handlers.get("message_end")?.[0]?.({
			type: "message_end",
			message: {
				role: "assistant",
				provider: "xai",
				model: "grok-4",
				timestamp: Date.now(),
				usage: { input: 12400, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 12400, cost: { total: 0.18 } },
			},
		}, ctx);
		await commands.get("usage").handler("footer", ctx);
		expect(customComponents).toHaveLength(1);
		expect(notifications).toEqual([]);
		expect(statuses.get("pi-meter")).toContain("24h 12.4k");
		const saved = JSON.parse(readFileSync(getMeterPaths(agentDir).configFile, "utf8"));
		expect(saved).toMatchObject({
			footer: {
				local: "today-tokens",
				quota: { visible: false, polarity: "used" },
			},
			quota: { snapshotTtlMs: 60_000, minRefreshIntervalMs: 30_000 },
		});
		expect(saved.quota).not.toHaveProperty("polarity");
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});

	it("migrates existing footer quota settings into the grouped config", async () => {
		const paths = getMeterPaths(agentDir);
		mkdirSync(paths.dataDir, { recursive: true });
		writeFileSync(paths.configFile, `${JSON.stringify({
			footer: { local: "model", quota: false },
			quota: { polarity: "used", snapshotTtlMs: 90_000, minRefreshIntervalMs: 45_000 },
		})}\n`);
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers } = harness({ hasUI: true, mode: "tui" });
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		const migrated = JSON.parse(readFileSync(paths.configFile, "utf8"));
		expect(migrated).toEqual({
			footer: {
				local: "model",
				quota: { visible: false, polarity: "used" },
			},
			quota: { snapshotTtlMs: 90_000, minRefreshIntervalMs: 45_000 },
			ledger: { windowMode: "rolling" },
		});
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});

	it("rejects removed footer and quota setting arguments", async () => {
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, commands, notifications } = harness({ hasUI: true, mode: "tui" });
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await commands.get("usage").handler("quota off", ctx);
		expect(notifications.at(-1)?.message).toBe("Unknown /usage quota argument. Try refresh.");
		await commands.get("usage").handler("footer today-tokens", ctx);
		expect(notifications.at(-1)?.message).toContain("Unknown /usage argument");
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});

	it("migrates analytics/usage.jsonl and folds footer.json into config.json", async () => {
		const legacy = join(agentDir, "analytics");
		mkdirSync(legacy, { recursive: true });
		writeFileSync(join(legacy, "usage.jsonl"), "[1,\"s\",\"/p\",\"xai/grok\",1,2,3,4,10,0.1,1]\n");
		writeFileSync(join(legacy, "footer.json"), "{\"preset\":\"today-tokens\"}\n");
		const { store, migration } = await createLedgerStore(agentDir);
		expect(migration).toContain("usage.jsonl");
		const records = await store.readAll();
		expect(records[0]).toMatchObject({ model: "xai/grok", in: 1, out: 2, cR: 3, cW: 4 });
		expect(() => readFileSync(join(legacy, "usage.jsonl"))).toThrow();
		const { loadMeterConfig } = await import("../src/config.ts");
		const loaded = await loadMeterConfig(agentDir);
		expect(loaded.config.footer.local).toBe("today-tokens");
		expect(() => readFileSync(join(legacy, "footer.json"))).toThrow();
	});

	it("idle TUI status follows another session's local cache without calling APIs", async () => {
		const polls: Array<() => unknown> = [];
		vi.spyOn(globalThis, "setInterval").mockImplementation((fn) => {
			polls.push(fn as () => unknown);
			return Object.assign(1, { unref() {} }) as unknown as ReturnType<typeof setInterval>;
		});
		vi.spyOn(globalThis, "clearInterval").mockImplementation(() => {});
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({
			xai: { type: "oauth", refresh: "x", access: "y" },
		})}\n`);
		const paths = getMeterPaths(agentDir);
		mkdirSync(paths.dataDir, { recursive: true });
		const writeQuota = (usedPercent: number, fetchedAt = Date.now()) => {
			writeFileSync(paths.quotaFile, `${JSON.stringify({
				version: 1,
				ttlMs: 60_000,
				minIntervalMs: 30_000,
				providers: {
					supergrok: {
						provider: "supergrok",
						title: "SuperGrok",
						primary: { id: "weekly", label: "Weekly credits", usedPercent, resetsAt: "2026-08-17T16:55:31.897Z" },
						windows: [{ id: "weekly", label: "Weekly credits", usedPercent, resetsAt: "2026-08-17T16:55:31.897Z" }],
						fetchedAt,
						ok: true,
					},
				},
				lastAttemptAt: { supergrok: fetchedAt },
			})}\n`);
		};
		writeQuota(51);
		const { STATUS_CACHE_POLL_MS } = await import("../src/chrome/status-cache.ts");
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, statuses } = harness({ hasUI: true, mode: "tui" });
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		expect(statuses.get("pi-meter")).toContain("49%");
		expect(statuses.get("pi-meter")).not.toContain("stale");
		expect(setInterval).toHaveBeenCalledWith(expect.any(Function), STATUS_CACHE_POLL_MS);
		expect(polls).toHaveLength(1);

		writeQuota(80);
		writeFileSync(paths.usageFile, `${JSON.stringify([Date.now(), "other", "/p", "xai/grok-4", 12400, 0, 0, 0, 12400, 0.18, 1])}\n`);
		await polls[0]?.();
		expect(statuses.get("pi-meter")).toContain("24h 12.4k $0.18");
		expect(statuses.get("pi-meter")).toContain("20%");
		expect(fetchSpy).not.toHaveBeenCalled();

		writeQuota(90, Date.now() - 120_000);
		await polls[0]?.();
		expect(statuses.get("pi-meter")).toContain("10%");
		expect(statuses.get("pi-meter")).toContain("stale");
		expect(fetchSpy).not.toHaveBeenCalled();

		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
		writeQuota(5);
		await polls[0]?.();
		expect(statuses.has("pi-meter")).toBe(false);
	});

	it("keeps a supported provider's quota window in the footer", async () => {
		writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({
			xai: { type: "oauth", refresh: "x", access: "y" },
		})}\n`);
		const paths = getMeterPaths(agentDir);
		mkdirSync(paths.dataDir, { recursive: true });
		writeFileSync(paths.quotaFile, `${JSON.stringify({
			version: 1,
			ttlMs: 60_000,
			minIntervalMs: 30_000,
			providers: {
				supergrok: {
					provider: "supergrok",
					title: "SuperGrok",
					primary: { id: "weekly", label: "Weekly credits", usedPercent: 51, resetsAt: "2026-08-17T16:55:31.897Z" },
					windows: [{ id: "weekly", label: "Weekly credits", usedPercent: 51, resetsAt: "2026-08-17T16:55:31.897Z" }],
					fetchedAt: Date.now(),
					ok: true,
				},
			},
			lastAttemptAt: {},
		})}\n`);
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, statuses } = harness({ hasUI: true, mode: "tui" });
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		expect(statuses.get("pi-meter")).toContain("24h");
		expect(statuses.get("pi-meter")).toContain("xai week left");
		expect(statuses.get("pi-meter")).toContain("49%");
		expect(statuses.get("pi-meter")).not.toContain("no quota window");
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});

	it("does not show another provider's quota window for local ollama", async () => {
		const paths = getMeterPaths(agentDir);
		mkdirSync(paths.dataDir, { recursive: true });
		writeFileSync(paths.quotaFile, `${JSON.stringify({
			version: 1,
			ttlMs: 60_000,
			minIntervalMs: 30_000,
			providers: {
				claude: {
					provider: "claude",
					title: "Claude",
					primary: { id: "session", label: "Session (5h)", usedPercent: 42, resetsAt: "2026-08-15T17:00:00Z" },
					windows: [{ id: "session", label: "Session (5h)", usedPercent: 42, resetsAt: "2026-08-15T17:00:00Z" }],
					fetchedAt: Date.now(),
					ok: true,
				},
			},
			lastAttemptAt: {},
		})}\n`);
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, statuses } = harness({
			hasUI: true,
			mode: "tui",
			model: { provider: "ollama", id: "llama3" },
		});
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		expect(statuses.get("pi-meter")).toContain("24h");
		expect(statuses.get("pi-meter")).toContain("ollama");
		expect(statuses.get("pi-meter")).toContain("no quota window");
		expect(statuses.get("pi-meter")).not.toContain("5h left");
		expect(statuses.get("pi-meter")).not.toContain("week left");
		expect(statuses.get("pi-meter")).not.toContain("█");
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});

	it("shows Ollama Cloud session remaining in the footer after a refresh", async () => {
		writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({
			"ollama-cloud": { type: "api_key", key: "stored-but-not-used" },
		})}\n`);
		const fetchSpy = vi.fn(async (url: string) => {
			if (String(url).includes("ollama.com/api/usage")) {
				return {
					ok: true,
					status: 200,
					json: async () => ({ limits: { session: { usage: 0.72 }, weekly: { usage: 0.1 } }, plan: "pro" }),
				};
			}
			return { ok: false, status: 401, json: async () => ({}) };
		});
		vi.stubGlobal("fetch", fetchSpy);
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, statuses } = harness({
			hasUI: true,
			mode: "tui",
			model: { provider: "ollama-cloud", id: "glm-5.2" },
			getApiKeyForProvider: async (provider) => provider === "ollama-cloud" ? "ollama-live-key" : undefined,
		});
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await handlers.get("agent_settled")?.[0]?.({ type: "agent_settled" }, ctx);
		const footer = statuses.get("pi-meter");
		expect(footer).toContain("24h");
		expect(footer).toContain("ollama 5h left");
		expect(footer).toContain("28%");
		expect(footer).not.toContain("(");
		expect(footer).not.toContain("no quota window");
		expect(fetchSpy).toHaveBeenCalledWith(
			expect.stringContaining("ollama.com/api/usage"),
			expect.anything(),
		);
		expect(JSON.stringify(statuses)).not.toContain("ollama-live-key");
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});

	it("shows unsigned-in Ollama Cloud in a quota dashboard without a notification", async () => {
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, commands, notifications, customComponents } = harness({
			hasUI: true,
			mode: "tui",
			model: { provider: "ollama-cloud", id: "glm-5.2" },
		});
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await commands.get("usage").handler("quota", ctx);
		expect(notifications).toEqual([]);
		expect(customComponents).toHaveLength(1);
		const dashboard = customComponents[0]?.render(100).join("\n") ?? "";
		expect(dashboard).toContain("pi-meter — subscription quota");
		expect(dashboard).toMatch(/Not signed in:.*Ollama Cloud.*run \/login/);
		expect(dashboard).not.toContain("no Ollama Cloud API key");
		expect(fetchSpy).not.toHaveBeenCalled();
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});

	it("does not call subscription APIs or getApiKeyForProvider when auth.json has no credentials", async () => {
		const getApiKeyForProvider = vi.fn(async () => "should-not-be-used");
		const fetchSpy = vi.fn();
		vi.stubGlobal("fetch", fetchSpy);
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, statuses } = harness({
			hasUI: true,
			mode: "tui",
			model: { provider: "xai", id: "grok-4" },
			getApiKeyForProvider,
		});
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await handlers.get("agent_settled")?.[0]?.({ type: "agent_settled" }, ctx);
		expect(getApiKeyForProvider).not.toHaveBeenCalled();
		expect(fetchSpy).not.toHaveBeenCalled();
		expect(statuses.get("pi-meter")).toContain("xai");
		expect(statuses.get("pi-meter")).toContain("not signed in");
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});

	it("notifies in the TUI when a guest collides with a built-in source", async () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		const { registerQuotaAdapter } = await import("../src/quota/guest.ts");
		registerQuotaAdapter({
			id: "claude",
			title: "Hijack",
			matchProvider: () => true,
			fetch: async () => ({
				provider: "claude",
				title: "Hijack",
				windows: [],
				fetchedAt: Date.now(),
				ok: false,
			}),
		});
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, notifications } = harness({ hasUI: true, mode: "tui" });
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		expect(notifications.some((item) => item.type === "warning" && item.message.includes("claude"))).toBe(true);
		expect(warn.mock.calls.flat().join(" ")).toContain("claude");
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});

	it("does not fall back to SuperGrok when the current model matches a guest", async () => {
		const { registerQuotaAdapter } = await import("../src/quota/guest.ts");
		registerQuotaAdapter({
			id: "cursor",
			title: "Cursor",
			matchProvider: (model) => model.provider === "cursor",
			fetch: async () => ({
				provider: "cursor",
				title: "Cursor",
				windows: [],
				fetchedAt: Date.now(),
				ok: false,
				error: "not signed in",
			}),
		});
		const paths = getMeterPaths(agentDir);
		mkdirSync(paths.dataDir, { recursive: true });
		writeFileSync(paths.quotaFile, `${JSON.stringify({
			version: 1,
			ttlMs: 60_000,
			minIntervalMs: 30_000,
			providers: {
				supergrok: {
					provider: "supergrok",
					title: "SuperGrok",
					primary: { id: "weekly", label: "Weekly credits", usedPercent: 51 },
					windows: [{ id: "weekly", label: "Weekly credits", usedPercent: 51 }],
					fetchedAt: Date.now(),
					ok: true,
				},
			},
			lastAttemptAt: {},
		})}\n`);
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, statuses } = harness({
			hasUI: true,
			mode: "tui",
			model: { provider: "cursor", id: "auto" },
		});
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		const footer = statuses.get("pi-meter") ?? "";
		expect(footer).toContain("cursor");
		expect(footer).not.toContain("xai week left");
		expect(footer).not.toContain("week left");
		expect(footer).not.toContain("█");
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});

	it("lists a registered guest in /usage quota and hides leftover guest titles when none is registered", async () => {
		const paths = getMeterPaths(agentDir);
		mkdirSync(paths.dataDir, { recursive: true });
		writeFileSync(paths.quotaFile, `${JSON.stringify({
			version: 1,
			ttlMs: 60_000,
			minIntervalMs: 30_000,
			providers: {
				cursor: {
					provider: "cursor",
					title: "Cursor",
					windows: [],
					fetchedAt: Date.now(),
					ok: false,
					error: "no snapshot yet",
				},
			},
			lastAttemptAt: {},
		})}\n`);
		const { default: piMeter } = await import("../extensions/meter.ts");
		const unsigned = harness({
			hasUI: true,
			mode: "tui",
			model: { provider: "xai", id: "grok-4" },
		});
		piMeter(unsigned.pi);
		await unsigned.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, unsigned.ctx);
		await unsigned.commands.get("usage").handler("quota", unsigned.ctx);
		const hidden = unsigned.customComponents[0]?.render(100).join("\n") ?? "";
		expect(hidden).toContain("Not signed in:");
		expect(hidden).not.toContain("Cursor");
		await unsigned.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, unsigned.ctx);

		vi.resetModules();
		const { registerQuotaAdapter } = await import("../src/quota/guest.ts");
		registerQuotaAdapter({
			id: "cursor",
			title: "Cursor",
			matchProvider: (model) => model.provider === "cursor",
			fetch: async () => ({
				provider: "cursor",
				title: "Cursor",
				windows: [],
				fetchedAt: Date.now(),
				ok: false,
				error: "no snapshot yet",
			}),
		});
		const { default: piMeterWithGuest } = await import("../extensions/meter.ts");
		const listed = harness({
			hasUI: true,
			mode: "tui",
			model: { provider: "cursor", id: "auto" },
		});
		piMeterWithGuest(listed.pi);
		await listed.handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, listed.ctx);
		await listed.commands.get("usage").handler("quota", listed.ctx);
		const dashboard = listed.customComponents[0]?.render(100).join("\n") ?? "";
		expect(dashboard).toMatch(/Not signed in:.*Cursor/);
		await listed.handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, listed.ctx);
	});

	it("does not fall back to Codex when SuperGrok is unavailable", async () => {
		const paths = getMeterPaths(agentDir);
		mkdirSync(paths.dataDir, { recursive: true });
		writeFileSync(paths.quotaFile, `${JSON.stringify({
			version: 1,
			ttlMs: 60_000,
			minIntervalMs: 30_000,
			providers: {
				supergrok: {
					provider: "supergrok",
					title: "SuperGrok",
					windows: [],
					fetchedAt: Date.now(),
					ok: false,
					error: "HTTP 500",
				},
				codex: {
					provider: "codex",
					title: "OpenAI Codex",
					primary: { id: "week", label: "Week limit", usedPercent: 20 },
					windows: [{ id: "week", label: "Week limit", usedPercent: 20 }],
					fetchedAt: Date.now(),
					ok: true,
				},
			},
			lastAttemptAt: {},
		})}\n`);
		writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({
			xai: { type: "oauth", refresh: "x", access: "y" },
		})}\n`);
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, statuses } = harness({
			hasUI: true,
			mode: "tui",
			model: { provider: "xai", id: "grok-4" },
		});
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		const footer = statuses.get("pi-meter") ?? "";
		expect(footer).toContain("xai");
		expect(footer).toContain("unavailable");
		expect(footer).not.toContain("openai");
		expect(footer).not.toContain("week left");
		expect(footer).not.toContain("█");
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});

	it("saves windowMode from /usage footer", async () => {
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, commands } = harness({
			hasUI: true,
			mode: "tui",
			customInputs: ["\x1b[B", "\x1b[B", "\x1b[B", " ", "q"],
		});
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		await commands.get("usage").handler("footer", ctx);
		const saved = JSON.parse(readFileSync(getMeterPaths(agentDir).configFile, "utf8"));
		expect(saved.ledger.windowMode).toBe("calendar");
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});
});
