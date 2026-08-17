import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { findConflictingUsageCommand } from "../src/conflict.ts";
import { createLedgerStore } from "../src/ledger/store.ts";
import { getMeterPaths } from "../src/paths.ts";

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

function harness(options: { hasUI?: boolean; mode?: "tui" | "print"; sessionFile?: string } = {}) {
	const handlers = new Map<string, Handler[]>();
	const commands = new Map<string, any>();
	const widgets = new Map<string, { content: unknown; placement?: string }>();
	const statuses = new Map<string, string>();
	const notifications: Array<{ message: string; type?: string }> = [];
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
		model: { provider: "xai", id: "grok-4" },
		modelRegistry: { getApiKeyForProvider: async () => undefined },
		sessionManager: {
			getSessionFile: () => options.sessionFile,
			getSessionId: () => "sess",
		},
		ui: {
			notify: (message: string, type?: string) => notifications.push({ message, type }),
			theme: { fg: (_color: string, text: string) => text, bold: (text: string) => text },
			setStatus: (key: string, text: string | undefined) => {
				if (text === undefined) statuses.delete(key);
				else statuses.set(key, text);
			},
			setWidget: (key: string, content: unknown, widgetOptions?: { placement?: string }) => {
				if (content === undefined) widgets.delete(key);
				else widgets.set(key, { content, placement: widgetOptions?.placement });
			},
			custom: async () => undefined,
		},
	} as unknown as ExtensionContext;
	return { pi, ctx, handlers, commands, widgets, statuses, notifications };
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

	it("publishes one footer status instead of a widget row", async () => {
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, widgets, statuses } = harness({ hasUI: true, mode: "tui" });
		piMeter(pi);
		await handlers.get("session_start")?.[0]?.({ type: "session_start", reason: "startup" }, ctx);
		expect(widgets.size).toBe(0);
		expect(statuses.get("pi-meter")).toContain("today");
		await handlers.get("session_shutdown")?.[0]?.({ type: "session_shutdown" }, ctx);
	});

	it("writes footer local and quota visibility into one config.json", async () => {
		const { default: piMeter } = await import("../extensions/meter.ts");
		const { pi, ctx, handlers, commands, statuses, notifications } = harness({ hasUI: true, mode: "tui" });
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
		await commands.get("usage").handler("footer today-tokens", ctx);
		expect(notifications.at(-1)?.message).toContain("Today tokens");
		expect(statuses.get("pi-meter")).toContain("today 12.4k");
		await commands.get("usage").handler("quota off", ctx);
		expect(JSON.parse(readFileSync(getMeterPaths(agentDir).configFile, "utf8"))).toMatchObject({
			footer: { local: "today-tokens", quota: false },
		});
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
		expect(statuses.get("pi-meter")).toContain("today 12.4k $0.18");
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
});
