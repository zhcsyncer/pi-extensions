import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ToolDisplayCapabilities } from "./capabilities.js";
import { getToolDisplayConfigPath, normalizeToolDisplayConfig } from "./config-store.js";
import { applyToolDisplayMode, parseToolDisplayMode } from "./presets.js";
import { shortenPath } from "./render-utils.js";
import type { InspectorSettingItem } from "./settings-inspector-modal.js";
import {
	RESULT_DISPLAY_MODES,
	type ToolDisplayConfig,
} from "./types.js";

interface ToolDisplayConfigController {
	getConfig(): ToolDisplayConfig;
	setConfig(next: ToolDisplayConfig, ctx: ExtensionCommandContext): void;
	getCapabilities(): ToolDisplayCapabilities;
}

interface ModalOverlayOptions {
	anchor: "center";
	width: number;
	maxHeight: number;
	margin: number;
}

const PREVIEW_ROW_VALUES = ["4", "8", "12", "20", "40"] as const;
const MODE_COMMAND_HINT = RESULT_DISPLAY_MODES.join("|");

function toOnOff(value: boolean): string {
	return value ? "on" : "off";
}

function toolOwnershipSummary(config: ToolDisplayConfig): string {
	const ownership = config.registerToolOverrides;
	return `read:${toOnOff(ownership.read)},grep:${toOnOff(ownership.grep)},find:${toOnOff(ownership.find)},ls:${toOnOff(ownership.ls)},bash:${toOnOff(ownership.bash)},edit:${toOnOff(ownership.edit)},write:${toOnOff(ownership.write)}`;
}

function summarizeConfig(config: ToolDisplayConfig, capabilities: ToolDisplayCapabilities): string {
	const parts = [
		`results=${config.resultMode}/${config.previewRows}rows`,
		`intent=${toOnOff(config.toolIntent.enabled)}/${config.toolIntent.language}`,
		`toolCalls=${config.toolCallStyle}`,
		`userMessage=${config.enableNativeUserMessageBox ? "boxed" : "default"}`,
		`thinkingLabel=${toOnOff(config.enableThinkingLabel)}`,
		`diff=${config.diffViewMode}/${config.diffIndicatorMode}@${config.diffSplitMinWidth}`,
		`diffRows=${config.diffCollapsedRows}`,
		`diffWrap=${toOnOff(config.diffWordWrap)}`,
		`ownership={${toolOwnershipSummary(config)}}`,
	];
	parts.push(capabilities.hasMcpTooling ? "mcp=available" : "mcp=unavailable");
	parts.push(
		capabilities.hasRtkOptimizer
			? `rtkHints=${toOnOff(config.showRtkCompactionHints)}`
			: "rtkHints=unavailable",
	);
	return parts.join(", ");
}

function parseNumber(value: string, fallback: number): number {
	const parsed = Number.parseInt(value, 10);
	return Number.isNaN(parsed) ? fallback : parsed;
}

function buildAdvancedNotes(
	config: ToolDisplayConfig,
	capabilities: ToolDisplayCapabilities,
	extra: readonly string[],
): string[] {
	return [
		...extra,
		"Manual JSON edits expose the grouped sections: intent, toolCalls, results, diff, transcript, tools, and advanced.",
		`Built-in renderer ownership is currently ${toolOwnershipSummary(config)} and still applies after /reload.`,
		`Truncation hints are ${toOnOff(config.showTruncationHints)}${capabilities.hasRtkOptimizer ? `; RTK hints are ${toOnOff(config.showRtkCompactionHints)}.` : "."}`,
	];
}

