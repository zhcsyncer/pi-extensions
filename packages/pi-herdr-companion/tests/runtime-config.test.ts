import { access, chmod, mkdir, mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	CompanionConfigStore,
	DEFAULT_CONFIG,
	getCompanionConfigPath,
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
		expect(buildRuntimePrompt(snapshot, { includeTuiFeatures: true })).toBe([
			"## Runtime: Herdr companion",
			"inside: true",
			"pane: w3:pE",
			"tab: w3:t7",
			"workspace: w3",
			"For dev/preview/watch use herdr_process; do not probe HERDR_ENV or use nohup/&/disown.",
			"/btw is session-scoped: in a parent session, /btw <question> opens an independent side thread; in a side pane, /btw merge <follow-up> requests an explicit merge back to the parent.",
		].join("\n"));
	});

	it("never injects a block outside Herdr or with incomplete caller identity", () => {
		const outside = buildRuntimePrompt(captureRuntimeSnapshot({}));
		const incomplete = buildRuntimePrompt(captureRuntimeSnapshot({ HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1" }));
		expect(outside).toBe("");
		expect(incomplete).toBe("");
		expect(appendRuntimePrompt("base", outside)).toBe("base");
		expect(appendRuntimePrompt("base", incomplete)).toBe("base");
	});

	it("keeps TUI-only capabilities out of the core block and never duplicates it", () => {
		const block = buildRuntimePrompt(captureRuntimeSnapshot({
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:p1",
			HERDR_SOCKET_PATH: "/tmp/herdr.sock",
		}));
		expect(block).not.toContain("/btw");
		const once = appendRuntimePrompt("base", block);
		expect(appendRuntimePrompt(once, block)).toBe(once);
		expect(once.match(/## Runtime: Herdr companion/g)).toHaveLength(1);
	});
});

describe("global companion config", () => {
	it("defaults to Bash transport on POSIX and raw pane mode on Windows", () => {
		expect(DEFAULT_CONFIG.process.defaultShell).toBe(process.platform === "win32" ? "pane" : "bash");
	});

	it("uses the extension-data path and defaults without creating a missing file", async () => {
		const root = await mkdtemp(join(tmpdir(), "companion-config-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		const path = getCompanionConfigPath(agentDir);
		const store = new CompanionConfigStore(path);
		expect(path).toBe(join(agentDir, "extension-data", "pi-herdr-companion", "config.json"));
		expect(await store.load()).toEqual(DEFAULT_CONFIG);
		await expect(access(path)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("writes atomically with private file permissions without chmodding the shared agent directory", async () => {
		const root = await mkdtemp(join(tmpdir(), "companion-config-"));
		roots.push(root);
		const agentDir = join(root, "agent");
		await mkdir(agentDir, { mode: 0o750 });
		if (process.platform !== "win32") await chmod(agentDir, 0o750);
		const path = getCompanionConfigPath(agentDir);
		const store = new CompanionConfigStore(path);
		const config = parseCompanionConfig({
			process: { defaultDirection: "right", defaultRatio: 0.4, readyTimeoutMs: 5000, defaultLifetime: "persistent", defaultShell: "pane" },
			blocked: {
				events: [{ name: "review:blocked", label: "review" }],
				tools: [{ name: "approval_tool", label: "approval" }],
			},
		});
		await store.save(config);
		expect(await store.load()).toEqual(config);
		expect(JSON.parse(await readFile(path, "utf8"))).toEqual(config);
		if (process.platform !== "win32") {
			expect((await stat(path)).mode & 0o777).toBe(0o600);
			expect((await stat(agentDir)).mode & 0o777).toBe(0o750);
		}
	});

	it("rejects unsafe, unknown, or malformed options rather than silently widening behavior", () => {
		expect(() => parseCompanionConfig({ process: { defaultRatio: 1 } })).toThrow(/between 0.1 and 0.9/);
		expect(() => parseCompanionConfig({ process: { defaultShell: "fish" } })).toThrow(/bash or pane/);
		expect(() => parseCompanionConfig({ btw: {} })).toThrow(/config\.btw is not supported/);
		expect(() => parseCompanionConfig({ blocked: { oldField: true } })).toThrow(/not supported/);
		expect(() => parseCompanionConfig({ futureSection: {} })).toThrow(/not supported/);
		expect(() => parseCompanionConfig({ blocked: { events: [{ name: "herdr:blocked", label: "loop" }] } }))
			.toThrow(/must not proxy/);
		expect(() => parseCompanionConfig({ blocked: { tools: [{ name: "bad tool", label: "bad" }] } }))
			.toThrow(/without whitespace/);
	});
});
