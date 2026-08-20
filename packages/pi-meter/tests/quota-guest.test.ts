import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	listQuotaAdapters,
	registerQuotaAdapter,
	resetQuotaAdapters,
	takeQuotaAdapterWarnings,
	type QuotaAdapter,
} from "../src/quota/guest.ts";
import { chromeWindow, emptyQuotaStore, putSnapshot, resolveChromeQuota } from "../src/quota/policy.ts";
import { preferredProvider, refreshQuotaSnapshots } from "../src/quota/refresh.ts";
import { loadQuotaStore, parseQuotaStore, saveQuotaStore } from "../src/quota/store.ts";
import type { QuotaSnapshot } from "../src/quota/types.ts";

const now = Date.parse("2026-08-15T12:00:00Z");

function snapshot(over: Partial<QuotaSnapshot> = {}): QuotaSnapshot {
	return {
		provider: "claude",
		title: "Claude",
		primary: { id: "session", label: "Session (5h)", usedPercent: 42, resetsAt: "2026-08-15T17:00:00Z" },
		windows: [{ id: "session", label: "Session (5h)", usedPercent: 42, resetsAt: "2026-08-15T17:00:00Z" }],
		fetchedAt: now - 10_000,
		ok: true,
		...over,
	};
}

function guestAdapter(over: Partial<QuotaAdapter> = {}): QuotaAdapter {
	return {
		id: "cursor",
		title: "Cursor",
		matchProvider: (model) => model.provider === "cursor",
		fetch: async (_ctx, fetchedAt = now) => snapshot({
			provider: "cursor",
			title: "Cursor",
			primary: { id: "month", label: "Monthly", usedPercent: 30 },
			windows: [{ id: "month", label: "Monthly", usedPercent: 30 }],
			fetchedAt,
		}),
		...over,
	};
}

afterEach(() => {
	resetQuotaAdapters();
});

describe("guest preferredProvider", () => {
	it("uses a registered guest when model.provider matches, otherwise built-in or none", () => {
		registerQuotaAdapter(guestAdapter());
		expect(preferredProvider({ provider: "cursor" })).toBe("cursor");
		expect(preferredProvider({ provider: "xai" })).toBe("supergrok");
		expect(preferredProvider({ provider: "ollama" })).toBeUndefined();
		expect(preferredProvider({ provider: "anthropic" })).toBe("claude");
	});

	it("picks among same-provider guests by model id", () => {
		registerQuotaAdapter(guestAdapter({
			id: "cursor-composer",
			title: "Composer",
			matchProvider: (model) => model.provider === "cursor" && (model.id ?? "").includes("composer"),
			fetch: async (_ctx, fetchedAt = now) => snapshot({ provider: "cursor-composer", title: "Composer", fetchedAt }),
		}));
		registerQuotaAdapter(guestAdapter({
			id: "cursor-api",
			title: "API",
			matchProvider: (model) => model.provider === "cursor" && !(model.id ?? "").includes("composer"),
			fetch: async (_ctx, fetchedAt = now) => snapshot({ provider: "cursor-api", title: "API", fetchedAt }),
		}));
		expect(preferredProvider({ provider: "cursor", id: "composer-2.5" })).toBe("cursor-composer");
		expect(preferredProvider({ provider: "cursor", id: "opus-5" })).toBe("cursor-api");
	});

	it("uses the first registered guest when two match the same model", () => {
		registerQuotaAdapter(guestAdapter({
			id: "cursor-first",
			matchProvider: (model) => model.provider === "cursor",
		}));
		registerQuotaAdapter(guestAdapter({
			id: "cursor-second",
			matchProvider: (model) => model.provider === "cursor",
		}));
		expect(preferredProvider({ provider: "cursor", id: "composer-2.5" })).toBe("cursor-first");
	});

	it("does not assign a built-in model to a guest when only provider is passed", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		registerQuotaAdapter(guestAdapter({
			matchProvider: () => true,
		}));
		expect(preferredProvider({ provider: "anthropic" })).toBe("claude");
		expect(preferredProvider({ provider: "xai" })).toBe("supergrok");
		expect(preferredProvider({ provider: "openai-codex" })).toBe("codex");
		expect(preferredProvider({ provider: "ollama-cloud" })).toBe("ollama");
	});
});

