import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getQuotaSkipsPath } from "../extensions/paths.js";
import {
	clearQuotaSkipsForTests,
	filterQuotaSkipped,
	HOSTED_QUOTA_SKIP_MS,
	isQuotaExhaustedError,
	markHostedQuotaSkip,
	quotaSkipUntil,
} from "../extensions/quota-skips.js";

describe("hosted quota skips", () => {
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

	it("treats subscription usage-limit text as exhausted, not ordinary 429", () => {
		expect(isQuotaExhaustedError(new Error("Codex error: The usage limit has been reached"))).toBe(true);
		expect(isQuotaExhaustedError(new Error("insufficient_quota"))).toBe(true);
		expect(isQuotaExhaustedError(new Error("API error (429): slow down"))).toBe(false);
		expect(isQuotaExhaustedError(new Error("Grok search did not submit structured results"))).toBe(false);
	});

	it("skips a backend for 5 hours and persists globally", () => {
		const now = Date.parse("2026-04-08T12:00:00.000Z");
		const until = markHostedQuotaSkip("openai-codex", now);
		expect(until).toBe(now + HOSTED_QUOTA_SKIP_MS);
		expect(quotaSkipUntil("openai-codex", now + 1000)).toBe(until);
		expect(filterQuotaSkipped(["openai-codex", "xai", "tavily"], undefined, now + 1000)).toEqual(["xai", "tavily"]);
		expect(quotaSkipUntil("openai-codex", until + 1)).toBeUndefined();

		clearQuotaSkipsForTests();
		expect(quotaSkipUntil("openai-codex", now + 1000)).toBe(until);
		const saved = JSON.parse(readFileSync(getQuotaSkipsPath(), "utf8")) as { "openai-codex": number };
		expect(saved["openai-codex"]).toBe(until);
	});
});
