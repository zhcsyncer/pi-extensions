import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseClaudeUsage } from "../src/quota/adapters/claude.ts";
import { parseCodexUsage } from "../src/quota/adapters/codex.ts";
import { parseSuperGrokBilling } from "../src/quota/adapters/supergrok.ts";
import { decideRefresh, emptyQuotaStore, markAttempt, putSnapshot } from "../src/quota/policy.ts";
import { refreshQuotaSnapshots } from "../src/quota/refresh.ts";
import { sanitizeQuotaError } from "../src/quota/sanitize.ts";
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

describe("refresh policy", () => {
	it("skips a fresh shared snapshot inside the TTL", () => {
		let store = emptyQuotaStore(now);
		store = putSnapshot(store, snapshot());
		expect(decideRefresh(store, "claude", now)).toMatchObject({ refresh: false, reason: "fresh" });
	});

	it("skips when the last success or failure is inside the min interval", () => {
		let store = emptyQuotaStore(now);
		store = markAttempt(store, "claude", now - 5_000);
		expect(decideRefresh(store, "claude", now)).toMatchObject({ refresh: false, reason: "min-interval" });
	});

	it("lets /usage refresh bypass TTL but still honors the min interval", () => {
		let store = emptyQuotaStore(now);
		store = putSnapshot(store, snapshot({ fetchedAt: now - 90_000 }));
		expect(decideRefresh(store, "claude", now, { force: true })).toMatchObject({ refresh: true, reason: "forced" });
		store = markAttempt(store, "claude", now - 5_000);
		expect(decideRefresh(store, "claude", now, { force: true })).toMatchObject({ refresh: false, reason: "min-interval" });
	});
});

describe("refreshQuotaSnapshots", () => {
	const dirs: string[] = [];
	afterEach(() => {
		for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
		dirs.length = 0;
		vi.restoreAllMocks();
	});

	function agentDir(): string {
		const dir = mkdtempSync(join(tmpdir(), "pi-meter-quota-"));
		dirs.push(dir);
		mkdirSync(join(dir, "extension-data", "pi-meter"), { recursive: true });
		return dir;
	}

	it("does not call subscription APIs without UI", async () => {
		const fetchers = {
			claude: vi.fn(),
			codex: vi.fn(),
			supergrok: vi.fn(),
		};
		const result = await refreshQuotaSnapshots(
			{ hasUI: false, modelRegistry: {} as never },
			agentDir(),
			{ fetchers, now },
		);
		expect(result.fetched).toEqual([]);
		expect(fetchers.claude).not.toHaveBeenCalled();
		expect(fetchers.codex).not.toHaveBeenCalled();
		expect(fetchers.supergrok).not.toHaveBeenCalled();
	});

	it("keeps other providers when one adapter throws", async () => {
		const result = await refreshQuotaSnapshots(
			{ hasUI: true, modelRegistry: {} as never },
			agentDir(),
			{
				now,
				fetchers: {
					claude: async () => {
						throw new Error("Bearer eyJabc exploded");
					},
					codex: async (_ctx, fetchedAt = now) => snapshot({
						provider: "codex",
						title: "OpenAI Codex",
						fetchedAt,
					}),
					supergrok: async (_ctx, fetchedAt = now) => snapshot({
						provider: "supergrok",
						title: "SuperGrok",
						fetchedAt,
					}),
				},
			},
		);
		expect(result.store.providers.claude).toMatchObject({ ok: false, error: "request failed" });
		expect(result.store.providers.codex?.ok).toBe(true);
		expect(result.store.providers.supergrok?.ok).toBe(true);
	});

	it("keeps other providers when one adapter fails", async () => {
		const dir = agentDir();
		const result = await refreshQuotaSnapshots(
			{ hasUI: true, modelRegistry: {} as never },
			dir,
			{
				now,
				fetchers: {
					claude: async (_ctx, fetchedAt = now) => ({
						provider: "claude",
						title: "Claude",
						windows: [],
						fetchedAt,
						ok: false,
						error: "HTTP 500",
					}),
					codex: async (_ctx, fetchedAt = now) => snapshot({
						provider: "codex",
						title: "OpenAI Codex",
						fetchedAt,
					}),
					supergrok: async (_ctx, fetchedAt = now) => snapshot({
						provider: "supergrok",
						title: "SuperGrok",
						primary: { id: "weekly", label: "Weekly credits", usedPercent: 66 },
						windows: [{ id: "weekly", label: "Weekly credits", usedPercent: 66 }],
						fetchedAt,
					}),
				},
			},
		);
		expect(result.store.providers.claude?.ok).toBe(false);
		expect(result.store.providers.codex?.ok).toBe(true);
		expect(result.store.providers.supergrok?.ok).toBe(true);
		const saved = JSON.parse(readFileSync(join(dir, "extension-data", "pi-meter", "quota.json"), "utf8"));
		expect(saved.providers.supergrok.primary.usedPercent).toBe(66);
		expect(JSON.stringify(saved)).not.toMatch(/Bearer|sk-|@/);
	});

	it("does not refetch inside the shared TTL across two UI checks", async () => {
		const dir = agentDir();
		const claude = vi.fn(async (_ctx, fetchedAt = now) => snapshot({ fetchedAt }));
		await refreshQuotaSnapshots({ hasUI: true, modelRegistry: {} as never }, dir, {
			now,
			fetchers: { claude, codex: async () => snapshot({ provider: "codex", fetchedAt: now }), supergrok: async () => snapshot({ provider: "supergrok", fetchedAt: now }) },
		});
		expect(claude).toHaveBeenCalledTimes(1);
		await refreshQuotaSnapshots({ hasUI: true, modelRegistry: {} as never }, dir, {
			now: now + 10_000,
			fetchers: { claude, codex: vi.fn(), supergrok: vi.fn() },
		});
		expect(claude).toHaveBeenCalledTimes(1);
	});
});

