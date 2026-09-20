import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getQuotaSkipsPath } from "../extensions/paths.js";
import {
	clearQuotaSkipsForTests,
	filterQuotaSkipped,
	fingerprintKey,
	formatLocalDateTime,
	HOSTED_QUOTA_SKIP_MS,
	isQuotaExhaustedError,
	KEY_QUOTA_SKIP_MS,
	markHostedQuotaSkip,
	markKeyQuotaSkip,
	nextMonthUtc,
	parseFirecrawlUsage,
	parseTavilyUsage,
	quotaSkipUntil,
	usableKeys,
} from "../extensions/quota-skips.js";

describe("quota skips", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-search-quota-skip-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		mkdirSync(join(root, "agent"), { recursive: true });
		clearQuotaSkipsForTests();
	});

	afterEach(() => {
		clearQuotaSkipsForTests();
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("treats usage-limit and 402 as exhausted, not ordinary 429", () => {
		expect(isQuotaExhaustedError(new Error("Codex error: The usage limit has been reached"))).toBe(true);
		expect(isQuotaExhaustedError(new Error("API error (402): payment required"))).toBe(true);
		expect(isQuotaExhaustedError(new Error("API error (429): slow down"))).toBe(false);
		expect(isQuotaExhaustedError(new Error("Grok search did not submit structured results"))).toBe(false);
	});

	it("skips a hosted backend for 5 hours and persists globally", () => {
		const now = Date.parse("2026-04-08T12:00:00.000Z");
		const until = markHostedQuotaSkip("openai-codex", now);
		expect(until).toBe(now + HOSTED_QUOTA_SKIP_MS);
		expect(quotaSkipUntil("openai-codex", now + 1000)).toBe(until);
		expect(filterQuotaSkipped(["openai-codex", "xai", "tavily"], undefined, now + 1000)).toEqual(["xai", "tavily"]);
		clearQuotaSkipsForTests();
		expect(quotaSkipUntil("openai-codex", now + 1000)).toBe(until);
		expect(JSON.parse(readFileSync(getQuotaSkipsPath(), "utf8"))).toEqual({
			"openai-codex": { until },
		});
	});

	it("skips an exhausted API key and the whole backend when every key is skipped", () => {
		const now = Date.parse("2026-04-08T12:00:00.000Z");
		const until = now + KEY_QUOTA_SKIP_MS;
		markKeyQuotaSkip("exa", "exa-key-a", until, now);
		expect(usableKeys("exa", ["exa-key-a", "exa-key-b"], now + 1000)).toEqual(["exa-key-b"]);
		markKeyQuotaSkip("exa", "exa-key-b", until, now);
		expect(usableKeys("exa", ["exa-key-a", "exa-key-b"], now + 1000)).toEqual([]);
		expect(filterQuotaSkipped(["exa", "tavily"], undefined, now + 1000, (backend) => (
			backend === "exa" ? ["exa-key-a", "exa-key-b"] : []
		))).toEqual(["tavily"]);
		expect(JSON.parse(readFileSync(getQuotaSkipsPath(), "utf8")).exa.keys[fingerprintKey("exa-key-a")].skipUntil).toBe(until);
	});

	it("parses Tavily and Firecrawl remaining without a reset field on Tavily", () => {
		expect(parseTavilyUsage({
			key: { usage: 61, limit: null },
			account: { plan_usage: 61, plan_limit: 1000 },
		})).toEqual({ usage: 61, limit: 1000, remaining: 939 });
		expect(parseFirecrawlUsage({
			success: true,
			data: {
				remainingCredits: 0,
				planCredits: 1000,
				billingPeriodEnd: "2026-09-23T02:28:21.020Z",
			},
		})).toMatchObject({ remaining: 0, limit: 1000, periodEnd: Date.parse("2026-09-23T02:28:21.020Z") });
		expect(nextMonthUtc(Date.parse("2026-04-08T12:00:00.000Z"))).toBe(Date.parse("2026-05-01T00:00:00.000Z"));
		expect(formatLocalDateTime(Date.parse("2026-10-01T00:00:00.000Z"))).not.toMatch(/Z$/);
		expect(formatLocalDateTime(Date.parse("2026-10-01T00:00:00.000Z"))).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/);
	});
});
