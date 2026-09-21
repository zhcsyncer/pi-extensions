import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { isKeyRotationError, withRotatedKeys } from "../extensions/credentials.js";
import { getKeyCursorsPath } from "../extensions/paths.js";
import { refreshConfig, getActiveBackends } from "../extensions/config.js";

describe("isKeyRotationError", () => {
	it("rotates only on 429, 402, 432, or quota exhaustion", () => {
		expect(isKeyRotationError(new Error("API error (429): slow down"))).toBe(true);
		expect(isKeyRotationError(new Error("API error (402): payment required"))).toBe(true);
		expect(isKeyRotationError(new Error("API error (432): plan limit"))).toBe(true);
		expect(isKeyRotationError(new Error("quota exceeded for this key"))).toBe(true);
		expect(isKeyRotationError(new Error("API error (503): upstream"))).toBe(false);
		expect(isKeyRotationError(new Error("API error (401): unauthorized"))).toBe(false);
		expect(isKeyRotationError(new Error("The operation was aborted due to timeout"))).toBe(false);
	});
});

describe("withRotatedKeys", () => {
	let root: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-search-key-rotation-"));
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
		mkdirSync(join(root, "agent"), { recursive: true });
	});

	afterEach(() => {
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	});

	it("does not rotate on ordinary errors", async () => {
		const tried: string[] = [];
		await expect(withRotatedKeys("tavily", ["k1", "k2"], async (key) => {
			tried.push(key);
			throw new Error("API error (503): upstream");
		})).rejects.toThrow(/503/);
		expect(tried).toEqual(["k1"]);
	});

	it("rotates on 429, persists the cursor, and starts there next time", async () => {
		const firstTried: string[] = [];
		const result = await withRotatedKeys("tavily", ["k1", "k2"], async (key) => {
			firstTried.push(key);
			if (key === "k1") throw new Error("API error (429): rate limit");
			return "ok";
		});
		expect(result).toBe("ok");
		expect(firstTried).toEqual(["k1", "k2"]);

		const saved = JSON.parse(readFileSync(getKeyCursorsPath(), "utf8")) as Record<string, { index: number }>;
		expect(saved.tavily.index).toBe(1);

		const secondTried: string[] = [];
		await withRotatedKeys("tavily", ["k1", "k2"], async (key) => {
			secondTried.push(key);
			return "again";
		});
		expect(secondTried).toEqual(["k2"]);
	});

	it("resets the cursor when the key list changes", async () => {
		await withRotatedKeys("exa", ["a", "b"], async (key) => {
			if (key === "a") throw new Error("quota exhausted");
			return "ok";
		});
		const tried: string[] = [];
		await withRotatedKeys("exa", ["a", "b", "c"], async (key) => {
			tried.push(key);
			return "ok";
		});
		expect(tried).toEqual(["a"]);
	});
});

describe("keyless fallback", () => {
	let root: string;
	let previousHome: string | undefined;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-search-keyless-"));
		previousHome = process.env.HOME;
		process.env.HOME = root;
		process.env.PI_CODING_AGENT_DIR = join(root, "agent");
	});

	afterEach(() => {
		if (previousHome === undefined) delete process.env.HOME;
		else process.env.HOME = previousHome;
		delete process.env.PI_CODING_AGENT_DIR;
		rmSync(root, { recursive: true, force: true });
	});

	it("uses firecrawl when no backend is enabled", () => {
		expect(refreshConfig(join(root, "project"), false, true)).toEqual(["firecrawl"]);
		expect(getActiveBackends()).toEqual(["firecrawl"]);
	});
});
