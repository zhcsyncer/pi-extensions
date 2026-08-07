import type { Theme } from "@earendil-works/pi-coding-agent";
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
	DEFAULT_STATUS_ICON_PRESET,
	loadConfig,
	resetTodoConfigNoticesForTests,
	resolveStatusIconPreset,
	resolveStatusIcons,
	STATUS_ICON_PRESETS,
} from "./config.js";
import { getLegacyTodoConfigPaths, getTodoConfigPath } from "./config-paths.js";
import { statusIcon } from "./view/format.js";

const theme = {
	fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
} as unknown as Theme;

function writeJson(path: string, value: unknown): void {
	mkdirSync(dirname(path), { recursive: true });
	writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

describe("Todo config paths and migration", () => {
	let root: string;
	let agentDir: string;
	let home: string;
	let xdgConfigHome: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-todo-config-"));
		agentDir = join(root, "agent");
		home = join(root, "home");
		xdgConfigHome = join(root, "xdg");
		mkdirSync(home, { recursive: true });
		mkdirSync(xdgConfigHome, { recursive: true });
		vi.stubEnv("HOME", home);
		vi.stubEnv("XDG_CONFIG_HOME", xdgConfigHome);
		vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
		resetTodoConfigNoticesForTests();
	});

	afterEach(() => {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		resetTodoConfigNoticesForTests();
		rmSync(root, { recursive: true, force: true });
	});

	it("resolves the canonical agent-dir path and both historical XDG paths", () => {
		expect(getTodoConfigPath()).toBe(join(agentDir, "extension-data", "pi-todo", "config.json"));
		expect(getLegacyTodoConfigPaths()).toEqual([
			join(xdgConfigHome, "rpiv-todo", "config.json"),
			join(home, ".config", "rpiv-todo", "config.json"),
		]);
	});

	it("returns an empty config when no file exists", () => {
		expect(loadConfig()).toEqual({});
	});

	it("reads canonical config without changing statusIcons or guidance validation semantics", () => {
		writeJson(getTodoConfigPath(), {
			statusIcons: "invalid-preset",
			guidance: { promptSnippet: 42, promptGuidelines: ["valid", ""] },
			futureField: true,
		});

		const loaded = loadConfig() as Record<string, unknown>;
		expect(loaded.statusIcons).toBe("invalid-preset");
		expect(resolveStatusIconPreset(loaded.statusIcons)).toBe("ascii");
		expect(loaded.guidance).toEqual({ promptSnippet: 42, promptGuidelines: ["valid", ""] });
		expect(loaded.futureField).toBe(true);
	});

	it("atomically migrates XDG config, verifies it, and removes only the migrated file", () => {
		const [legacyPath] = getLegacyTodoConfigPaths();
		writeJson(legacyPath!, {
			statusIcons: "unicode",
			guidance: { promptSnippet: "Custom todo" },
		});
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({
			statusIcons: "unicode",
			guidance: { promptSnippet: "Custom todo" },
		});
		expect(existsSync(legacyPath!)).toBe(false);
		expect(JSON.parse(readFileSync(getTodoConfigPath(), "utf8"))).toEqual({
			statusIcons: "unicode",
			guidance: { promptSnippet: "Custom todo" },
		});
		expect(readdirSync(dirname(getTodoConfigPath()))).toEqual(["config.json"]);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Migrated config"));
	});

	it("preserves valid legacy JSON bytes whose numbers cannot survive stringify", () => {
		const [legacyPath] = getLegacyTodoConfigPaths();
		const source = '{"statusIcons":"unicode","futureNumber":1e400}\n';
		mkdirSync(dirname(legacyPath!), { recursive: true });
		writeFileSync(legacyPath!, source, "utf8");
		vi.spyOn(console, "warn").mockImplementation(() => {});

		const loaded = loadConfig() as Record<string, unknown>;
		expect(loaded.statusIcons).toBe("unicode");
		expect(loaded.futureNumber).toBe(Number.POSITIVE_INFINITY);
		expect(readFileSync(getTodoConfigPath(), "utf8")).toBe(source);
		expect(existsSync(legacyPath!)).toBe(false);
	});

	it("falls back to the default ~/.config legacy path when the XDG file is absent", () => {
		const [, fallbackPath] = getLegacyTodoConfigPaths();
		writeJson(fallbackPath!, { statusIcons: "nerd-font" });
		vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({ statusIcons: "nerd-font" });
		expect(existsSync(fallbackPath!)).toBe(false);
		expect(existsSync(getTodoConfigPath())).toBe(true);
	});

	it("keeps conflicting legacy data and warns only once while canonical wins", () => {
		const [legacyPath] = getLegacyTodoConfigPaths();
		writeJson(getTodoConfigPath(), { statusIcons: "ascii" });
		writeJson(legacyPath!, { statusIcons: "unicode" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({ statusIcons: "ascii" });
		expect(loadConfig()).toEqual({ statusIcons: "ascii" });
		expect(existsSync(legacyPath!)).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("conflicting legacy config"));
	});

	it("removes a semantically equivalent legacy file after re-reading canonical config", () => {
		const [legacyPath] = getLegacyTodoConfigPaths();
		writeJson(getTodoConfigPath(), { guidance: { promptSnippet: "same" }, statusIcons: "unicode" });
		writeJson(legacyPath!, { statusIcons: "unicode", guidance: { promptSnippet: "same" } });
		vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig().statusIcons).toBe("unicode");
		expect(existsSync(legacyPath!)).toBe(false);
	});

	it("retains malformed legacy data, creates no canonical file, and de-duplicates warnings", () => {
		const [legacyPath] = getLegacyTodoConfigPaths();
		mkdirSync(dirname(legacyPath!), { recursive: true });
		writeFileSync(legacyPath!, "{ definitely not JSON", "utf8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({});
		expect(loadConfig()).toEqual({});
		expect(existsSync(legacyPath!)).toBe(true);
		expect(existsSync(getTodoConfigPath())).toBe(false);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("unreadable or malformed"));
	});

	it("never replaces malformed canonical config with valid legacy data", () => {
		const [legacyPath] = getLegacyTodoConfigPaths();
		mkdirSync(dirname(getTodoConfigPath()), { recursive: true });
		writeFileSync(getTodoConfigPath(), "not JSON", "utf8");
		writeJson(legacyPath!, { statusIcons: "unicode" });
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({});
		expect(readFileSync(getTodoConfigPath(), "utf8")).toBe("not JSON");
		expect(existsSync(legacyPath!)).toBe(true);
		expect(warn).toHaveBeenCalledTimes(1);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("legacy config was not used or removed"));
	});

	it("does not reclaim an expired-looking lock while its owner PID is alive", () => {
		const [legacyPath] = getLegacyTodoConfigPaths();
		writeJson(legacyPath!, { statusIcons: "unicode" });
		const lockPath = join(dirname(getTodoConfigPath()), `.config-migration.lock.${process.pid}.existing`);
		mkdirSync(dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, "existing owner\n", "utf8");
		const now = Date.now();
		const expiredAt = new Date(now - 31_000);
		utimesSync(lockPath, expiredAt, expiredAt);
		vi.spyOn(Date, "now").mockReturnValueOnce(now).mockReturnValue(now + 1_001);
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({ statusIcons: "unicode" });
		expect(readFileSync(lockPath, "utf8")).toBe("existing owner\n");
		expect(existsSync(legacyPath!)).toBe(true);
		expect(existsSync(getTodoConfigPath())).toBe(false);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("timed out waiting"));
	});

	it("safely removes an expired unique lock before restarting the migration state machine", () => {
		const [legacyPath] = getLegacyTodoConfigPaths();
		writeJson(legacyPath!, { statusIcons: "unicode" });
		const lockPath = join(dirname(getTodoConfigPath()), ".config-migration.lock.999999.expired");
		mkdirSync(dirname(lockPath), { recursive: true });
		writeFileSync(lockPath, "expired owner\n", "utf8");
		const expiredAt = new Date(Date.now() - 31_000);
		utimesSync(lockPath, expiredAt, expiredAt);
		vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({ statusIcons: "unicode" });
		expect(existsSync(lockPath)).toBe(false);
		expect(existsSync(legacyPath!)).toBe(false);
		expect(readdirSync(dirname(getTodoConfigPath()))).toEqual(["config.json"]);
	});

	it("uses valid legacy config as a runtime fallback when the canonical write fails", () => {
		const [legacyPath] = getLegacyTodoConfigPaths();
		writeJson(legacyPath!, { statusIcons: "unicode" });
		mkdirSync(agentDir, { recursive: true });
		writeFileSync(join(agentDir, "extension-data"), "blocks canonical directory creation", "utf8");
		const warn = vi.spyOn(console, "warn").mockImplementation(() => {});

		expect(loadConfig()).toEqual({ statusIcons: "unicode" });
		expect(existsSync(legacyPath!)).toBe(true);
		expect(existsSync(getTodoConfigPath())).toBe(false);
		expect(warn).toHaveBeenCalledWith(expect.stringContaining("Failed to migrate or reconcile"));
	});
});