function buildInspectorSettings(
	config: ToolDisplayConfig,
	capabilities: ToolDisplayCapabilities,
): InspectorSettingItem[] {
	const configPath = shortenPath(getToolDisplayConfigPath());
	return [
		{
			id: "resultMode",
			label: "Tool result mode",
			currentValue: config.resultMode,
			values: RESULT_DISPLAY_MODES,
			inspectorTitle: "Tool Result Mode",
			inspectorSummary: [
				"Controls how much output read, search, MCP, and bash tools show in the transcript.",
				"It does not change custom-tool settings, intent, tool-call style, diff rendering, transcript styling, or tool ownership.",
			],
			inspectorOptions: [
				"compact — hide read/search/MCP bodies and keep a short bash preview",
				"summary — show counts or compact summaries",
				"preview — show wrapped content previews for read, search, MCP, and bash",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"All content previews use the shared results.previewRows budget.",
				"Legacy mode names minimal/opencode, balanced, and detailed/verbose map to compact, summary, and preview.",
			]),
			inspectorPath: configPath,
			searchTerms: ["results", "mode", "compact", "summary", "preview", "output"],
		},
		{
			id: "previewRows",
			label: "Preview rows",
			currentValue: String(config.previewRows),
			values: PREVIEW_ROW_VALUES,
			inspectorTitle: "Preview Rows",
			inspectorSummary: [
				"Sets one shared rendered-row budget for every collapsed content preview after terminal wrapping.",
				"A single long logical line consumes multiple rows instead of bypassing the limit.",
			],
			inspectorOptions: [
				"Lower values keep transcripts dense and skimmable",
				"Higher values show more read, search, MCP, custom, and bash output",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"advanced.expandedRows separately bounds output after Ctrl+O expansion.",
			]),
			inspectorPath: configPath,
			searchTerms: ["preview", "rows", "range", "collapsed", "read", "search", "mcp", "bash"],
		},
		{
			id: "toolIntentEnabled",
			label: "Model-written intent",
			currentValue: toOnOff(config.toolIntent.enabled),
			values: ["on", "off"],
			inspectorTitle: "Model-written Tool Intent",
			inspectorSummary: [
				"Adds a displaySummary field to owned built-in tool schemas so the current model describes each call's intent.",
				"The phrase is shown beside deterministic tool metadata and remains available to RPC clients without another inference request.",
			],
			inspectorOptions: [
				"on — request and render a short intent phrase",
				"off — keep deterministic tool rendering only",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Changing this setting updates tool schemas and therefore takes effect after /reload.",
				"Use intent.language and intent.maxLength in config.json for advanced control.",
			]),
			inspectorPath: configPath,
			searchTerms: ["intent", "summary", "model", "rpc", "displaySummary"],
		},
		{
			id: "toolCallStyle",
			label: "Tool call style",
			currentValue: config.toolCallStyle,
			values: ["compact", "claude"],
			inspectorTitle: "Tool Call Style",
			inspectorSummary: [
				"Controls the framing used for tool calls and results in the Pi transcript.",
				"Claude style uses status markers, Name(target) headers, an unboxed shell, and indented result rows.",
			],
			inspectorOptions: [
				"compact — original boxed pi-tool-display layout",
				"claude — Claude Code-inspired call framing",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Changing the shell style takes effect after /reload.",
			]),
			inspectorPath: configPath,
			searchTerms: ["tool", "style", "claude", "compact", "status", "shell"],
		},
		{
			id: "diffViewMode",
			label: "Edit diff layout",
			currentValue: config.diffViewMode,
			values: ["auto", "split", "unified"],
			inspectorTitle: "Edit Diff Layout",
			inspectorSummary: [
				"Controls how edit and write diffs are arranged.",
				"Auto uses side-by-side diffs in wide panes and unified diffs in narrow panes.",
			],
			inspectorOptions: [
				"auto — adaptive layout based on available width",
				"split — force side-by-side diff columns",
				"unified — force a single-column diff",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Manual JSON tuning exposes diff.splitMinWidth, diff.collapsedRows, diff.indicators, and diff.wordWrap.",
			]),
			inspectorPath: configPath,
			searchTerms: ["diff", "edit", "write", "split", "unified", "auto"],
		},
		{
			id: "diffIndicatorMode",
			label: "Diff indicators",
			currentValue: config.diffIndicatorMode,
			values: ["bars", "classic", "none"],
			inspectorTitle: "Diff Indicators",
			inspectorSummary: [
				"Controls whether changed diff lines use vertical bars, classic +/- markers, or no indicators.",
			],
			inspectorOptions: [
				"bars — persistent vertical indicators for changed rows",
				"classic — + / - markers on the first visual row",
				"none — no diff indicator marker",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, []),
			inspectorPath: configPath,
			searchTerms: ["diff", "indicator", "bars", "classic", "none"],
		},
		{
			id: "enableThinkingLabel",
			label: "Thinking label",
			currentValue: toOnOff(config.enableThinkingLabel),
			values: ["on", "off"],
			inspectorTitle: "Thinking Label",
			inspectorSummary: [
				"Adds an explicit Thinking: label to supported provider reasoning blocks.",
				"Presentation labels are removed before model context is sent.",
			],
			inspectorOptions: [
				"on — show the transcript label",
				"off — leave Pi's reasoning presentation unchanged",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, []),
			inspectorPath: configPath,
			searchTerms: ["thinking", "reasoning", "label", "transcript"],
		},
		{
			id: "enableNativeUserMessageBox",
			label: "User message style",
			currentValue: config.enableNativeUserMessageBox ? "boxed" : "default",
			values: ["boxed", "default"],
			inspectorTitle: "User Message Style",
			inspectorSummary: [
				"Controls whether user prompts use a bordered box or Pi's default transcript style.",
			],
			inspectorOptions: [
				"boxed — bordered native user prompt box",
				"default — Pi's default user message rendering",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, []),
			inspectorPath: configPath,
			searchTerms: ["user", "message", "style", "box", "prompt"],
		},
	];
}

