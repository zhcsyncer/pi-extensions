import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ToolDisplayCapabilities } from "./capabilities.js";
import { getToolDisplayConfigPath } from "./config-store.js";
import { applyToolDisplayMode, parseToolDisplayMode } from "./presets.js";
import { shortenPath } from "./render-utils.js";
import type { InspectorSettingItem } from "./settings-inspector-modal.js";
import {
	DIFF_COLLAPSED_MODES,
	RESULT_DISPLAY_MODES,
	EXPANDED_TIMELINES,
	TOOL_CALL_LAYOUTS,
	TOOL_INTENT_LANGUAGES,
	type ToolDisplayConfig,
} from "./types.js";

interface ToolDisplayConfigController {
	getConfig(): ToolDisplayConfig;
	setConfig(
		next: ToolDisplayConfig,
		ctx: ExtensionCommandContext,
		options?: { skipReloadHint?: boolean },
	): void;
	getCapabilities(): ToolDisplayCapabilities;
}

interface ModalOverlayOptions {
	anchor: "center";
	width: number;
	maxHeight: number;
	margin: number;
}

const PREVIEW_ROW_VALUES = ["2", "4", "8", "12", "20", "40"] as const;
const BASH_COMMAND_PREVIEW_ROW_VALUES = ["1", "2", "3", "4"] as const;
const LAYOUT_COMMAND_HINT = TOOL_CALL_LAYOUTS.join("|");

export function getToolDisplayArgumentCompletions(argumentPrefix: string): Array<{
	value: string;
	label: string;
	description: string;
}> {
	const prefix = argumentPrefix.trim().toLowerCase().replace(/^layout\s+/, "");
	return [
		{
			value: "aggregate",
			label: "aggregate",
			description: "One bounded Run ledger per user turn",
		},
		{
			value: "individual",
			label: "individual",
			description: "Original per-tool renderers",
		},
	].filter((option) => option.value.startsWith(prefix));
}
const INDIVIDUAL_ONLY_SETTING_IDS = new Set([
	"resultMode",
	"previewRows",
	"bashCommandPreviewRows",
	"diffCollapsedMode",
]);
const AGGREGATE_ONLY_SETTING_IDS = new Set(["expandedTimeline", "showContextGrowth"]);

function toOnOff(value: boolean): string {
	return value ? "on" : "off";
}

