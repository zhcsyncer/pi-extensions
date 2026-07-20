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

test("legacy normalization maps result modes, clamps rows, and discards bashCollapsedLines", () => {
	const config = normalizeToolDisplayConfig({
		registerReadToolOverride: false,
		registerToolOverrides: { bash: false },
		readOutputMode: "hidden",
		searchOutputMode: "hidden",
		mcpOutputMode: "hidden",
		bashOutputMode: "opencode",
		previewLines: 999,
		bashCollapsedLines: 1,
		expandedPreviewMaxLines: -1,
		toolCallStyle: "claude",
		diffViewMode: "stacked",
		diffSplitMinWidth: 1,
		diffCollapsedLines: 999,
		diffWordWrap: false,
	});

	assert.equal(config.resultMode, "compact");
	assert.equal(config.previewRows, 80);
	assert.equal(config.bashOutputMode, "preview");
	assert.equal(config.expandedPreviewMaxRows, 0);
	assert.equal(config.registerToolOverrides.read, false);
	assert.equal(config.registerToolOverrides.bash, false);
	assert.equal(config.toolCallStyle, "claude");
	assert.equal(config.diffViewMode, "unified");
	assert.equal(config.diffSplitMinWidth, 70);
	assert.equal(config.diffCollapsedRows, 240);
	assert.equal(config.diffWordWrap, false);
});

test("legacy stored Profile names map to final result modes", () => {
	assert.equal(normalizeToolDisplayConfig({ resultProfile: "minimal" }).resultMode, "compact");
	assert.equal(normalizeToolDisplayConfig({ resultProfile: "balanced" }).resultMode, "summary");
	assert.equal(normalizeToolDisplayConfig({ resultProfile: "detailed" }).resultMode, "preview");
});

test("legacy normalization validates toolIntent and displaySummary independently", () => {
	const normalized = normalizeToolDisplayConfig({
		toolIntent: { enabled: false, language: "zh-CN", maxLength: 999 },
		displaySummary: { enabled: true, language: "en", maxLength: 32 },
	});
	assert.deepEqual(normalized.toolIntent, {
		enabled: false,
		language: "zh-CN",
		maxLength: 256,
	});

	const migrated = normalizeToolDisplayConfig({
		displaySummary: {
			enabled: false,
			required: false,
			language: "en",
			showInTui: false,
			maxLength: 64,
		},
	});
	assert.deepEqual(migrated.toolIntent, {
		enabled: false,
		language: "en",
		maxLength: 64,
	});
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

test("legacy config migrates to simple v2 and reports discarded bash rows through notice", () => {
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
				disabled_tool: { enabled: false, kind: "generic", outputMode: "preview" },
			},
			enableNativeUserMessageBox: false,
			readOutputMode: "hidden",
			searchOutputMode: "hidden",
			mcpOutputMode: "hidden",
			previewLines: 10,
			expandedPreviewMaxLines: 500,
			bashOutputMode: "opencode",
			bashCollapsedLines: 20,
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

		const loaded = loadToolDisplayConfig(configFile);
		assert.equal(loaded.error, undefined);
		assert.equal(loaded.config.resultMode, "compact");
		assert.equal(loaded.config.previewRows, 10);
		assert.match(loaded.notice ?? "", /bashCollapsedLines was removed/);
		assert.match(loaded.notice ?? "", /results\.previewRows \(currently 10\)/);

		const persisted = JSON.parse(readFileSync(configFile, "utf8")) as Record<string, unknown>;
		assert.equal(persisted.version, 2);
		assert.equal(persisted.$schema, TOOL_DISPLAY_CONFIG_SCHEMA_URL);
		assert.equal(persisted.enabled, undefined);
		assert.deepEqual(persisted.intent, { language: "zh-CN" });
		assert.deepEqual(persisted.toolCalls, { style: "claude" });
		assert.deepEqual(persisted.results, { mode: "compact", previewRows: 10 });
		assert.deepEqual(persisted.transcript, { userMessageStyle: "default" });
		assert.deepEqual(persisted.tools, {
			passthrough: ["grep"],
			custom: {
				web_search: { renderer: "generic", mode: "summary" },
			},
		});
		assert.deepEqual(persisted.diff, { indicators: "classic" });
		assert.deepEqual(persisted.advanced, {
			expandedRows: 500,
			truncationHints: true,
			debug: true,
		});
		assert.equal(readFileSync(join(dir, "config.legacy.json"), "utf8"), legacyText);

		const persistedText = readFileSync(configFile, "utf8");
		const reloaded = loadToolDisplayConfig(configFile);
		assert.equal(reloaded.notice, undefined);
		assert.deepEqual(reloaded.config, loaded.config);
		assert.equal(readFileSync(configFile, "utf8"), persistedText);
	});
});

