import {
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	readdirSync,
	rmSync,
	utimesSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	type AskUserQuestionConfig,
	COLLAPSE_KEY_OFF,
	DEFAULT_COLLAPSE_KEY,
	loadConfig,
	resetAskUserQuestionConfigNoticesForTests,
	resolveCollapseKey,
} from "./config.js";
import {
	getAskUserQuestionConfigPath,
	getLegacyAskUserQuestionConfigPaths,
} from "./config-paths.js";

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("resolveCollapseKey", () => {
	it("returns the default when config has no collapseKey", () => {
		expect(resolveCollapseKey({})).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: undefined })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("returns the default when collapseKey is empty or whitespace", () => {
		expect(resolveCollapseKey({ collapseKey: "" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "   " })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("normalizes the spec (trim + lowercase)", () => {
		expect(resolveCollapseKey({ collapseKey: "  Ctrl+}  " })).toBe("ctrl+}");
		expect(resolveCollapseKey({ collapseKey: "ALT+O" })).toBe("alt+o");
	});

	it("returns the off sentinel unchanged (case-insensitive)", () => {
		expect(resolveCollapseKey({ collapseKey: "off" })).toBe(COLLAPSE_KEY_OFF);
		expect(resolveCollapseKey({ collapseKey: "OFF" })).toBe(COLLAPSE_KEY_OFF);
		expect(resolveCollapseKey({ collapseKey: "  off  " })).toBe(COLLAPSE_KEY_OFF);
	});

	it("falls back to the default for malformed specs", () => {
		expect(resolveCollapseKey({ collapseKey: "+ctrl+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl++" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl+]" })).toBe("ctrl+]");
		expect(resolveCollapseKey({ collapseKey: "ctrl+shift+h" })).toBe("ctrl+shift+h");
	});

	it("falls back to the default for typo'd modifiers and unknown key names", () => {
		expect(resolveCollapseKey({ collapseKey: "ctr+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "control+]" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl+nosuchkey" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "hello" })).toBe(DEFAULT_COLLAPSE_KEY);
		expect(resolveCollapseKey({ collapseKey: "ctrl+ctrl+]" })).toBe(DEFAULT_COLLAPSE_KEY);
	});

	it("accepts named special keys and bare base keys", () => {
		expect(resolveCollapseKey({ collapseKey: "ctrl+pageup" })).toBe("ctrl+pageup");
		expect(resolveCollapseKey({ collapseKey: "Ctrl+PageUp" })).toBe("ctrl+pageup");
		expect(resolveCollapseKey({ collapseKey: "f5" })).toBe("f5");
		expect(resolveCollapseKey({ collapseKey: "alt+escape" })).toBe("alt+escape");
	});
});

describe("Ask User Question config paths and migration", () => {
	let root: string;
	let agentDir: string;
	let home: string;
	let xdgConfigHome: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-ask-config-"));
		agentDir = join(root, "agent");
		home = join(root, "home");
		xdgConfigHome = join(root, "xdg");
		mkdirSync(home, { recursive: true });
		mkdirSync(xdgConfigHome, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("XDG_CONFIG_HOME", xdgConfigHome);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		resetAskUserQuestionConfigNoticesForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		resetAskUserQuestionConfigNoticesForTests();
		rmSync(root, { recursive: true, force: true });
	});

	it("resolves the canonical agent-dir path and historical XDG fallback paths", () => {
		expect(getAskUserQuestionConfigPath()).toBe(
			join(agentDir, "extension-data", "pi-ask-user-question", "config.json"),
		);
		expect(getLegacyAskUserQuestionConfigPaths()).toEqual([
			join(xdgConfigHome, "rpiv-ask-user-question", "config.json"),
			join(home, ".config", "rpiv-ask-user-question", "config.json"),
		]);
	});

	it("returns an empty config when no file is present", () => {
		expect(loadConfig()).toEqual({});
	});

	it("reads canonical JSON while preserving invalid collapseKey and guidance values", () => {
		writeJson(getAskUserQuestionConfigPath(), {
			collapseKey: "ctr+]",
			guidance: { promptSnippet: 123 },
			futureField: true,
		});

		const loaded = loadConfig() as AskUserQuestionConfig & Record<string, unknown>;
		expect(loaded.collapseKey).toBe("ctr+]");
		expect(resolveCollapseKey(loaded)).toBe(DEFAULT_COLLAPSE_KEY);
		expect(loaded.guidance).toEqual({ promptSnippet: 123 });
		expect(loaded.futureField).toBe(true);
	});

	it("atomically migrates the XDG file and semantically verifies canonical data", () => {
		const [legacyPath] = getLegacyAskUserQuestionConfigPaths();
		writeJson(legacyPath!, { collapseKey: "alt+o", guidance: { promptSnippet: "Ask" } });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({ collapseKey: "alt+o", guidance: { promptSnippet: "Ask" } });
		expect(existsSync(legacyPath!)).toBe(false);
		expect(JSON.parse(readFileSync(getAskUserQuestionConfigPath(), "utf8"))).toEqual({
			collapseKey: "alt+o",
			guidance: { promptSnippet: "Ask" },
		});
		expect(readdirSync(dirname(getAskUserQuestionConfigPath()))).toEqual(["config.json"]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Migrated config"));
	});

	it("preserves valid legacy JSON bytes whose numbers cannot survive stringify", () => {
		const [legacyPath] = getLegacyAskUserQuestionConfigPaths();
		const source = '{"collapseKey":"alt+o","futureNumber":1e400}\n';
		mkdirSync(dirname(legacyPath!), { recursive: true });
		writeFileSync(legacyPath!, source, "utf8");
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const loaded = loadConfig() as AskUserQuestionConfig & Record<string, unknown>;
		expect(loaded.collapseKey).toBe("alt+o");
		expect(loaded.futureNumber).toBe(Number.POSITIVE_INFINITY);
		expect(readFileSync(getAskUserQuestionConfigPath(), "utf8")).toBe(source);
		expect(existsSync(legacyPath!)).toBe(false);
	});

	it("preserves the historical ~/.config fallback when XDG has no file", () => {
		const [, fallbackPath] = getLegacyAskUserQuestionConfigPaths();
		writeJson(fallbackPath!, { collapseKey: "ctrl+pageup" });
		vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({ collapseKey: "ctrl+pageup" });
		expect(existsSync(fallbackPath!)).toBe(false);
		expect(existsSync(getAskUserQuestionConfigPath())).toBe(true);
	});

	it("keeps conflicting legacy data and warns only once while canonical wins", () => {
		const [legacyPath] = getLegacyAskUserQuestionConfigPaths();
		writeJson(getAskUserQuestionConfigPath(), { collapseKey: "alt+o" });
		writeJson(legacyPath!, { collapseKey: "ctrl+pageup" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({ collapseKey: "alt+o" });
		expect(loadConfig()).toEqual({ collapseKey: "alt+o" });
		expect(existsSync(legacyPath!)).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("conflicting legacy config"));
	});

	it("removes semantically equivalent legacy JSON despite key-order differences", () => {
		const [legacyPath] = getLegacyAskUserQuestionConfigPaths();
		writeJson(getAskUserQuestionConfigPath(), {
			collapseKey: "alt+o",
			guidance: { promptSnippet: "same" },
		});
		writeJson(legacyPath!, {
			guidance: { promptSnippet: "same" },
			collapseKey: "alt+o",
		});
		vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig().collapseKey).toBe("alt+o");
		expect(existsSync(legacyPath!)).toBe(false);
	});

	it("retains malformed legacy data without creating canonical config and de-duplicates warnings", () => {
		const [legacyPath] = getLegacyAskUserQuestionConfigPaths();
		mkdirSync(dirname(legacyPath!), { recursive: true });
		writeFileSync(legacyPath!, "{ bad JSON", "utf8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({});
		expect(loadConfig()).toEqual({});
		expect(existsSync(legacyPath!)).toBe(true);
		expect(existsSync(getAskUserQuestionConfigPath())).toBe(false);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("unreadable or malformed"));
	});

	it("does not mask malformed canonical config with a valid legacy file", () => {
		const [legacyPath] = getLegacyAskUserQuestionConfigPaths();
		mkdirSync(dirname(getAskUserQuestionConfigPath()), { recursive: true });
		writeFileSync(getAskUserQuestionConfigPath(), "not JSON", "utf8");
		writeJson(legacyPath!, { collapseKey: "alt+o" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({});
		expect(readFileSync(getAskUserQuestionConfigPath(), "utf8")).toBe("not JSON");
		expect(existsSync(legacyPath!)).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacy config was not used or removed"));
	});

	it("does not reclaim an expired-looking lock while its owner PID is alive", () => {
		const [legacyPath] = getLegacyAskUserQuestionConfigPaths();
		writeJson(legacyPath!, { collapseKey: "alt+o" });
		const lockPath = join(dirname(getAskUserQuestionConfigPath()), `.config-migration.lock.${process.pid}.existing`);
		mkdirSync(dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, "existing owner\n", "utf8");
		const now = Date.now();
		const expiredAt = new Date(now - 31_000);
		utimesSync(lockPath, expiredAt, expiredAt);
		vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValue(now + 1_001);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({ collapseKey: "alt+o" });
		expect(readFileSync(lockPath, "utf8")).toBe("existing owner\n");
		expect(existsSync(legacyPath!)).toBe(true);
		expect(existsSync(getAskUserQuestionConfigPath())).toBe(false);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out waiting"));
	});

	it("safely removes an expired unique lock before restarting the migration state machine", () => {
		const [legacyPath] = getLegacyAskUserQuestionConfigPaths();
		writeJson(legacyPath!, { collapseKey: "alt+o" });
		const lockPath = join(dirname(getAskUserQuestionConfigPath()), ".config-migration.lock.999999.expired");
		mkdirSync(dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, "expired owner\n", "utf8");
		const expiredAt = new Date(Date.now() - 31_000);
		utimesSync(lockPath, expiredAt, expiredAt);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({ collapseKey: "alt+o" });
		expect(existsSync(lockPath)).toBe(false);
		expect(existsSync(legacyPath!)).toBe(false);
		expect(readdirSync(dirname(getAskUserQuestionConfigPath()))).toEqual(["config.json"]);
	});

	it("falls back to valid legacy data when the canonical write cannot complete", () => {
		const [legacyPath] = getLegacyAskUserQuestionConfigPaths();
		writeJson(legacyPath!, { collapseKey: "alt+o" });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "extension-data"), "not a directory", "utf8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({ collapseKey: "alt+o" });
		expect(existsSync(legacyPath!)).toBe(true);
		expect(existsSync(getAskUserQuestionConfigPath())).toBe(false);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to migrate or reconcile"));
	});
});