function toolOwnershipSummary(config: ToolDisplayConfig): string {
	const ownership = config.registerToolOverrides;
	return `read:${toOnOff(ownership.read)},grep:${toOnOff(ownership.grep)},find:${toOnOff(ownership.find)},ls:${toOnOff(ownership.ls)},bash:${toOnOff(ownership.bash)},edit:${toOnOff(ownership.edit)},write:${toOnOff(ownership.write)}`;
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

export function buildInspectorSettings(
	config: ToolDisplayConfig,
	capabilities: ToolDisplayCapabilities,
): InspectorSettingItem[] {
	const configPath = shortenPath(getToolDisplayConfigPath());
	const settings: InspectorSettingItem[] = [
		{
			id: "toolCallLayout",
			label: "Tool call layout",
			currentValue: config.toolCallLayout,
			values: TOOL_CALL_LAYOUTS,
			inspectorTitle: "Tool Call Layout",
			inspectorSummary: config.toolCallLayout === "aggregate"
				? [
					"Aggregate uses one bounded Run summary for every registered tool; successful rows stay done until replacement or the final delayed fold.",
					"Collapsed errors stay as a failed count. While the turn is running, the latest assistant note stays pinned under the header, above the tool rows, without using a tool slot. After the turn settles, every assistant note hides and a muted receipt under the header shows duration, tokens, cache, and completion time.",
					"Ctrl+O leaves the Run ledger, restores mid-turn narration in place, and shows one target/status summary per call.",
					"Agent keeps its original renderer by default. User prompts always use a compact accent-gutter block with vertical padding. Individual-tool settings are retained but inactive.",
				]
				: [
					"Individual preserves the existing per-tool calls, results, diffs, intent, and Ctrl+O expansion.",
					"Aggregate summarizes every registered tool in one bounded Run view per user turn.",
				],
			inspectorOptions: [
				"individual — preserve the complete existing per-tool display (default)",
				"aggregate — summarize tools and hide mid-turn narration; Ctrl+O restores the timeline",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Changing the layout confirms a session reload, then rebuilds tool schemas and renderer shells for the whole current branch.",
				"Aggregate only asks bash for displaySummary. Other tools keep deterministic targets; grouped rows do not inline output/diff bodies.",
			]),
			inspectorPath: configPath,
			searchTerms: ["layout", "individual", "aggregate", "tools", "summary", "reload"],
		},
		{
			id: "toolIntentLanguage",
			label: "Bash intent language",
			currentValue: config.toolIntent.language,
			values: TOOL_INTENT_LANGUAGES,
			inspectorTitle: "Bash Intent Language",
			inspectorSummary: [
				"Controls the model-written displaySummary language for Bash calls in both layouts.",
				"auto only asks the model to follow the current user request; it does not detect or enforce the session language.",
			],
			inspectorOptions: [
				"auto — ask the model to follow the current request language (best effort)",
				"zh-CN — always write intent in Simplified Chinese",
				"en — always write intent in English",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Changing the language updates the Bash tool schema after /reload.",
				"Manual JSON tuning exposes intent.maxLength.",
			]),
			inspectorPath: configPath,
			searchTerms: ["bash", "intent", "language", "displaySummary", "auto", "Chinese", "English"],
		},
		{
			id: "expandedTimeline",
			label: "Expanded timeline",
			currentValue: config.expandedTimeline,
			values: EXPANDED_TIMELINES,
			inspectorTitle: "Expanded Timeline",
			inspectorSummary: [
				"Controls only the Ctrl+O aggregate timeline. Collapsed Run stays the same bounded ledger.",
				"flat keeps one target/status row per call. turns groups those rows by agent turn with ↻ 1/N headers and indented calls.",
				"Turn time is the span of that agent turn, not per-call execute duration. Switching this does not reload the session.",
			],
			inspectorOptions: [
				"flat — one target/status row per call (default)",
				"turns — group Ctrl+O by agent turn with ↻ 1/N headers and indented calls",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"This setting is render-only. It does not change tool schemas, Session messages, or collapsed Run.",
			]),
			inspectorPath: configPath,
			searchTerms: ["timeline", "turn", "expand", "ctrl+o", "group", "flat", "aggregate"],
		},
		{
			id: "showContextGrowth",
			label: "Context growth",
			currentValue: toOnOff(config.showContextGrowth),
			values: ["off", "on"],
			inspectorTitle: "Context Growth",
			inspectorSummary: [
				"Shows ctx +/- tokens in the aggregate run receipt and, with the turns timeline, in agent-turn headers. flat still shows the run total, but not per-turn changes.",
				"Context changes are attributed to the originating agent turn after usage from the next compatible request becomes available.",
				"Terminal or unconfirmed changes are approximate and marked ≈. Boundary gaps are never treated as exact growth.",
				"Context growth is separate from total token consumption. Switching this does not reload the session.",
			],
			inspectorOptions: [
				"off — hide context growth (default)",
				"on — show run context growth and per-turn changes in the turns timeline",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Manual JSON tuning exposes toolCalls.showContextGrowth. Individual layout retains this setting but does not use it.",
			]),
			inspectorPath: configPath,
			searchTerms: ["context", "growth", "ctx", "tokens", "approximate", "receipt", "turn", "aggregate"],
		},
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
				"2 — minimum supported preview for a dense transcript",
				"Higher values show more read, search, MCP, custom, and bash output",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"advanced.expandedRows separately bounds output after Ctrl+O expansion.",
			]),
			inspectorPath: configPath,
			searchTerms: ["preview", "rows", "range", "collapsed", "read", "search", "mcp", "bash"],
		},
		{
			id: "bashCommandPreviewRows",
			label: "Bash command rows",
			currentValue: String(config.bashCommandPreviewRows),
			values: BASH_COMMAND_PREVIEW_ROW_VALUES,
			inspectorTitle: "Bash Command Preview Rows",
			inspectorSummary: [
				"Limits collapsed Bash command text after terminal wrapping while leaving short commands unchanged.",
				"Long Claude-style calls keep intent in the header and move the bounded command preview to its own row.",
			],
			inspectorOptions: [
				"1 — densest transcript and the default",
				"2–4 — retain more command context before collapsing",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Ctrl+O expands the complete original command; results.previewRows controls output rather than call arguments.",
			]),
			inspectorPath: configPath,
			searchTerms: ["bash", "command", "preview", "rows", "collapse", "expand", "ctrl+o"],
		},
		{
			id: "diffViewMode",
			label: "Diff layout",
			currentValue: config.diffViewMode,
			values: ["auto", "split", "unified"],
			inspectorTitle: "Diff Layout",
			inspectorSummary: [
				"Global layout for Edit and Write diffs in normal tool views and the aggregate inspector popup.",
				"Auto uses side-by-side diffs when the available content width is wide enough, otherwise unified diffs. In the popup, it follows the popup content width, not the full terminal width.",
				"This setting is render-only. Switching it does not reload the session.",
			],
			inspectorOptions: [
				"auto — adaptive layout based on available width",
				"split — force side-by-side diff columns",
				"unified — force a single-column diff",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Both normal tool views and the aggregate inspector honor diff.wordWrap and diff.splitMinWidth from manual JSON tuning.",
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
				"Edit and Write share this preference across normal tool views and the aggregate inspector popup.",
				"This setting is render-only. Switching it does not reload the session.",
			],
			inspectorOptions: [
				"bars — persistent vertical indicators for changed rows",
				"classic — + / - markers on the first visual row",
				"none — no diff indicator marker",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, []),
			inspectorPath: configPath,
			searchTerms: ["diff", "edit", "write", "indicator", "bars", "classic", "none"],
		},
		{
			id: "diffCollapsedMode",
			label: "Diff collapsed style",
			currentValue: config.diffCollapsedMode,
			values: DIFF_COLLAPSED_MODES,
			inspectorTitle: "Diff Collapsed Style",
			inspectorSummary: [
				"Controls what edit and write diffs render before Ctrl+O expansion.",
				"summary shows only the +N -M stats line for the densest transcript; body keeps the existing collapsedRows preview.",
			],
			inspectorOptions: [
				"body — show the first diff.collapsedRows rows then a fold hint (default)",
				"summary — show only the stats line; Ctrl+O expands the full diff",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"When set to summary, diff.collapsedRows is ignored until expansion.",
				"This setting only applies to individual tool views; aggregate inspector popups already show expanded diffs.",
			]),
			inspectorPath: configPath,
			searchTerms: ["diff", "collapsed", "summary", "body", "fold", "compact", "ctrl+o"],
		},
	];
	return config.toolCallLayout === "aggregate"
		? settings.filter((setting) => !INDIVIDUAL_ONLY_SETTING_IDS.has(setting.id))
		: settings.filter((setting) => !AGGREGATE_ONLY_SETTING_IDS.has(setting.id));
}