describe("guest register overwrite", () => {
	it("lets a later register of the same id replace the earlier adapter", () => {
		registerQuotaAdapter(guestAdapter({
			title: "First",
			matchProvider: (model) => model.provider === "first",
		}));
		registerQuotaAdapter(guestAdapter({
			title: "Second",
			matchProvider: (model) => model.provider === "second",
		}));
		expect(listQuotaAdapters()).toHaveLength(1);
		expect(listQuotaAdapters()[0]?.title).toBe("Second");
		expect(preferredProvider({ provider: "first" })).toBeUndefined();
		expect(preferredProvider({ provider: "second" })).toBe("cursor");
	});

	it("refuses a built-in source id and keeps the built-in mapping", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		registerQuotaAdapter(guestAdapter({
			id: "claude",
			title: "Hijack",
			matchProvider: () => true,
			fetch: async () => snapshot({ provider: "claude", title: "Hijack" }),
		}));
		expect(listQuotaAdapters()).toEqual([]);
		expect(preferredProvider({ provider: "anthropic" })).toBe("claude");
		expect(warn.mock.calls.flat().join(" ")).toContain("claude");
		warn.mockRestore();
	});

	it("does not let matchProvider steal a built-in model provider", () => {
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
		registerQuotaAdapter(guestAdapter({
			matchProvider: (model) => model.provider === "xai" || model.provider === "cursor",
		}));
		expect(listQuotaAdapters()).toHaveLength(1);
		expect(preferredProvider({ provider: "xai" })).toBe("supergrok");
		expect(preferredProvider({ provider: "cursor" })).toBe("cursor");
		expect(warn.mock.calls.flat().join(" ")).toContain("xai");
		warn.mockRestore();
	});

	it("queues register warnings for the TUI to drain once", () => {
		vi.spyOn(console, "warn").mockImplementation(() => {});
		registerQuotaAdapter(guestAdapter({
			id: "claude",
			title: "Hijack",
			matchProvider: () => true,
		}));
		const first = takeQuotaAdapterWarnings();
		expect(first).toHaveLength(1);
		expect(first[0]).toContain("claude");
		expect(takeQuotaAdapterWarnings()).toEqual([]);
	});
});

describe("guest chrome window", () => {
	it("does not fall back to another provider when the current model is a guest", () => {
		registerQuotaAdapter(guestAdapter());
		const store = putSnapshot(emptyQuotaStore(now), snapshot({
			provider: "supergrok",
			title: "SuperGrok",
			primary: { id: "weekly", label: "Weekly credits", usedPercent: 51 },
			windows: [{ id: "weekly", label: "Weekly credits", usedPercent: 51 }],
		}));
		const preferred = preferredProvider({ provider: "cursor" });
		expect(preferred).toBe("cursor");
		expect(chromeWindow(store, preferred)).toBeUndefined();
		expect(resolveChromeQuota(store, preferred, { modelProvider: "cursor" })).toEqual({
			hint: { label: "cursor", value: "unavailable" },
		});
	});

	it("shows the guest snapshot when it is the preferred source", () => {
		registerQuotaAdapter(guestAdapter());
		let store = putSnapshot(emptyQuotaStore(now), snapshot({
			provider: "supergrok",
			title: "SuperGrok",
			primary: { id: "weekly", label: "Weekly credits", usedPercent: 51 },
			windows: [{ id: "weekly", label: "Weekly credits", usedPercent: 51 }],
		}));
		store = putSnapshot(store, snapshot({
			provider: "cursor",
			title: "Cursor",
			primary: { id: "month", label: "Monthly", usedPercent: 30 },
			windows: [{ id: "month", label: "Monthly", usedPercent: 30 }],
		}));
		expect(chromeWindow(store, "cursor")).toMatchObject({
			provider: "cursor",
			window: { id: "month", usedPercent: 30 },
		});
		expect(resolveChromeQuota(store, "cursor").view?.provider).toBe("cursor");
	});
});

