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

test("bundled config example is valid simple v2", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tool-display-schema-"));
	try {
		const configFile = join(root, "config.json");
		writeFileSync(configFile, readFileSync(examplePath, "utf8"), "utf8");
		const loaded = loadToolDisplayConfig(configFile);
		assert.equal(loaded.error, undefined);
		assert.equal(loaded.config.resultMode, "summary");
		assert.equal(loaded.config.toolIntent.language, "zh-CN");
		assert.equal(loaded.config.toolCallStyle, "claude");
		assert.equal(loaded.config.bashCommandPreviewRows, 1);
		assert.equal(loaded.config.previewRows, 10);
		assert.equal(loaded.config.diffCollapsedRows, 24);
		assert.equal(loaded.config.expandedPreviewMaxRows, 500);
		assert.equal(loaded.config.debug, false);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});

test("bundled JSON Schema exposes only the reviewed public field names", () => {
	const schema = JSON.parse(readFileSync(schemaPath, "utf8")) as {
		$id?: string;
		properties?: Record<string, unknown> & {
			version?: { const?: number };
			results?: { properties?: Record<string, unknown> };
			toolCalls?: { properties?: Record<string, unknown> };
			tools?: { properties?: Record<string, unknown> };
		};
	};
	assert.equal(schema.$id, TOOL_DISPLAY_CONFIG_SCHEMA_URL);
	assert.equal(schema.properties?.version?.const, TOOL_DISPLAY_CONFIG_VERSION);
	assert.ok(schema.properties?.results?.properties?.mode);
	assert.ok(schema.properties?.results?.properties?.previewRows);
	assert.equal(schema.properties?.results?.properties?.profile, undefined);
	assert.equal(schema.properties?.results?.properties?.overrides, undefined);
	assert.ok(schema.properties?.toolCalls?.properties?.style);
	assert.ok(schema.properties?.toolCalls?.properties?.bashCommandPreviewRows);
	assert.equal(schema.properties?.toolCalls?.properties?.frame, undefined);
	assert.ok(schema.properties?.tools?.properties?.passthrough);
	assert.equal(schema.properties?.tools?.properties?.disabled, undefined);
	assert.equal(schema.properties?.extension, undefined);
});
