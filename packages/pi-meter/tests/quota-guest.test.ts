import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	listQuotaAdapters,
	registerQuotaAdapter,
	resetQuotaAdapters,
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
		matchProvider: (provider) => provider === "cursor",
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
});

describe("guest register overwrite", () => {
	it("lets a later register of the same id replace the earlier adapter", () => {
		registerQuotaAdapter(guestAdapter({
			title: "First",
			matchProvider: (provider) => provider === "first",
		}));
		registerQuotaAdapter(guestAdapter({
			title: "Second",
			matchProvider: (provider) => provider === "second",
		}));
		expect(listQuotaAdapters()).toHaveLength(1);
		expect(listQuotaAdapters()[0]?.title).toBe("Second");
		expect(preferredProvider({ provider: "first" })).toBeUndefined();
		expect(preferredProvider({ provider: "second" })).toBe("cursor");
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