function applySetting(config: ToolDisplayConfig, id: string, value: string): ToolDisplayConfig {
	switch (id) {
		case "resultMode": {
			const mode = parseToolDisplayMode(value);
			return mode ? applyToolDisplayMode(config, mode) : config;
		}
		case "previewRows":
			return { ...config, previewRows: parseNumber(value, config.previewRows) };
		case "toolIntentEnabled":
			return {
				...config,
				toolIntent: { ...config.toolIntent, enabled: value === "on" },
			};
		case "toolCallStyle":
			return { ...config, toolCallStyle: value as ToolDisplayConfig["toolCallStyle"] };
		case "enableThinkingLabel":
			return { ...config, enableThinkingLabel: value === "on" };
		case "enableNativeUserMessageBox":
			return { ...config, enableNativeUserMessageBox: value === "boxed" };
		case "diffViewMode":
			return { ...config, diffViewMode: value as ToolDisplayConfig["diffViewMode"] };
		case "diffIndicatorMode":
			return { ...config, diffIndicatorMode: value as ToolDisplayConfig["diffIndicatorMode"] };
		default:
			return config;
	}
}

function resolveResponsiveOverlayOptions(): ModalOverlayOptions {
	const terminalWidth =
		typeof process.stdout.columns === "number" && Number.isFinite(process.stdout.columns)
			? process.stdout.columns
			: 120;
	const terminalHeight =
		typeof process.stdout.rows === "number" && Number.isFinite(process.stdout.rows)
			? process.stdout.rows
			: 36;
	const margin = 1;
	const availableWidth = Math.max(72, terminalWidth - margin * 2);
	const preferredWidth = terminalWidth >= 170 ? 128 : terminalWidth >= 145 ? 118 : terminalWidth >= 120 ? 106 : 92;
	const width = Math.max(72, Math.min(preferredWidth, availableWidth));
	const availableHeight = Math.max(14, terminalHeight - margin * 2);
	const preferredHeight = Math.max(14, Math.floor(terminalHeight * 0.78));
	const maxHeight = Math.min(preferredHeight, availableHeight);
	return { anchor: "center", width, maxHeight, margin };
}

