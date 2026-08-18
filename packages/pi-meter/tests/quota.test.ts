import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { parseClaudeUsage } from "../src/quota/adapters/claude.ts";
import { parseCodexUsage } from "../src/quota/adapters/codex.ts";
import { fetchOllamaQuota, OLLAMA_USAGE_URL, parseOllamaUsage } from "../src/quota/adapters/ollama.ts";
import { parseSuperGrokBilling } from "../src/quota/adapters/supergrok.ts";
import { readLocalQuotaCache } from "../src/chrome/status-cache.ts";
import { OLLAMA_API_KEY_ERROR } from "../src/quota/auth.ts";
import { QUOTA_UNSIGNED_OAUTH_ERROR } from "../src/quota/auth.ts";
import { decideRefresh, emptyQuotaStore, markAttempt, putSnapshot, resolveChromeQuota } from "../src/quota/policy.ts";
import { preferredProvider, refreshQuotaSnapshots } from "../src/quota/refresh.ts";
import { sanitizeQuotaError } from "../src/quota/sanitize.ts";
import { saveQuotaStore } from "../src/quota/store.ts";
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

	it("does not treat a failed snapshot as fresh", () => {
		let store = emptyQuotaStore(now);
		store = putSnapshot(store, snapshot({
			ok: false,
			error: "HTTP 500",
			fetchedAt: now - 90_000,
			primary: undefined,
			windows: [],
		}));
		expect(decideRefresh(store, "claude", now)).toMatchObject({ refresh: true, reason: "expired" });
	});

	it("does not let an unsigned snapshot's lastAttemptAt block the next pull", () => {
		let store = emptyQuotaStore(now);
		store = putSnapshot(store, snapshot({
			ok: false,
			error: QUOTA_UNSIGNED_OAUTH_ERROR,
			fetchedAt: now - 1_000,
			primary: undefined,
			windows: [],
		}), { recordAttempt: false });
		store = markAttempt(store, "claude", now - 5_000);
		expect(decideRefresh(store, "claude", now)).toMatchObject({ refresh: true });
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

	it("rereads a shared snapshot and only marks stale locally", async () => {
		const dir = agentDir();
		await saveQuotaStore(putSnapshot(emptyQuotaStore(now), snapshot({
			provider: "supergrok",
			title: "SuperGrok",
			fetchedAt: now - 120_000,
		})), dir);
		const cached = await readLocalQuotaCache(dir, { ttlMs: 60_000, minIntervalMs: 30_000 }, now);
		expect(cached.providers.supergrok).toMatchObject({ ok: true, stale: true, fetchedAt: now - 120_000 });
	});

	it("does not call subscription APIs without UI", async () => {
		const fetchers = {
			claude: vi.fn(),
			codex: vi.fn(),
			supergrok: vi.fn(),
			ollama: vi.fn(),
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
		expect(fetchers.ollama).not.toHaveBeenCalled();
	});

	it("keeps other providers when one adapter throws", async () => {
		const result = await refreshQuotaSnapshots(
			{ hasUI: true, modelRegistry: {} as never },
			agentDir(),
			{
				now,
				hasCredential: () => true,
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
					ollama: async (_ctx, fetchedAt = now) => snapshot({
						provider: "ollama",
						title: "Ollama Cloud",
						fetchedAt,
					}),
				},
			},
		);
		expect(result.store.providers.claude).toMatchObject({ ok: false, error: "request failed" });
		expect(result.store.providers.codex?.ok).toBe(true);
		expect(result.store.providers.supergrok?.ok).toBe(true);
		expect(result.store.providers.ollama?.ok).toBe(true);
	});

	it("keeps other providers when one adapter fails", async () => {
		const dir = agentDir();
		const result = await refreshQuotaSnapshots(
			{ hasUI: true, modelRegistry: {} as never },
			dir,
			{
				now,
				hasCredential: () => true,
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
					ollama: async (_ctx, fetchedAt = now) => snapshot({
						provider: "ollama",
						title: "Ollama Cloud",
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
			hasCredential: () => true,
			fetchers: {
				claude,
				codex: async () => snapshot({ provider: "codex", fetchedAt: now }),
				supergrok: async () => snapshot({ provider: "supergrok", fetchedAt: now }),
				ollama: async () => snapshot({ provider: "ollama", fetchedAt: now }),
			},
		});
		expect(claude).toHaveBeenCalledTimes(1);
		await refreshQuotaSnapshots({ hasUI: true, modelRegistry: {} as never }, dir, {
			now: now + 10_000,
			hasCredential: () => true,
			fetchers: { claude, codex: vi.fn(), supergrok: vi.fn(), ollama: vi.fn() },
		});
		expect(claude).toHaveBeenCalledTimes(1);
	});

	it("does not call fetchers or getApiKeyForProvider when auth.json has no credentials", async () => {
		const getApiKeyForProvider = vi.fn(async () => "should-not-be-used");
		const fetchers = {
			claude: vi.fn(),
			codex: vi.fn(),
			supergrok: vi.fn(),
			ollama: vi.fn(),
		};
		const result = await refreshQuotaSnapshots(
			{ hasUI: true, modelRegistry: { getApiKeyForProvider } as never },
			agentDir(),
			{ now, fetchers, hasCredential: () => false },
		);
		expect(result.fetched).toEqual([]);
		expect(getApiKeyForProvider).not.toHaveBeenCalled();
		expect(fetchers.claude).not.toHaveBeenCalled();
		expect(fetchers.codex).not.toHaveBeenCalled();
		expect(fetchers.supergrok).not.toHaveBeenCalled();
		expect(fetchers.ollama).not.toHaveBeenCalled();
		expect(result.store.providers.claude).toMatchObject({ ok: false, error: QUOTA_UNSIGNED_OAUTH_ERROR });
		expect(result.store.lastAttemptAt.claude).toBeUndefined();
	});
});

describe("provider parsers", () => {
	it("parses SuperGrok weekly creditUsagePercent and period end, without product split", () => {
		const parsed = parseSuperGrokBilling({
			config: {
				currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", start: "2026-08-10T16:55:31.897623+00:00", end: "2026-08-17T16:55:31.897623+00:00" },
				creditUsagePercent: 51,
				billingPeriodEnd: "2026-08-17T16:55:31.897623+00:00",
				productUsage: [
					{ product: "GrokBuild", usagePercent: 50 },
					{ product: "GrokChat", usagePercent: 1 },
				],
			},
		}, now);
		expect(parsed.ok).toBe(true);
		expect(parsed.primary).toMatchObject({ id: "weekly", usedPercent: 51, resetsAt: "2026-08-17T16:55:31.897Z" });
		expect(parsed.windows).toEqual([parsed.primary]);
	});

	it("treats a recognizable SuperGrok config without creditUsagePercent as 0% used", () => {
		const parsed = parseSuperGrokBilling({
			config: {
				currentPeriod: { type: "USAGE_PERIOD_TYPE_WEEKLY", end: "2026-08-17T16:55:31.897623+00:00" },
				billingPeriodEnd: "2026-08-17T16:55:31.897623+00:00",
			},
		}, now);
		expect(parsed.ok).toBe(true);
		expect(parsed.error).toBeUndefined();
		expect(parsed.primary).toMatchObject({ id: "weekly", usedPercent: 0, resetsAt: "2026-08-17T16:55:31.897Z" });
	});

	it("still fails SuperGrok when the payload has no config object", () => {
		expect(parseSuperGrokBilling({ creditUsagePercent: 10 }, now)).toMatchObject({
			ok: false,
			error: "unexpected response",
		});
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

	it("maps only ollama-cloud models onto the Ollama quota adapter", () => {
		expect(preferredProvider({ provider: "ollama-cloud" })).toBe("ollama");
		expect(preferredProvider({ provider: "ollama" })).toBeUndefined();
	});

	it("does not fall back to another vendor's quota window in the footer", () => {
		const store = putSnapshot(emptyQuotaStore(now), snapshot({
			provider: "codex",
			title: "OpenAI Codex",
			primary: { id: "week", label: "Week limit", usedPercent: 20 },
			windows: [{ id: "week", label: "Week limit", usedPercent: 20 }],
		}));
		const failed = putSnapshot(store, snapshot({
			provider: "supergrok",
			title: "SuperGrok",
			ok: false,
			error: "HTTP 500",
			primary: undefined,
			windows: [],
		}));
		expect(resolveChromeQuota(failed, "supergrok", { signedIn: true })).toEqual({
			hint: { label: "xai", value: "unavailable" },
		});
		expect(resolveChromeQuota(failed, "supergrok", { signedIn: false })).toEqual({
			hint: { label: "xai", value: "not signed in" },
		});
		expect(resolveChromeQuota(failed, undefined, { modelProvider: "ollama" })).toEqual({
			hint: { label: "ollama", value: "no quota window" },
		});
	});

	it("parses Ollama Cloud session and weekly fractions without a reset time", () => {
		const parsed = parseOllamaUsage({
			plan: "pro",
			limits: {
				session: { usage: 0.28, models: [{ name: "glm-5.2", request_count: 12 }] },
				weekly: { usage: 0.1 },
				extra: { remaining: 4 },
			},
		}, now);
		expect(parsed.ok).toBe(true);
		expect(parsed.title).toBe("Ollama Cloud (pro)");
		expect(parsed.primary).toMatchObject({ id: "session", label: "Session (5h)", usedPercent: 28 });
		expect(parsed.primary?.resetsAt).toBeUndefined();
		expect(parsed.windows.map((window) => window.id)).toEqual(["session", "weekly", "extra"]);
		expect(parsed.windows[1]).toMatchObject({ id: "weekly", label: "Weekly (7d)", usedPercent: 10 });
		expect(parsed.windows[2]).toMatchObject({ id: "extra", usedPercent: 0, note: "balance 4" });
	});

	it("rejects garbage or incomplete Ollama usage payloads without throwing", () => {
		expect(parseOllamaUsage(null, now)).toMatchObject({ ok: false, error: "unexpected response" });
		expect(parseOllamaUsage({ limits: { session: { usage: 0.2 } } }, now)).toMatchObject({
			ok: false,
			error: "missing session or weekly usage",
		});
	});
});

describe("fetchOllamaQuota", () => {
	const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
	let agentDir: string;

	afterEach(() => {
		rmSync(agentDir, { recursive: true, force: true });
		if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
	});

	function prepareAgentDir(): void {
		agentDir = mkdtempSync(join(tmpdir(), "pi-meter-ollama-"));
		process.env.PI_CODING_AGENT_DIR = agentDir;
	}

	it("fails closed without an API key and never echoes a secret", async () => {
		prepareAgentDir();
		const fetchImpl = vi.fn();
		const result = await fetchOllamaQuota({
			modelRegistry: { getApiKeyForProvider: async () => "ollama-secret-key" },
		} as never, now, fetchImpl as unknown as typeof fetch);
		expect(result.ok).toBe(false);
		expect(result.error).toBe(OLLAMA_API_KEY_ERROR);
		expect(result.error).toContain("no Ollama Cloud API key");
		expect(JSON.stringify(result)).not.toContain("ollama-secret-key");
		expect(fetchImpl).not.toHaveBeenCalled();
	});

	it("sends the resolved key to the usage endpoint and parses a 200 body", async () => {
		prepareAgentDir();
		writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({
			"ollama-cloud": { type: "api_key", key: "stored-but-not-used" },
		})}\n`);
		const fetchImpl = vi.fn(async () => ({
			ok: true,
			status: 200,
			json: async () => ({ limits: { session: { usage: 0.28 }, weekly: { usage: 0.1 } }, plan: "pro" }),
		}));
		const result = await fetchOllamaQuota({
			modelRegistry: { getApiKeyForProvider: async () => "ollama-live-key" },
		} as never, now, fetchImpl as unknown as typeof fetch);
		expect(fetchImpl).toHaveBeenCalledWith(OLLAMA_USAGE_URL, expect.objectContaining({
			headers: expect.objectContaining({
				Authorization: "Bearer ollama-live-key",
				Accept: "application/json",
			}),
		}));
		expect(result).toMatchObject({
			ok: true,
			title: "Ollama Cloud (pro)",
			primary: { id: "session", usedPercent: 28 },
		});
		expect(result.primary?.resetsAt).toBeUndefined();
	});

	it("returns a sanitized HTTP error on 401", async () => {
		prepareAgentDir();
		writeFileSync(join(agentDir, "auth.json"), `${JSON.stringify({
			"ollama-cloud": { type: "api_key", key: "stored-but-not-used" },
		})}\n`);
		const fetchImpl = vi.fn(async () => ({
			ok: false,
			status: 401,
			json: async () => ({ error: "Bearer ollama-live-key rejected" }),
		}));
		const result = await fetchOllamaQuota({
			modelRegistry: { getApiKeyForProvider: async () => "ollama-live-key" },
		} as never, now, fetchImpl as unknown as typeof fetch);
		expect(result.ok).toBe(false);
		expect(result.error).toBe("HTTP 401");
		expect(JSON.stringify(result)).not.toContain("ollama-live-key");
	});
});
