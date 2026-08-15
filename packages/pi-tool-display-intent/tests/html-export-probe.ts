import assert from "node:assert/strict";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { createToolHtmlRenderer } from "../node_modules/@earendil-works/pi-coding-agent/dist/core/export-html/tool-renderer.js";
import { registerToolDisplayOverrides } from "../src/tool-overrides.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";

interface RegisteredTool {
	name: string;
	parameters?: unknown;
	[key: string]: unknown;
}

function createApiStub(): { api: ExtensionAPI; tools: RegisteredTool[] } {
	const tools: RegisteredTool[] = [];
	const api = {
		registerTool(tool: RegisteredTool) {
			tools.push(tool);
		},
		on() {
			// HTML rendering only needs registered definitions.
		},
		getAllTools() {
			return [];
		},
	} as unknown as ExtensionAPI;
	return { api, tools };
}

function previewIndividualConfig(): ToolDisplayConfig {
	return {
		...DEFAULT_TOOL_DISPLAY_CONFIG,
		toolCallLayout: "individual",
		resultMode: "preview",
		readOutputMode: "preview",
		searchOutputMode: "preview",
		mcpOutputMode: "preview",
		bashOutputMode: "preview",
	};
}

async function main(): Promise<void> {
	const aggregateStub = createApiStub();
	registerToolDisplayOverrides(aggregateStub.api, () => ({
		...previewIndividualConfig(),
		toolCallLayout: "aggregate",
	}));
	const aggregateRead = aggregateStub.tools.find((tool) => tool.name === "read");
	const aggregateSchema = aggregateRead?.parameters as { properties?: Record<string, unknown> };
	assert.equal(aggregateSchema.properties?.displaySummary, undefined, "aggregate session stores no model intent field");

	const aggregateDefinitions = new Map(aggregateStub.tools.map((tool) => [tool.name, tool]));
	const theme = {
		fg: (_color: string, text: string) => text,
		bg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	};
	const renderer = createToolHtmlRenderer({
		getToolDefinition: (name: string) => aggregateDefinitions.get(name),
		theme,
		cwd: process.cwd(),
		width: 120,
	} as never);

	const readCall = renderer.renderCall("history-read", "read", { path: "history.ts" }) ?? "";
	assert.match(readCall, /history\.ts/);
	assert.doesNotMatch(readCall, /Read file/);
	assert.doesNotMatch(readCall, / — /);
	const readResult = renderer.renderResult(
		"history-read",
		"read",
		[{ type: "text", text: "original result" }],
		{},
		false,
	);
	assert.match(`${readResult?.collapsed ?? ""}${readResult?.expanded ?? ""}`, /original result/);

	const bashCall = renderer.renderCall("history-bash", "bash", { command: "pnpm test" }) ?? "";
	assert.match(bashCall, /pnpm test/);
	assert.doesNotMatch(bashCall, /Run command/);
	assert.doesNotMatch(bashCall, / — /);

	const individualStub = createApiStub();
	registerToolDisplayOverrides(individualStub.api, previewIndividualConfig);
	const individualDefinitions = new Map(individualStub.tools.map((tool) => [tool.name, tool]));
	const individualRenderer = createToolHtmlRenderer({
		getToolDefinition: (name: string) => individualDefinitions.get(name),
		theme,
		cwd: process.cwd(),
		width: 120,
	} as never);
	const storedIntent = individualRenderer.renderCall("history-model", "read", {
		path: "stored.ts",
		displaySummary: "Reviewing stored intent",
	}) ?? "";
	assert.match(storedIntent, /Reviewing stored intent/);
}

main().then(
	() => {
		process.stdout.write("HTML_EXPORT_OK\n");
		process.exit(0);
	},
	(error) => {
		console.error(error);
		process.exit(1);
	},
);
