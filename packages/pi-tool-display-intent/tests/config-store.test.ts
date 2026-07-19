import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
	loadToolDisplayConfig,
	normalizeToolDisplayConfig,
	saveToolDisplayConfig,
	serializeToolDisplayConfigV2,
} from "../src/config-store.ts";
import {
	DEFAULT_TOOL_DISPLAY_CONFIG,
	TOOL_DISPLAY_CONFIG_SCHEMA_URL,
} from "../src/types.ts";

function withTempDir(name: string, run: (dir: string) => void): void {
	const dir = mkdtempSync(join(tmpdir(), name));
	try {
		run(dir);
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

test("config normalization clamps invalid values and migrates legacy read override", () => {
	const config = normalizeToolDisplayConfig({
		registerReadToolOverride: false,
		registerToolOverrides: { bash: false },
		readOutputMode: "invalid",
		searchOutputMode: "count",
		mcpOutputMode: "preview",
		previewLines: 999,
		expandedPreviewMaxLines: -1,
		bashCollapsedLines: 999,
		toolCallStyle: "claude",
		diffViewMode: "stacked",
		diffSplitMinWidth: 1,
		diffCollapsedLines: 999,
		diffWordWrap: false,
	});

	assert.equal(config.registerToolOverrides.read, false);
	assert.equal(config.registerToolOverrides.grep, true);
	assert.equal(config.registerToolOverrides.bash, false);
	assert.equal(config.readOutputMode, DEFAULT_TOOL_DISPLAY_CONFIG.readOutputMode);
	assert.equal(config.searchOutputMode, "count");
	assert.equal(config.mcpOutputMode, "preview");
	assert.equal(config.previewLines, 80);
	assert.equal(config.expandedPreviewMaxLines, 0);
	assert.equal(config.bashCollapsedLines, 80);
	assert.equal(config.toolCallStyle, "claude");
	assert.equal(config.diffViewMode, "unified");
	assert.equal(config.diffSplitMinWidth, 70);
	assert.equal(config.diffCollapsedLines, 240);
	assert.equal(config.diffWordWrap, false);
	assert.equal(config.resultProfile, "minimal");
});

test("config normalization validates toolIntent options independently", () => {
	const normalized = normalizeToolDisplayConfig({
		toolIntent: {
			enabled: false,
			language: "zh-CN",
			maxLength: 999,
		},
	});

	assert.deepEqual(normalized.toolIntent, {
		enabled: false,
		language: "zh-CN",
		maxLength: 256,
	});

	const fallback = normalizeToolDisplayConfig({
		toolIntent: {
			language: "unsupported",
			maxLength: 1,
		},
	});
	assert.equal(fallback.toolIntent.language, DEFAULT_TOOL_DISPLAY_CONFIG.toolIntent.language);
	assert.equal(fallback.toolIntent.maxLength, 16);
});

test("config normalization migrates legacy displaySummary while preferring toolIntent", () => {
	const migrated = normalizeToolDisplayConfig({
		displaySummary: {
			enabled: false,
			required: false,
			language: "zh-CN",
			showInTui: false,
			maxLength: 64,
		},
	});
	assert.deepEqual(migrated.toolIntent, {
		enabled: false,
		language: "zh-CN",
		maxLength: 64,
	});

	const preferred = normalizeToolDisplayConfig({
		toolIntent: { enabled: true, language: "en", maxLength: 80 },
		displaySummary: { enabled: false, language: "zh-CN", maxLength: 32 },
	});
	assert.deepEqual(preferred.toolIntent, {
		enabled: true,
		language: "en",
		maxLength: 80,
	});
});

test("config normalization falls back from unsupported tool call styles", () => {
	assert.equal(
		normalizeToolDisplayConfig({ toolCallStyle: "unsupported" }).toolCallStyle,
		DEFAULT_TOOL_DISPLAY_CONFIG.toolCallStyle,
	);
});

test("config load reports parse errors and never overwrites invalid JSON", () => {
	withTempDir("pi-tool-display-config-load-", (dir) => {
		const configFile = join(dir, "config.json");
		writeFileSync(configFile, "{not-json", "utf8");

		const result = loadToolDisplayConfig(configFile);

		assert.deepEqual(result.config, DEFAULT_TOOL_DISPLAY_CONFIG);
		assert.match(result.error ?? "", /Failed to parse/);
		assert.match(result.error ?? "", /config\.json/);
		assert.equal(readFileSync(configFile, "utf8"), "{not-json");
		assert.equal(existsSync(join(dir, "config.legacy.json")), false);
	});
});

test("legacy config is migrated on load, backed up once, and preserves effective behavior", () => {
	withTempDir("pi-tool-display-config-migrate-", (dir) => {
		const configFile = join(dir, "config.json");
		const legacyConfig = {
			enabled: true,
			debug: true,
			registerToolOverrides: {
				read: true,
				grep: false,
				find: true,
				ls: true,
				bash: true,
				edit: true,
				write: true,
			},
			displaySummary: {
				enabled: true,
				required: false,
				language: "zh-CN",
				showInTui: false,
				maxLength: 96,
			},
			toolCallStyle: "claude",
			customToolOverrides: {
				web_search: { enabled: true, kind: "generic", outputMode: "summary" },
			},
			enableNativeUserMessageBox: false,
			readOutputMode: "summary",
			searchOutputMode: "preview",
			mcpOutputMode: "hidden",
			previewLines: 10,
			expandedPreviewMaxLines: 500,
			bashOutputMode: "opencode",
			bashCollapsedLines: 10,
			diffViewMode: "auto",
			diffIndicatorMode: "classic",
			diffSplitMinWidth: 120,
			diffCollapsedLines: 24,
			diffWordWrap: true,
			showTruncationHints: true,
			showRtkCompactionHints: false,
		};
		const legacyText = `${JSON.stringify(legacyConfig, null, 2)}\n`;
		writeFileSync(configFile, legacyText, "utf8");

		const expected = normalizeToolDisplayConfig(legacyConfig);
		const loaded = loadToolDisplayConfig(configFile);
		assert.equal(loaded.error, undefined);
		assert.deepEqual(loaded.config, expected);

		const persisted = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
		assert.equal(persisted.version, 2);
		assert.equal(persisted.$schema, TOOL_DISPLAY_CONFIG_SCHEMA_URL);
		assert.equal(persisted.displaySummary, undefined);
		assert.deepEqual(persisted.intent, { language: "zh-CN" });
		assert.deepEqual(persisted.toolCalls, { frame: "claude" });
		assert.deepEqual(persisted.results, {
			profile: "minimal",
			previewLines: 10,
			overrides: { read: "summary", search: "preview" },
		});
		assert.deepEqual(persisted.transcript, { userMessage: "default" });
		assert.deepEqual(persisted.tools, {
			disabled: ["grep"],
			custom: {
				web_search: { enabled: true, renderer: "generic", result: "summary" },
			},
		});
		assert.deepEqual(persisted.advanced, {
			expandedLineLimit: 500,
			truncationHints: true,
			debug: true,
		});
		assert.equal(readFileSync(join(dir, "config.legacy.json"), "utf8"), legacyText);

		const persistedText = readFileSync(configFile, "utf8");
		const reloaded = loadToolDisplayConfig(configFile);
		assert.deepEqual(reloaded.config, expected);
		assert.equal(readFileSync(configFile, "utf8"), persistedText);
		assert.equal(readFileSync(join(dir, "config.legacy.json"), "utf8"), legacyText);
	});
});

test("v2 grouped config resolves profile baselines and explicit overrides", () => {
	withTempDir("pi-tool-display-config-v2-", (dir) => {
		const configFile = join(dir, "config.json");
		writeFileSync(
			configFile,
			`${JSON.stringify({
				version: 2,
				extension: { enabled: false },
				intent: { enabled: false, language: "en", maxLength: 64 },
				toolCalls: { frame: "claude" },
				results: {
					profile: "balanced",
					previewLines: 20,
					overrides: {
						search: "preview",
						bash: { mode: "inline", collapsedLines: 5 },
					},
				},
				diff: {
					layout: "split",
					indicators: "none",
					splitMinWidth: 160,
					collapsedLines: 40,
					wordWrap: false,
				},
				transcript: { userMessage: "default", thinkingLabel: false },
				tools: {
					disabled: ["read", "write"],
					custom: {
						custom_mcp: { enabled: true, renderer: "mcp", result: "preview" },
					},
				},
				advanced: {
					expandedLineLimit: 300,
					truncationHints: true,
					rtkCompactionHints: true,
					debug: true,
				},
			}, null, 2)}\n`,
			"utf8",
		);

		const loaded = loadToolDisplayConfig(configFile).config;
		assert.equal(loaded.enabled, false);
		assert.equal(loaded.debug, true);
		assert.equal(loaded.resultProfile, "balanced");
		assert.equal(loaded.readOutputMode, "summary");
		assert.equal(loaded.searchOutputMode, "preview");
		assert.equal(loaded.mcpOutputMode, "summary");
		assert.equal(loaded.previewLines, 20);
		assert.equal(loaded.bashOutputMode, "opencode");
		assert.equal(loaded.bashCollapsedLines, 5);
		assert.equal(loaded.registerToolOverrides.read, false);
		assert.equal(loaded.registerToolOverrides.write, false);
		assert.equal(loaded.registerToolOverrides.bash, true);
		assert.deepEqual(loaded.customToolOverrides.custom_mcp, {
			enabled: true,
			kind: "mcp",
			outputMode: "preview",
		});
		assert.equal(loaded.enableNativeUserMessageBox, false);
		assert.equal(loaded.enableThinkingLabel, false);
		assert.equal(loaded.diffViewMode, "split");
		assert.equal(loaded.diffIndicatorMode, "none");
		assert.equal(loaded.diffSplitMinWidth, 160);
		assert.equal(loaded.diffCollapsedLines, 40);
		assert.equal(loaded.diffWordWrap, false);
		assert.equal(loaded.expandedPreviewMaxLines, 300);
		assert.equal(loaded.showTruncationHints, true);
		assert.equal(loaded.showRtkCompactionHints, true);
	});
});

test("v2 serialization is sparse and round-trips the effective config", () => {
	const config = normalizeToolDisplayConfig({
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		resultProfile: "detailed",
		readOutputMode: "summary",
		searchOutputMode: "preview",
		mcpOutputMode: "preview",
		previewLines: 16,
		bashOutputMode: "preview",
		bashCollapsedLines: 20,
		toolIntent: { enabled: false, language: "zh-CN", maxLength: 80 },
		enableThinkingLabel: false,
	});
	const serialized = serializeToolDisplayConfigV2(config);

	assert.deepEqual(serialized.results, {
		profile: "detailed",
		previewLines: 16,
		overrides: { read: "summary" },
	});
	assert.deepEqual(serialized.intent, { enabled: false, language: "zh-CN", maxLength: 80 });
	assert.deepEqual(serialized.transcript, { thinkingLabel: false });

	withTempDir("pi-tool-display-config-roundtrip-", (dir) => {
		const configFile = join(dir, "config.json");
		writeFileSync(configFile, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
		assert.deepEqual(loadToolDisplayConfig(configFile).config, config);
	});
});

test("invalid or unknown v2 fields are reported with paths and never rewritten", () => {
	withTempDir("pi-tool-display-config-invalid-v2-", (dir) => {
		const configFile = join(dir, "config.json");
		const original = `${JSON.stringify({
			version: 2,
			results: {
				profile: "minimal",
				previewLine: 10,
				overrides: { search: "count" },
			},
		}, null, 2)}\n`;
		writeFileSync(configFile, original, "utf8");

		const loaded = loadToolDisplayConfig(configFile);
		assert.match(loaded.error ?? "", /results\.previewLine: unknown setting/);
		assert.match(loaded.error ?? "", /results\.overrides\.search: expected hidden \| summary \| preview/);
		assert.equal(readFileSync(configFile, "utf8"), original);
	});
});

test("unsupported explicit config versions are reported without rewriting", () => {
	withTempDir("pi-tool-display-config-version-", (dir) => {
		const configFile = join(dir, "config.json");
		const original = '{"version":99,"results":{"profile":"minimal"}}\n';
		writeFileSync(configFile, original, "utf8");

		const loaded = loadToolDisplayConfig(configFile);
		assert.deepEqual(loaded.config, DEFAULT_TOOL_DISPLAY_CONFIG);
		assert.match(loaded.error ?? "", /Unsupported tool display config version/);
		assert.equal(readFileSync(configFile, "utf8"), original);
	});
});

test("config save writes normalized v2 JSON and cleans temporary file on failure", () => {
	withTempDir("pi-tool-display-config-save-", (dir) => {
		const configFile = join(dir, "config.json");
		const saved = saveToolDisplayConfig(
			{ ...DEFAULT_TOOL_DISPLAY_CONFIG, previewLines: 999 },
			configFile,
		);

		assert.equal(saved.success, true);
		const persisted = JSON.parse(readFileSync(configFile, "utf8")) as {
			version?: number;
			results?: { profile?: string; previewLines?: number };
		};
		assert.equal(persisted.version, 2);
		assert.equal(persisted.results?.profile, "minimal");
		assert.equal(persisted.results?.previewLines, 80);

		const parentFile = join(dir, "not-a-directory");
		writeFileSync(parentFile, "blocks mkdir", "utf8");
		const blockedConfigFile = join(parentFile, "config.json");
		const failed = saveToolDisplayConfig(DEFAULT_TOOL_DISPLAY_CONFIG, blockedConfigFile);

		assert.equal(failed.success, false);
		assert.match(failed.error ?? "", /Failed to save/);
		assert.equal(existsSync(`${blockedConfigFile}.tmp`), false);
	});
});