describe("provider parsers", () => {
	it("parses SuperGrok weekly creditUsagePercent and product split", () => {
		const parsed = parseSuperGrokBilling({
			config: {
				currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", endTime: "2026-08-18T00:00:00Z" },
				creditUsagePercent: 66,
				productUsage: [
					{ product: "GrokBuild", usagePercent: 10 },
					{ product: "GrokChat", usagePercent: 80 },
				],
			},
		}, now);
		expect(parsed.ok).toBe(true);
		expect(parsed.primary).toMatchObject({ id: "weekly", usedPercent: 66, resetsAt: "2026-08-18T00:00:00Z" });
		expect(parsed.windows.map((window) => window.label)).toEqual(["Weekly credits", "Build", "Chat"]);
	});

	it("parses Claude 5h/week windows and Codex used_percent", () => {
		const claude = parseClaudeUsage({
			five_hour: { utilization: 42, resets_at: "2026-08-15T17:00:00Z" },
			seven_day: { utilization: 17, resets_at: "2026-08-19T12:00:00Z" },
		}, now);
		expect(claude.primary?.usedPercent).toBe(42);
		expect(claude.windows).toHaveLength(2);
		const codex = parseCodexUsage({
			plan_type: "pro",
			rate_limit: {
				primary_window: { used_percent: 42, limit_window_seconds: 18000, reset_after_seconds: 3600 },
				secondary_window: { used_percent: 84, limit_window_seconds: 604800, reset_after_seconds: 86400 },
			},
		}, now);
		expect(codex.title).toBe("OpenAI Codex (pro)");
		expect(codex.windows.map((window) => window.label)).toEqual(["5h limit", "Week limit"]);
	});

	it("never echoes tokens or emails from adapter errors", () => {
		expect(sanitizeQuotaError(new Error("Bearer eyJabc token=secret user@x.ai"))).toBe("request failed");
	});
});