test("legacy custom per-tool modes consolidate to one result mode with a notice", () => {
	withTempDir("pi-tool-display-config-custom-mode-", (dir) => {
		const configFile = join(dir, "config.json");
		writeFileSync(configFile, JSON.stringify({
			readOutputMode: "summary",
			searchOutputMode: "preview",
			mcpOutputMode: "hidden",
			bashOutputMode: "summary",
		}), "utf8");
		const loaded = loadToolDisplayConfig(configFile);
		assert.equal(loaded.config.resultMode, "preview");
		assert.match(loaded.notice ?? "", /per-tool result settings were consolidated/);
	});
});

test("v2 grouped config resolves simple result mode and clear field names", () => {
	withTempDir("pi-tool-display-config-v2-", (dir) => {
		const configFile = join(dir, "config.json");
		writeFileSync(configFile, `${JSON.stringify({
			version: 2,
			intent: { enabled: false, language: "en", maxLength: 64 },
			toolCalls: { style: "claude", bashCommandPreviewRows: 3 },
			results: { mode: "summary", previewRows: 20 },
			diff: {
				layout: "split",
				indicators: "none",
				splitMinWidth: 160,
				collapsedRows: 40,
				wordWrap: false,
			},
			transcript: { userMessageStyle: "default", thinkingLabel: false },
			tools: {
				passthrough: ["read", "write"],
				custom: {
					custom_mcp: { renderer: "mcp", mode: "preview" },
				},
			},
			advanced: {
				expandedRows: 300,
				truncationHints: true,
				rtkCompactionHints: true,
				debug: true,
			},
		}, null, 2)}\n`, "utf8");

		const loaded = loadToolDisplayConfig(configFile);
		assert.equal(loaded.error, undefined);
		assert.equal(loaded.config.resultMode, "summary");
		assert.equal(loaded.config.readOutputMode, "summary");
		assert.equal(loaded.config.searchOutputMode, "count");
		assert.equal(loaded.config.mcpOutputMode, "summary");
		assert.equal(loaded.config.bashOutputMode, "summary");
		assert.equal(loaded.config.previewRows, 20);
		assert.equal(loaded.config.bashCommandPreviewRows, 3);
		assert.equal(loaded.config.registerToolOverrides.read, false);
		assert.equal(loaded.config.registerToolOverrides.write, false);
		assert.deepEqual(loaded.config.customToolOverrides.custom_mcp, {
			kind: "mcp",
			outputMode: "preview",
		});
		assert.equal(loaded.config.enableNativeUserMessageBox, false);
		assert.equal(loaded.config.enableThinkingLabel, false);
		assert.equal(loaded.config.diffCollapsedRows, 40);
		assert.equal(loaded.config.expandedPreviewMaxRows, 300);
		assert.equal(loaded.config.debug, true);
	});
});

test("v2 serialization is sparse and round-trips the effective config", () => {
	const config = normalizeToolDisplayConfig({
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		resultMode: "preview",
		previewRows: 16,
		toolIntent: { enabled: false, language: "zh-CN", maxLength: 80 },
		bashCommandPreviewRows: 2,
		enableThinkingLabel: false,
	});
	const serialized = serializeToolDisplayConfigV2(config);
	assert.deepEqual(serialized.results, { mode: "preview", previewRows: 16 });
	assert.deepEqual(serialized.intent, { enabled: false, language: "zh-CN", maxLength: 80 });
	assert.deepEqual(serialized.toolCalls, { bashCommandPreviewRows: 2 });
	assert.deepEqual(serialized.transcript, { thinkingLabel: false });

	withTempDir("pi-tool-display-config-roundtrip-", (dir) => {
		const configFile = join(dir, "config.json");
		writeFileSync(configFile, `${JSON.stringify(serialized, null, 2)}\n`, "utf8");
		assert.deepEqual(loadToolDisplayConfig(configFile).config, config);
	});
});

