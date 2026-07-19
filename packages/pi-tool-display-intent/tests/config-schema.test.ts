import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { loadToolDisplayConfig } from "../src/config-store.ts";
import {
	TOOL_DISPLAY_CONFIG_SCHEMA_URL,
	TOOL_DISPLAY_CONFIG_VERSION,
} from "../src/types.ts";

const examplePath = new URL("../config/config.example.json", import.meta.url);
const schemaPath = new URL("../config/config.schema.json", import.meta.url);

test("bundled config example is valid v2 and resolves expected effective settings", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tool-display-schema-"));
	try {
		const configFile = join(root, "config.json");
		writeFileSync(configFile, readFileSync(examplePath, "utf8"), "utf8");
		const loaded = loadToolDisplayConfig(configFile);

		assert.equal(loaded.error, undefined);
		assert.equal(loaded.config.resultProfile, "minimal");
		assert.equal(loaded.config.toolIntent.language, "zh-CN");
		assert.equal(loaded.config.toolCallStyle, "claude");
		assert.equal(loaded.config.readOutputMode, "summary");
		assert.equal(loaded.config.searchOutputMode, "preview");
		assert.equal(loaded.config.previewRows, 10);
		assert.equal(loaded.config.bashCollapsedRows, 12);
		assert.equal(loaded.config.expandedPreviewMaxLines, 500);
		assert.equal(loaded.config.debug, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bundled JSON Schema identifies the same config version and visual-row fields", () => {
	const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
		$id?: string;
		properties?: {
			version?: { const?: number };
			results?: {
				properties?: {
					previewRows?: unknown;
					previewLines?: unknown;
					overrides?: {
						properties?: {
							bash?: {
								properties?: { collapsedRows?: unknown; collapsedLines?: unknown };
							};
						};
					};
				};
			};
		};
	};
	assert.equal(schema.$id, TOOL_DISPLAY_CONFIG_SCHEMA_URL);
	assert.equal(schema.properties?.version?.const, TOOL_DISPLAY_CONFIG_VERSION);
	assert.ok(schema.properties?.results?.properties?.previewRows);
	assert.equal(schema.properties?.results?.properties?.previewLines, undefined);
	assert.ok(
		schema.properties?.results?.properties?.overrides?.properties?.bash?.properties?.collapsedRows,
	);
	assert.equal(
		schema.properties?.results?.properties?.overrides?.properties?.bash?.properties?.collapsedLines,
		undefined,
	);
});
