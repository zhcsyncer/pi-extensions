import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { getConfig, loadConfig, refreshConfig } from "../extensions/config.js";
import { resolveBackendKey } from "../extensions/credentials.js";
import { resetSearchConfigMigrationNoticesForTests } from "../extensions/config-storage.js";
import { incrementExaUsage, resetExaUsageNoticesForTests } from "../extensions/exa-usage.js";
import {
	getExaUsagePath,
	getGlobalConfigPath,
	getLegacyExaUsagePath,
	getLegacyGlobalConfigPath,
	getLegacyProjectConfigPath,
	getProjectConfigPath,
} from "../extensions/paths.js";

function writeJson(file: string, value: unknown): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
}

describe("Search Hub storage migration", () => {
	let root: string;
	let cwd: string;

	beforeEach(() => {
		root = mkdtempSync(join(tmpdir(), "pi-search-storage-"));
		cwd = join(root, "project");
		mkdirSync(cwd, { recursive: true });
		vi.stubEnv("PI_CODING_AGENT_DIR", join(root, "agent"));
		resetSearchConfigMigrationNoticesForTests();
		resetExaUsageNoticesForTests();
	});

	afterEach(() => {
		vi.unstubAllEnvs();
		rmSync(root, { recursive: true, force: true });
	});

	it("migrates and upgrades global config while reporting discarded fields", () => {
		const legacy = getLegacyGlobalConfigPath();
		const target = getGlobalConfigPath();
		writeJson(legacy, {
			combine: true,
			reader: "firecrawl",
			obsolete: true,
			backends: {
				firecrawl: { enabled: true, apiKey: "fc-test-key" },
				serper: { enabled: true, apiKey: "SERPER_KEY", removed: 1 },
			},
		});
		const notices: string[] = [];

		const loaded = loadConfig(cwd, false, (message) => notices.push(message));

		expect(loaded.reader).toBe("firecrawl");
		expect(loaded.backends?.firecrawl).toEqual({ enabled: true, apiKey: "fc-test-key" });
		expect(resolveBackendKey("firecrawl", loaded)).toBe("fc-test-key");
		expect(loaded.backends?.serper).toEqual({ enabled: true, apiKey: "SERPER_KEY" });
		expect(readFileSync(target, "utf8")).not.toContain("obsolete");
		expect(readFileSync(target, "utf8")).not.toContain("removed");
		expect(() => statSync(legacy)).toThrow();
		expect(notices.join("\n")).toContain("obsolete");
		expect(notices.join("\n")).toContain("backends.serper.removed");
		expect(statSync(target).mode & 0o777).toBe(0o600);
	});

	it("migrates project config only when the project is trusted", () => {
		const legacy = getLegacyProjectConfigPath(cwd);
		writeJson(legacy, { compact: true });

		expect(loadConfig(cwd, false).compact).toBeUndefined();
		expect(readFileSync(legacy, "utf8")).toContain("compact");
		expect(loadConfig(cwd, true).compact).toBe(true);
		expect(readFileSync(getProjectConfigPath(cwd), "utf8")).toContain("compact");
		expect(() => statSync(legacy)).toThrow();
	});

	it("keys the runtime cache by cwd and trust", () => {
		writeJson(getGlobalConfigPath(), { compact: false });
		writeJson(getProjectConfigPath(cwd), { compact: true });

		refreshConfig(cwd, false, true);
		expect(getConfig().compact).toBe(false);
		refreshConfig(cwd, true, false);
		expect(getConfig().compact).toBe(true);
	});

	it("preserves an unparsable legacy config", () => {
		const legacy = getLegacyGlobalConfigPath();
		mkdirSync(dirname(legacy), { recursive: true });
		writeFileSync(legacy, "{");
		const notices: string[] = [];

		expect(loadConfig(cwd, false, (message) => notices.push(message)).backends).toEqual({});
		expect(readFileSync(legacy, "utf8")).toBe("{");
		expect(() => statSync(getGlobalConfigPath())).toThrow();
		expect(notices.join("\n")).toContain("preserved");
	});

	it("migrates Exa usage and serializes concurrent increments", async () => {
		writeJson(getLegacyExaUsagePath(), {
			count: 10,
			resetAt: new Date(new Date().getFullYear(), new Date().getMonth(), 1).toISOString(),
			obsolete: true,
		});

		await Promise.all([incrementExaUsage(), incrementExaUsage()]);

		const saved = JSON.parse(readFileSync(getExaUsagePath(), "utf8")) as { count: number; obsolete?: boolean };
		expect(saved.count).toBe(12);
		expect(saved.obsolete).toBeUndefined();
		expect(() => statSync(getLegacyExaUsagePath())).toThrow();
		expect(statSync(getExaUsagePath()).mode & 0o777).toBe(0o600);
	});
});
