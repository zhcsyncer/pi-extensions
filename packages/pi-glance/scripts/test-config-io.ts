import { strict as assert } from "node:assert";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { GlanceConfig } from "../types.js";

interface ConfigModule {
	defaultConfig(): GlanceConfig;
	normalizeConfig(raw: unknown): GlanceConfig;
	configFromText(text: string): GlanceConfig;
	configToText(config: GlanceConfig): string;
	loadConfigSync(): GlanceConfig;
	loadConfig(): Promise<GlanceConfig>;
	saveConfig(config: GlanceConfig): Promise<void>;
}

async function writeConfigText(configPath: string, text: string): Promise<void> {
	await mkdir(dirname(configPath), { recursive: true });
	await writeFile(configPath, text, "utf8");
}

async function main(): Promise<void> {
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	const agentDir = await mkdtemp(join(tmpdir(), "pi-glance-config-io-"));
	process.env.PI_CODING_AGENT_DIR = agentDir;

	try {
		// CONFIG_PATH is computed when config.js is imported, so set the isolated
		// agent dir before this dynamic import to avoid touching real user config.
		const configModule = (await import(`../config.js?config-io=${process.pid}-${Date.now()}`)) as ConfigModule;
		const { configFromText, configToText, defaultConfig, loadConfig, loadConfigSync, normalizeConfig, saveConfig } = configModule;
		const configPath = join(agentDir, "pi-glance", "config.json");

		assert.deepEqual(loadConfigSync(), defaultConfig(), "missing config file should make loadConfigSync fall back to defaults");
		assert.deepEqual(await loadConfig(), defaultConfig(), "missing config file should make async loadConfig fall back to defaults");

		await writeConfigText(configPath, "{");
		assert.deepEqual(loadConfigSync(), defaultConfig(), "invalid JSON should make loadConfigSync fall back to defaults");
		assert.deepEqual(await loadConfig(), defaultConfig(), "invalid JSON should make async loadConfig fall back to defaults");

		const partialRaw = { enabled: false, icons: "nerd" };
		const partialExpected = normalizeConfig(partialRaw);
		await writeConfigText(configPath, JSON.stringify(partialRaw));
		assert.deepEqual(configFromText(await readFile(configPath, "utf8")), partialExpected, "configFromText should parse and normalize valid partial config file text");
		assert.deepEqual(loadConfigSync(), partialExpected, "loadConfigSync should read and normalize valid partial config text");
		assert.deepEqual(await loadConfig(), partialExpected, "async loadConfig should read and normalize valid partial config text");

		const nextConfig = normalizeConfig({
			enabled: false,
			theme: { light: "one-light", dark: "tokyo-night" },
			icons: "nerd",
			display: { adaptive: false, workspaceLabel: "path", showProvider: "always" },
			git: { shaMode: "always", pollIntervalMs: 30000 },
			tokens: { display: "total", cache: "show" },
		});
		await saveConfig(nextConfig);
		const savedText = await readFile(configPath, "utf8");
		assert.equal(savedText, configToText(nextConfig), "saveConfig should write configToText output exactly");
		assert.deepEqual(JSON.parse(savedText).theme, { light: "one-light", dark: "tokyo-night" }, "saveConfig should serialize the current theme pair shape");
		assert.equal("adaptive" in JSON.parse(savedText).display, false, "saveConfig should drop the legacy adaptive width setting because fitting is always on");
		assert.deepEqual(configFromText(savedText), normalizeConfig(nextConfig), "configFromText should round-trip saveConfig output");
		assert.deepEqual(loadConfigSync(), normalizeConfig(nextConfig), "loadConfigSync should round-trip saved config");
		assert.deepEqual(await loadConfig(), normalizeConfig(nextConfig), "async loadConfig should round-trip saved config");

		await writeConfigText(configPath, "{");
		const validConfig = normalizeConfig({ enabled: true, theme: "tokyo-night", context: { display: "tokens", unknown: "hide" } });
		await saveConfig(validConfig);
		assert.equal(await readFile(configPath, "utf8"), configToText(validConfig), "saveConfig should overwrite invalid config with valid config text");
		assert.deepEqual(loadConfigSync(), normalizeConfig(validConfig), "loadConfigSync should read overwritten valid config");
		assert.deepEqual(await loadConfig(), normalizeConfig(validConfig), "async loadConfig should read overwritten valid config");
	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(agentDir, { recursive: true, force: true });
	}
}

await main();
console.log("✓ config IO round-trip checks passed");
