import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
	CONSECUTIVE_FAILURE_ALERT,
	MAX_ATTEMPTS_PER_KEY,
	ROLLING_MIN_SAMPLES,
	classifyError,
	evaluateDegradation,
	isUserAbort,
	recordEffectiveness,
	reportEffectiveness,
	type EffectivenessAttempt,
} from "./effectiveness.js";
import { getEffectivenessPath } from "./paths.js";

function attempt(ok: boolean, extra: Partial<EffectivenessAttempt> = {}): EffectivenessAttempt {
	return { t: 1, ok, latencyMs: 10, ...extra };
}

function fails(count: number, errorClass = "other"): EffectivenessAttempt[] {
	return Array.from({ length: count }, () => attempt(false, { errorClass }));
}

describe("classifyError", () => {
	it("maps timeout, abort, and HTTP status classes", () => {
		expect(classifyError(Object.assign(new Error("timed out"), { name: "TimeoutError" }))).toBe("timeout");
		expect(classifyError(Object.assign(new Error("The operation was aborted"), { name: "AbortError" }))).toBe("aborted");
		expect(classifyError(new Error("Firecrawl API error (429): slow down"))).toBe("http_429");
		expect(classifyError(new Error("API error (402): payment"))).toBe("http_402");
		expect(classifyError(new Error("API error (503): unavailable"))).toBe("http_5xx");
		expect(classifyError(new Error("API error (404): missing"))).toBe("http_4xx");
		expect(classifyError(new Error("network down"))).toBe("other");
	});
});

describe("isUserAbort", () => {
	it("only treats an aborted caller signal as user cancel", () => {
		const signal = AbortSignal.abort();
		expect(isUserAbort(new Error("nope"), signal)).toBe(true);
		expect(isUserAbort(new Error("nope"))).toBe(false);
	});
});

describe("evaluateDegradation", () => {
	it("does not warn on success, empty success, or short failure streaks", () => {
		expect(evaluateDegradation("Tavily", "search", [attempt(true, { resultCount: 0 })])).toBeNull();
		expect(evaluateDegradation("Tavily", "search", fails(1))).toBeNull();
		expect(evaluateDegradation("Tavily", "search", fails(2))).toBeNull();
	});

	it("warns once when consecutive failures hit the threshold, not after", () => {
		const third = evaluateDegradation("Tavily", "search", fails(CONSECUTIVE_FAILURE_ALERT, "http_429"));
		expect(third).toBe("Search Hub: Tavily search failed 3 times in a row (http_429).");
		expect(evaluateDegradation("Tavily", "search", fails(CONSECUTIVE_FAILURE_ALERT + 1, "http_429"))).toBeNull();
	});

	it("warns again after a success resets the streak", () => {
		const attempts = [...fails(3), attempt(true), ...fails(3, "http_5xx")];
		expect(evaluateDegradation("Jina", "read", attempts)).toBe(
			"Search Hub: Jina read failed 3 times in a row (http_5xx).",
		);
	});

	it("warns when recent success rate crosses below 50% without a 3-fail streak", () => {
		const window: EffectivenessAttempt[] = [
			attempt(true),
			attempt(false),
			attempt(false),
			attempt(true),
			attempt(false),
			attempt(false),
			attempt(true),
			attempt(false),
		];
		expect(window).toHaveLength(ROLLING_MIN_SAMPLES);
		expect(evaluateDegradation("Exa", "search", window)).toBe(
			"Search Hub: Exa search success rate 38% over the last 8 calls.",
		);
	});

	it("does not repeat the rolling-rate warning while still below the floor", () => {
		const firstDrop = [
			attempt(true),
			attempt(false),
			attempt(false),
			attempt(true),
			attempt(false),
			attempt(false),
			attempt(true),
			attempt(false),
		];
		expect(evaluateDegradation("Brave", "search", firstDrop)).toMatch(/success rate 38%/);
		expect(evaluateDegradation("Brave", "search", [...firstDrop, attempt(false)])).toBeNull();
	});
});

describe("recordEffectiveness persistence", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-search-effectiveness-"));
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("persists outcomes and emits the consecutive-failure warning once", async () => {
		const notices: string[] = [];
		const fail = () =>
			recordEffectiveness({
				backend: "tavily",
				label: "Tavily",
				op: "search",
				ok: false,
				latencyMs: 12,
				errorClass: "http_429",
			});

		expect(await fail()).toBeNull();
		expect(await fail()).toBeNull();
		expect(await fail()).toBe("Search Hub: Tavily search failed 3 times in a row (http_429).");
		expect(await fail()).toBeNull();

		await reportEffectiveness({
			backend: "tavily",
			label: "Tavily",
			op: "search",
			ok: false,
			latencyMs: 8,
			error: new Error("API error (429): x"),
			signal: AbortSignal.abort(),
			onNotice: (message) => notices.push(message),
		});
		expect(notices).toEqual([]);

		const stored = JSON.parse(readFileSync(getEffectivenessPath(), "utf8")) as {
			keys: Record<string, EffectivenessAttempt[]>;
		};
		expect(stored.keys["tavily:search"]).toHaveLength(4);
		expect(stored.keys["tavily:search"]?.every((entry) => entry.ok === false)).toBe(true);
	});

	it("caps stored attempts per backend and operation", async () => {
		for (let index = 0; index < MAX_ATTEMPTS_PER_KEY + 3; index++) {
			await recordEffectiveness({
				backend: "jina",
				label: "Jina",
				op: "read",
				ok: true,
				latencyMs: 4,
				resultCount: 20,
			});
		}
		const stored = JSON.parse(readFileSync(getEffectivenessPath(), "utf8")) as {
			keys: Record<string, EffectivenessAttempt[]>;
		};
		expect(stored.keys["jina:read"]).toHaveLength(MAX_ATTEMPTS_PER_KEY);
	});
});
