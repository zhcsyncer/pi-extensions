import { access, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CompanionConfigStore,
	DEFAULT_CONFIG,
	parseCompanionConfig,
} from "../src/config.ts";
import {
	appendRuntimePrompt,
	buildRuntimePrompt,
	captureRuntimeSnapshot,
	hasUsableHerdrRuntime,
} from "../src/runtime.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("runtime snapshot", () => {
	it("captures Herdr caller facts once and renders the stable contract block", () => {
		const environment = {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w3:pE",
			HERDR_TAB_ID: "w3:t7",
			HERDR_WORKSPACE_ID: "w3",
			HERDR_SOCKET_PATH: "/tmp/herdr.sock",
		};
		const snapshot = captureRuntimeSnapshot(environment);
		environment.HERDR_PANE_ID = "w9:p9";
		expect(snapshot).toEqual({
			inside: true,
			paneId: "w3:pE",
			tabId: "w3:t7",
			workspaceId: "w3",
			socketPath: "/tmp/herdr.sock",
		});
		expect(hasUsableHerdrRuntime(snapshot)).toBe(true);
		expect(buildRuntimePrompt(snapshot)).toBe([
			"## Runtime: Herdr companion",
			"inside: true",
			"pane: w3:pE",
			"tab: w3:t7",
			"workspace: w3",
			"For dev/preview/watch use herdr_process; do not probe HERDR_ENV or use nohup/&/disown.",
			"/btw opens an independent Herdr Pi side thread; it enters the parent context only after explicit merge.",
		].join("\n"));
	});

	it("renders a clear outside-Herdr fallback and never duplicates the block", () => {
		const block = buildRuntimePrompt(captureRuntimeSnapshot({}));
		expect(block).toContain("inside: false");
		expect(block).toContain("Use tmux for long-running processes");
		const once = appendRuntimePrompt("base", block);
		expect(appendRuntimePrompt(once, block)).toBe(once);
		expect(once.match(/## Runtime: Herdr companion/g)).toHaveLength(1);
	});

	it("renders partial Herdr identity as degraded without advertising an unregistered tool", () => {
		const snapshot = captureRuntimeSnapshot({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" });
		expect(hasUsableHerdrRuntime(snapshot)).toBe(false);
		const prompt = buildRuntimePrompt(snapshot);
		expect(prompt).toContain("availability: degraded/unavailable");
		expect(prompt).toContain("socket path");
		expect(prompt).not.toContain("herdr_process");
	});
});

describe("global companion config", () => {
	it("uses defaults without creating a missing config file", async () => {
		const root = await mkdtemp(join(tmpdir(), "companion-config-"));
		roots.push(root);
		const path = join(root, "herdr-companion.json");
		const store = new CompanionConfigStore(path);
		expect(await store.load()).toEqual(DEFAULT_CONFIG);
		await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("validates, writes atomically with private permissions, and reloads", async () => {
		const root = await mkdtemp(join(tmpdir(), "companion-config-"));
		roots.push(root);
		const path = join(root, "herdr-companion.json");
		const store = new CompanionConfigStore(path);
		const config = parseCompanionConfig({
			process: { defaultDirection: "right", defaultRatio: 0.4, readyTimeoutMs: 5000, defaultLifetime: "persistent" },
			btw: { autoSubmit: true, model: "openai/gpt", thinking: "high", tools: "read-only", split: "right" },
		});
		await store.save(config);
		expect(await store.load()).toEqual(config);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(config);
		if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
	});

	it("rejects unsafe or malformed options rather than silently widening behavior", () => {
		expect(() => parseCompanionConfig({ process: { defaultRatio: 1 } })).toThrow(/between 0.1 and 0.9/);
		expect(() => parseCompanionConfig({ btw: { model: "not-a-model" } })).toThrow(/provider\/model/);
		expect(() => parseCompanionConfig({ blocked: { askUserQuestion: "yes" } })).toThrow(/true or false/);
	});
});