describe("status icon presets", () => {
	it("defaults invalid or missing values to ASCII", () => {
		expect(DEFAULT_STATUS_ICON_PRESET).toBe("ascii");
		expect(resolveStatusIconPreset(undefined)).toBe("ascii");
		expect(resolveStatusIconPreset("unknown")).toBe("ascii");
		expect(resolveStatusIcons(undefined)).toBe(STATUS_ICON_PRESETS.ascii);
	});

	it("exposes independent heading icons and the selected status symbols", () => {
		expect(resolveStatusIcons("ascii").heading).toBe("[T]");
		expect(resolveStatusIcons("unicode")).toMatchObject({ heading: "≡", pending: "○", completed: "✓" });
		expect(resolveStatusIcons("nerd-font").heading).toBe("󰝖");
		expect(resolveStatusIcons("unicode").inProgressFrames).toEqual(["◉"]);
		expect(resolveStatusIcons("nerd-font").inProgressFrames).toEqual([
			"󰪞",
			"󰪟",
			"󰪠",
			"󰪡",
			"󰪢",
			"󰪣",
			"󰪤",
			"󰪥",
		]);
	});

	it("applies semantic theme colors independently of the selected glyph set", () => {
		const icons = STATUS_ICON_PRESETS.unicode;
		expect(statusIcon("pending", theme, icons)).toBe("<dim>○</dim>");
		expect(statusIcon("in_progress", theme, icons)).toBe("<accent>◉</accent>");
		expect(statusIcon("completed", theme, icons)).toBe("<success>✓</success>");
		expect(statusIcon("deleted", theme, icons)).toBe("<error>✗</error>");
	});
});