describe("guest store", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		dirs.length = 0;
	});

	function agentDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-meter-guest-store-"));
		dirs.push(dir);
		mkdirSync(join(dir, "extension-data", "pi-meter"), { recursive: true });
		return dir;
	}

	it("reads and writes a guest snapshot id", async () => {
		const dir = agentDir();
		const store = putSnapshot(emptyQuotaStore(now), snapshot({
			provider: "cursor",
			title: "Cursor",
			primary: { id: "month", label: "Monthly", usedPercent: 30 },
			windows: [{ id: "month", label: "Monthly", usedPercent: 30 }],
		}));
		await saveQuotaStore(store, dir);
		const loaded = await loadQuotaStore(dir);
		expect(loaded.providers.cursor).toMatchObject({
			provider: "cursor",
			title: "Cursor",
			ok: true,
			primary: { id: "month", usedPercent: 30 },
		});
		expect(loaded.lastAttemptAt.cursor).toBe(now - 10_000);
	});

	it("parses a guest id from a raw store file", () => {
		const parsed = parseQuotaStore({
			version: 1,
			ttlMs: 60_000,
			minIntervalMs: 30_000,
			providers: {
				cursor: {
					title: "Cursor",
					primary: { id: "month", label: "Monthly", usedPercent: 12 },
					windows: [{ id: "month", label: "Monthly", usedPercent: 12 }],
					fetchedAt: now,
					ok: true,
				},
			},
			lastAttemptAt: { cursor: now },
		});
		expect(parsed.providers.cursor).toMatchObject({ provider: "cursor", title: "Cursor", ok: true });
		expect(parsed.lastAttemptAt.cursor).toBe(now);
	});
});

describe("guest refresh", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		dirs.length = 0;
	});

	function agentDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-meter-guest-refresh-"));
		dirs.push(dir);
		mkdirSync(join(dir, "extension-data", "pi-meter"), { recursive: true });
		return dir;
	}

	it("refreshes a registered guest into the shared store and keeps built-ins", async () => {
		registerQuotaAdapter(guestAdapter());
		const dir = agentDir();
		const result = await refreshQuotaSnapshots(
			{ hasUI: true, modelRegistry: {} as never },
			dir,
			{
				now,
				hasCredential: () => true,
				fetchers: {
					claude: async (_ctx, fetchedAt = now) => snapshot({ fetchedAt }),
					codex: async (_ctx, fetchedAt = now) => snapshot({ provider: "codex", title: "OpenAI Codex", fetchedAt }),
					supergrok: async (_ctx, fetchedAt = now) => snapshot({ provider: "supergrok", title: "SuperGrok", fetchedAt }),
					ollama: async (_ctx, fetchedAt = now) => snapshot({ provider: "ollama", title: "Ollama Cloud", fetchedAt }),
				},
			},
		);
		expect(result.fetched).toContain("cursor");
		expect(result.store.providers.cursor).toMatchObject({
			provider: "cursor",
			title: "Cursor",
			ok: true,
			primary: { usedPercent: 30 },
		});
		expect(result.store.providers.claude?.ok).toBe(true);
		const saved = JSON.parse(readFileSync(join(dir, "extension-data", "pi-meter", "quota.json"), "utf8"));
		expect(saved.providers.cursor.primary.usedPercent).toBe(30);
	});

	it("turns a guest fetch failure into ok:false instead of throwing", async () => {
		registerQuotaAdapter(guestAdapter({
			fetch: async () => ({
				provider: "cursor",
				title: "Cursor",
				windows: [],
				fetchedAt: now,
				ok: false,
				error: "not signed in",
			}),
		}));
		const result = await refreshQuotaSnapshots(
			{ hasUI: true, modelRegistry: {} as never },
			agentDir(),
			{ now, providers: ["cursor"] },
		);
		expect(result.store.providers.cursor).toMatchObject({ ok: false, error: "not signed in" });
	});
});