export async function openSettingsModal(ctx: ExtensionCommandContext, controller: ToolDisplayConfigController): Promise<void> {
	const overlayOptions = resolveResponsiveOverlayOptions();
	const capabilities = controller.getCapabilities();
	const [{ ZellijModal }, { SplitPaneInspectorModal }] = await Promise.all([
		import("./zellij-modal.js"),
		import("./settings-inspector-modal.js"),
	]);

	await ctx.ui.custom<void>(
		(tui, theme, _keybindings, done) => {
			const inspector = new SplitPaneInspectorModal(
				{
					getSettings: () => buildInspectorSettings(controller.getConfig(), capabilities),
					onChange: (id, newValue) => {
						const next = applySetting(controller.getConfig(), id, newValue);
						controller.setConfig(next, ctx);
					},
					onClose: () => done(),
				},
				theme,
			);
			const modal = new ZellijModal(
				inspector,
				{
					borderStyle: "square",
					padding: 0,
					titleBar: {},
					overlay: overlayOptions,
				},
				theme,
			);
			return {
				render: (width: number) => modal.renderModal(width).lines,
				invalidate: () => modal.invalidate(),
				handleInput(data: string) {
					modal.handleInput(data);
					tui.requestRender();
				},
			};
		},
		{ overlay: true, overlayOptions },
	);
}

function applyModeCommand(
	candidate: string,
	ctx: ExtensionCommandContext,
	controller: ToolDisplayConfigController,
): boolean {
	const mode = parseToolDisplayMode(candidate);
	if (!mode) {
		ctx.ui.notify(`Unknown result mode. Use: /tool-display-intent mode ${MODE_COMMAND_HINT}`, "warning");
		return true;
	}
	controller.setConfig(applyToolDisplayMode(controller.getConfig(), mode), ctx);
	ctx.ui.notify(`Tool result mode set to ${mode}.`, "info");
	return true;
}

export function handleToolDisplayArgs(args: string, ctx: ExtensionCommandContext, controller: ToolDisplayConfigController): boolean {
	const raw = args.trim();
	if (!raw) return false;
	const normalized = raw.toLowerCase();

	if (normalized === "show") {
		ctx.ui.notify(
			`tool-display-intent: ${summarizeConfig(controller.getConfig(), controller.getCapabilities())}`,
			"info",
		);
		return true;
	}
	if (normalized === "reset") {
		controller.setConfig(normalizeToolDisplayConfig({}), ctx);
		ctx.ui.notify("Tool display settings reset to defaults.", "info");
		return true;
	}
	if (normalized.startsWith("mode ")) {
		return applyModeCommand(normalized.slice("mode ".length).trim(), ctx, controller);
	}
	if (normalized.startsWith("preset ")) {
		return applyModeCommand(normalized.slice("preset ".length).trim(), ctx, controller);
	}
	ctx.ui.notify(`Usage: /tool-display-intent [show|reset|mode ${MODE_COMMAND_HINT}]`, "warning");
	return true;
}

export async function runToolDisplayCommandHandler(
	args: string,
	ctx: ExtensionCommandContext,
	controller: ToolDisplayConfigController,
): Promise<void> {
	if (handleToolDisplayArgs(args, ctx, controller)) return;
	if (!ctx.hasUI) {
		ctx.ui.notify("/tool-display-intent requires interactive TUI mode.", "warning");
		return;
	}
	await openSettingsModal(ctx, controller);
}

export function registerToolDisplayCommand(pi: ExtensionAPI, controller: ToolDisplayConfigController): void {
	pi.registerCommand("tool-display-intent", {
		description: "Configure intent-aware tool rendering",
		handler: async (args, ctx) => {
			await runToolDisplayCommandHandler(args, ctx, controller);
		},
	});
}
