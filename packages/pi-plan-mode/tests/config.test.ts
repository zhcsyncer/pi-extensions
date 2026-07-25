import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	DEFAULT_PLAN_MODE_CONFIG,
	getPlanModeConfigPath,
	loadPlanModeConfig,
	parsePlanModeConfig,
} from "../src/config.ts";

const cleanup = new Set<string>();

afterEach(async () => {
	await Promise.all([...cleanup].map((directory) => rm(directory, { recursive: true, force: true })));
	cleanup.clear();
});

async function agentDir(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-plan-config-test-"));
	cleanup.add(directory);
	return directory;
}

describe("Plan Mode config", () => {
	it("defaults to auto when the config file or field is missing", async () => {
		const directory = await agentDir();
		expect(await loadPlanModeConfig(directory)).toEqual({
			config: DEFAULT_PLAN_MODE_CONFIG,
			path: getPlanModeConfigPath(directory),
		});
		expect(parsePlanModeConfig({})).toEqual({ contentLanguage: "auto" });
	});

	it.each(["auto", "en", "zh-CN"] as const)("loads supported content language %s", async (contentLanguage) => {
		const directory = await agentDir();
		await writeFile(getPlanModeConfigPath(directory), `${JSON.stringify({ contentLanguage })}\n`, "utf8");
		expect(await loadPlanModeConfig(directory)).toEqual({
			config: { contentLanguage },
			path: getPlanModeConfigPath(directory),
		});
	});

	it.each([
		["malformed JSON", "{"],
		["non-object root", "[]"],
		["unsupported language", '{"contentLanguage":"fr"}'],
	])("warns and falls back for %s", async (_label, content) => {
		const directory = await agentDir();
		await writeFile(getPlanModeConfigPath(directory), content, "utf8");
		const loaded = await loadPlanModeConfig(directory);
		expect(loaded.config).toEqual({ contentLanguage: "auto" });
		expect(loaded.warning).toContain("Invalid Plan Mode config");
		expect(loaded.warning).toContain('Using contentLanguage "auto"');
	});
});