test("invalid or old v2 fields are reported with paths and never rewritten", () => {
	withTempDir("pi-tool-display-config-invalid-v2-", (dir) => {
		const configFile = join(dir, "config.json");
		const original = `${JSON.stringify({
			version: 2,
			extension: { enabled: false },
			toolCalls: { frame: "claude", bashCommandPreviewRows: 9 },
			results: {
				profile: "minimal",
				previewLines: 10,
				overrides: { bash: { collapsedRows: 5 } },
			},
		}, null, 2)}\n`;
		writeFileSync(configFile, original, "utf8");
		const loaded = loadToolDisplayConfig(configFile);
		assert.deepEqual(loaded.config, DEFAULT_TOOL_DISPLAY_CONFIG);
		assert.match(loaded.error ?? "", /extension: unknown setting/);
		assert.match(loaded.error ?? "", /toolCalls\.frame: unknown setting/);
		assert.match(loaded.error ?? "", /toolCalls\.bashCommandPreviewRows: expected integer from 1 to 8/);
		assert.match(loaded.error ?? "", /results\.profile: unknown setting/);
		assert.match(loaded.error ?? "", /results\.mode: required setting/);
		assert.equal(readFileSync(configFile, "utf8"), original);
	});
});

test("strict v2 validation rejects schema type, duplicate passthrough entries, and invalid custom tool names", () => {
	withTempDir("pi-tool-display-config-strict-v2-", (dir) => {
		const configFile = join(dir, "config.json");
		const original = `${JSON.stringify({
			$schema: 2,
			version: 2,
			results: { mode: "compact" },
			tools: {
				passthrough: ["read", "read"],
				custom: {
					read: {},
					" padded ": {},
				},
			},
		}, null, 2)}\n`;
		writeFileSync(configFile, original, "utf8");
		const loaded = loadToolDisplayConfig(configFile);
		assert.match(loaded.error ?? "", /\$schema: expected string/);
		assert.match(loaded.error ?? "", /tools\.passthrough\.1: duplicate built-in tool/);
		assert.match(loaded.error ?? "", /tools\.custom\.read: expected a non-empty trimmed non-built-in tool name/);
		assert.match(loaded.error ?? "", /tools\.custom\. padded : expected a non-empty trimmed non-built-in tool name/);
		assert.equal(readFileSync(configFile, "utf8"), original);
	});
});

test("non-object JSON is rejected without legacy migration or rewriting", () => {
	withTempDir("pi-tool-display-config-root-", (dir) => {
		const configFile = join(dir, "config.json");
		const original = "[]\n";
		writeFileSync(configFile, original, "utf8");
		const loaded = loadToolDisplayConfig(configFile);
		assert.match(loaded.error ?? "", /root: expected object/);
		assert.equal(readFileSync(configFile, "utf8"), original);
		assert.equal(existsSync(join(dir, "config.legacy.json")), false);
	});
});

test("unsupported explicit config versions are reported without rewriting", () => {
	withTempDir("pi-tool-display-config-version-", (dir) => {
		const configFile = join(dir, "config.json");
		const original = '{"version":99,"results":{"mode":"compact"}}\n';
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
			{ ...DEFAULT_TOOL_DISPLAY_CONFIG, previewRows: 999 },
			configFile,
		);
		assert.equal(saved.success, true);
		const persisted = JSON.parse(readFileSync(configFile, "utf8")) as {
			version?: number;
			results?: { mode?: string; previewRows?: number };
		};
		assert.equal(persisted.version, 2);
		assert.equal(persisted.results?.mode, "compact");
		assert.equal(persisted.results?.previewRows, 80);

		const parentFile = join(dir, "not-a-directory");
		writeFileSync(parentFile, "blocks mkdir", "utf8");
		const blockedConfigFile = join(parentFile, "config.json");
		const failed = saveToolDisplayConfig(DEFAULT_TOOL_DISPLAY_CONFIG, blockedConfigFile);
		assert.equal(failed.success, false);
		assert.match(failed.error ?? "", /Failed to save/);
		assert.equal(existsSync(`${blockedConfigFile}.tmp`), false);
	});
});