export function applySetting(config: ToolDisplayConfig, id: string, value: string): ToolDisplayConfig {
	switch (id) {
		case "toolCallLayout":
			return { ...config, toolCallLayout: value as ToolDisplayConfig["toolCallLayout"] };
		case "toolIntentLanguage":
			return {
				...config,
				toolIntent: {
					...config.toolIntent,
					language: value as ToolDisplayConfig["toolIntent"]["language"],
				},
			};
		case "expandedTimeline":
			return { ...config, expandedTimeline: value as ToolDisplayConfig["expandedTimeline"] };
		case "showContextGrowth":
			return { ...config, showContextGrowth: value === "on" };
		case "resultMode": {
			const mode = parseToolDisplayMode(value);
			return mode ? applyToolDisplayMode(config, mode) : config;
		}
		case "previewRows":
			return { ...config, previewRows: parseNumber(value, config.previewRows) };
		case "bashCommandPreviewRows":
			return {
				...config,
				bashCommandPreviewRows: parseNumber(value, config.bashCommandPreviewRows),
			};
		case "diffViewMode":
			return { ...config, diffViewMode: value as ToolDisplayConfig["diffViewMode"] };
		case "diffIndicatorMode":
			return { ...config, diffIndicatorMode: value as ToolDisplayConfig["diffIndicatorMode"] };
		case "diffCollapsedMode":
			return { ...config, diffCollapsedMode: value as ToolDisplayConfig["diffCollapsedMode"] };
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
						if (id === "toolCallLayout") {
							void applyLayoutChange(newValue, ctx, controller);
							return;
						}
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

async function applyLayoutChange(
	candidate: string,
	ctx: ExtensionCommandContext,
	controller: ToolDisplayConfigController,
): Promise<boolean> {
	const layout = TOOL_CALL_LAYOUTS.find((entry) => entry === candidate);
	if (!layout) {
		ctx.ui.notify(`Unknown tool call layout. Use: /tools ${LAYOUT_COMMAND_HINT}`, "warning");
		return true;
	}
	if (controller.getConfig().toolCallLayout === layout) {
		ctx.ui.notify(`Tool call layout is already ${layout}.`, "info");
		return true;
	}
	const confirmed = await ctx.ui.confirm(
		"Reload session?",
		`Switch to ${layout} and reload this session so tool renderers rebuild.`,
	);
	if (!confirmed) {
		ctx.ui.notify("Layout unchanged.", "info");
		return true;
	}
	controller.setConfig({ ...controller.getConfig(), toolCallLayout: layout }, ctx, { skipReloadHint: true });
	await ctx.reload();
	return true;
}

export async function handleToolDisplayArgs(
	args: string,
	ctx: ExtensionCommandContext,
	controller: ToolDisplayConfigController,
): Promise<boolean> {
	const raw = args.trim();
	if (!raw) return false;
	const normalized = raw.toLowerCase();
	const layoutArg = normalized.startsWith("layout ") ? normalized.slice("layout ".length).trim() : normalized;
	if (TOOL_CALL_LAYOUTS.includes(layoutArg as (typeof TOOL_CALL_LAYOUTS)[number])) {
		return applyLayoutChange(layoutArg, ctx, controller);
	}
	ctx.ui.notify(`Usage: /tools [${LAYOUT_COMMAND_HINT}]`, "warning");
	return true;
}

export async function runToolDisplayCommandHandler(
	args: string,
	ctx: ExtensionCommandContext,
	controller: ToolDisplayConfigController,
): Promise<void> {
	if (await handleToolDisplayArgs(args, ctx, controller)) return;
	if (!ctx.hasUI) {
		ctx.ui.notify("/tools requires interactive TUI mode.", "warning");
		return;
	}
	await openSettingsModal(ctx, controller);
}

export function registerToolDisplayCommand(pi: ExtensionAPI, controller: ToolDisplayConfigController): void {
	pi.registerCommand("tools", {
		description: "Switch tool layout or open display settings",
		getArgumentCompletions: getToolDisplayArgumentCompletions,
		handler: async (args, ctx) => {
			await runToolDisplayCommandHandler(args, ctx, controller);
		},
	});
}
