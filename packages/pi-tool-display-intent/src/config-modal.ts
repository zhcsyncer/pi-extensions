import type { ExtensionAPI, ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import type { ToolDisplayCapabilities } from "./capabilities.js";
import { getToolDisplayConfigPath, normalizeToolDisplayConfig } from "./config-store.js";
import {
	applyToolDisplayPreset,
	hasToolDisplayProfileOverrides,
	parseToolDisplayPreset,
	TOOL_DISPLAY_PRESETS,
	type ToolDisplayPreset,
} from "./presets.js";
import { shortenPath } from "./render-utils.js";
import type { InspectorSettingItem } from "./settings-inspector-modal.js";
import { type ToolDisplayConfig } from "./types.js";

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

const PREVIEW_LINE_VALUES = ["4", "8", "12", "20", "40"] as const;
const BASH_PREVIEW_LINE_VALUES = ["0", "5", "10", "20", "40"] as const;
const PRESET_COMMAND_HINT = TOOL_DISPLAY_PRESETS.join("|");

function toOnOff(value: boolean): string {
	return value ? "on" : "off";
}

function toolOwnershipSummary(config: ToolDisplayConfig): string {
	const overrides = config.registerToolOverrides;
	return `read:${toOnOff(overrides.read)},grep:${toOnOff(overrides.grep)},find:${toOnOff(overrides.find)},ls:${toOnOff(overrides.ls)},bash:${toOnOff(overrides.bash)},edit:${toOnOff(overrides.edit)},write:${toOnOff(overrides.write)}`;
}

function summarizeConfig(config: ToolDisplayConfig, capabilities: ToolDisplayCapabilities): string {
	const profileSummary = hasToolDisplayProfileOverrides(config)
		? `${config.resultProfile}+overrides`
		: config.resultProfile;
	const parts = [
		`resultProfile=${profileSummary}`,
		`owners={${toolOwnershipSummary(config)}}`,
		`intent=${toOnOff(config.toolIntent.enabled)}/${config.toolIntent.language}`,
		`toolCallStyle=${config.toolCallStyle}`,
		`userBox=${toOnOff(config.enableNativeUserMessageBox)}`,
		`thinkingLabel=${toOnOff(config.enableThinkingLabel)}`,
		`read=${config.readOutputMode}`,
		`search=${config.searchOutputMode}`,
		`preview=${config.previewLines}`,
		`expandedMax=${config.expandedPreviewMaxLines}`,
		`bash=${config.bashOutputMode}`,
		`bashLines=${config.bashCollapsedLines}`,
		`diff=${config.diffViewMode}/${config.diffIndicatorMode}@${config.diffSplitMinWidth}`,
		`diffLines=${config.diffCollapsedLines}`,
		`diffWrap=${toOnOff(config.diffWordWrap)}`,
	];

	if (capabilities.hasMcpTooling) {
		parts.push(`mcp=${config.mcpOutputMode}`);
	} else {
		parts.push("mcp=auto-hidden");
	}

	if (capabilities.hasRtkOptimizer) {
		parts.push(`rtkHints=${toOnOff(config.showRtkCompactionHints)}`);
	} else {
		parts.push("rtkHints=auto-off");
	}

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
	const notes = [
		...extra,
		"Manual JSON edits expose the grouped v2 sections: intent, toolCalls, results, diff, transcript, tools, and advanced.",
		`Tool ownership is currently ${toolOwnershipSummary(config)} and still applies after /reload.`,
		`Truncation hints are ${toOnOff(config.showTruncationHints)}${capabilities.hasRtkOptimizer ? `; RTK hints are ${toOnOff(config.showRtkCompactionHints)}.` : "."}`,
	];
	return notes;
}

function buildInspectorSettings(
	config: ToolDisplayConfig,
	capabilities: ToolDisplayCapabilities,
): InspectorSettingItem[] {
	const configPath = shortenPath(getToolDisplayConfigPath());
	const items: InspectorSettingItem[] = [
		{
			id: "preset",
			label: "Result detail profile",
			currentValue: config.resultProfile,
			values: TOOL_DISPLAY_PRESETS,
			inspectorTitle: "Result Detail Profile",
			inspectorSummary: [
				"Controls the output density of read, search, MCP, and bash results.",
				"Choosing a profile preserves tool-call style, intent, ownership, diff settings, and other advanced preferences.",
			],
			inspectorOptions: [
				"minimal — headers plus compact inline bash output",
				"balanced — compact summaries with counts",
				"detailed — larger line previews and more visible bash output",
				"profile+overrides — shown when per-tool result settings differ from the selected baseline",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"The selected profile is persisted as the results.profile baseline; only differences are written under results.overrides.",
				"Legacy preset names opencode and verbose remain accepted as aliases for minimal and detailed.",
			]),
			inspectorPath: configPath,
			searchTerms: ["verbosity", "profile", "layout", "custom", ...TOOL_DISPLAY_PRESETS],
		},
		{
			id: "toolIntentEnabled",
			label: "Model-written intent",
			currentValue: toOnOff(config.toolIntent.enabled),
			values: ["on", "off"],
			inspectorTitle: "Model-written Tool Intent",
			inspectorSummary: [
				"Adds a displaySummary field to owned built-in tool schemas so the current model describes each call's intent.",
				"The phrase is shown beside deterministic tool metadata in TUI and remains available to RPC clients without an extra inference request.",
			],
			inspectorOptions: [
				"on — request and render a short intent phrase",
				"off — keep deterministic tool rendering only",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Changing this setting updates tool schemas and therefore takes effect after /reload.",
				"Use intent.language and intent.maxLength in config.json for advanced control.",
				"Enabled intent is always required in owned tool schemas and shown in TUI.",
			]),
			inspectorPath: configPath,
			searchTerms: ["intent", "summary", "model", "rpc", "progress", "toolIntent", "displaySummary"],
		},
		{
			id: "toolCallStyle",
			label: "Tool call style",
			currentValue: config.toolCallStyle,
			values: ["compact", "claude"],
			inspectorTitle: "Tool Call Style",
			inspectorSummary: [
				"Controls the framing used for tool calls and results in the Pi transcript.",
				"Claude style uses status markers, Name(target) headers, an unboxed shell, and indented ⎿ result rows while preserving real arguments and diffs.",
			],
			inspectorOptions: [
				"compact — original boxed pi-tool-display layout",
				"claude — Claude Code-inspired status and result framing",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Changing the shell style takes effect after /reload.",
				"Model-written intent remains a suffix; deterministic paths, commands, patterns, and diff metadata are never replaced.",
			]),
			inspectorPath: configPath,
			searchTerms: ["tool", "style", "claude", "compact", "status", "result", "shell"],
		},
		{
			id: "readOutputMode",
			label: "Read tool output",
			currentValue: config.readOutputMode,
			values: ["hidden", "summary", "preview"],
			inspectorTitle: "Read Tool Output",
			inspectorSummary: [
				"Controls how read results appear inline after the tool call header.",
				"Use hidden for the cleanest transcript, summary for file metrics, or preview when seeing source lines matters in-context.",
			],
			inspectorOptions: [
				"hidden — path and status only",
				"summary — adds compact file metrics",
				"preview — shows the first configured preview lines",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"advanced.expandedLineLimit bounds how many lines can appear after expanding a preview-heavy read result.",
			]),
			inspectorPath: configPath,
			searchTerms: ["file", "source", "preview", "summary", "hidden"],
		},
		{
			id: "searchOutputMode",
			label: "Grep/Find/Ls output",
			currentValue: config.searchOutputMode,
			values: ["hidden", "count", "preview"],
			inspectorTitle: "Grep / Find / Ls Output",
			inspectorSummary: [
				"Controls how search-style tools compress their result sets inside the transcript.",
				"Count mode keeps discovery actions readable while still surfacing how much data the tool matched.",
			],
			inspectorOptions: [
				"hidden — call header only",
				"count — totals only for matches or entries",
				"preview — shows the first configured preview lines",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Preview-heavy search output is most effective when paired with larger previewLines values in custom configurations.",
			]),
			inspectorPath: configPath,
			searchTerms: ["grep", "find", "ls", "matches", "count", "results"],
		},
	];

	if (capabilities.hasMcpTooling) {
		items.push({
			id: "mcpOutputMode",
			label: "MCP tool output",
			currentValue: config.mcpOutputMode,
			values: ["hidden", "summary", "preview"],
			inspectorTitle: "MCP Tool Output",
			inspectorSummary: [
				"Controls how proxied MCP tool results are compacted when they return text output.",
				"Summary mode is the safest default when you want awareness without flooding the chat pane.",
			],
			inspectorOptions: [
				"hidden — call metadata only",
				"summary — compact line-count summary",
				"preview — shows the first configured preview lines",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"This control appears only when MCP tooling is available in the current Pi session.",
			]),
			inspectorPath: configPath,
			searchTerms: ["mcp", "proxy", "server", "summary", "preview"],
		});
	}

	items.push(
		{
			id: "previewLines",
			label: "Preview lines",
			currentValue: String(config.previewLines),
			values: PREVIEW_LINE_VALUES,
			inspectorTitle: "Preview Lines",
			inspectorSummary: [
				"Sets how many lines appear when read, search, MCP, or bash preview modes are collapsed inline.",
				"Accepted manual range: 1 to 80 lines. The quick selector cycles through a curated set for fast tuning.",
			],
			inspectorOptions: [
				"Lower values keep transcripts dense and skimmable",
				"Higher values surface more source context before expansion",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Pair this with advanced.expandedLineLimit when you want larger expanded previews without making collapsed output noisy.",
			]),
			inspectorPath: configPath,
			searchTerms: ["preview", "lines", "range", "collapsed", "read", "grep", "mcp", "bash"],
		},
		{
			id: "bashOutputMode",
			label: "Bash tool output",
			currentValue: config.bashOutputMode,
			values: ["opencode", "summary", "preview"],
			inspectorTitle: "Bash Tool Output",
			inspectorSummary: [
				"Controls how shell command output is rendered when the command finishes successfully.",
				"The opencode mode keeps command output recognizable while still compressing walls of stdout.",
			],
			inspectorOptions: [
				"opencode — Pi/OpenCode-style collapsed bash view",
				"summary — output count only",
				"preview — uses the shared previewLines setting",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Quiet commands still collapse aggressively, so mode selection matters most on verbose build, test, and script output.",
			]),
			inspectorPath: configPath,
			searchTerms: ["bash", "shell", "stdout", "command", "opencode"],
		},
		{
			id: "bashCollapsedLines",
			label: "Bash collapsed lines",
			currentValue: String(config.bashCollapsedLines),
			values: BASH_PREVIEW_LINE_VALUES,
			inspectorTitle: "Bash Collapsed Lines",
			inspectorSummary: [
				"Sets the inline line budget used specifically by opencode bash mode before expansion.",
				"Accepted manual range: 0 to 80 lines. Setting 0 hides collapsed bash output entirely while keeping the command visible.",
			],
			inspectorOptions: [
				"0 — hide collapsed bash output",
				"5/10/20/40 — progressively larger inline command previews",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"This setting only changes the opencode bash renderer; preview mode continues to use previewLines instead.",
			]),
			inspectorPath: configPath,
			searchTerms: ["bash", "collapsed", "lines", "stdout", "zero"],
		},
		{
			id: "diffViewMode",
			label: "Edit diff layout",
			currentValue: config.diffViewMode,
			values: ["auto", "split", "unified"],
			inspectorTitle: "Edit Diff Layout",
			inspectorSummary: [
				"Controls how edit and write diffs are arranged when the extension renders code changes.",
				"Auto mode adapts to terminal width so wide panes get side-by-side diffs while narrow panes stay readable.",
			],
			inspectorOptions: [
				"auto — adaptive layout based on available width",
				"split — force side-by-side diff columns",
				"unified — force a single-column diff",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Manual JSON tuning exposes diff.splitMinWidth, diff.collapsedLines, diff.indicators, and diff.wordWrap for more aggressive diff control.",
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
				"Controls whether changed diff lines use vertical bars, classic +/- markers, or no indicators at all.",
				"Bars continue across wrapped changed rows, classic markers appear only on the first wrapped row, and none removes the indicator column styling.",
			],
			inspectorOptions: [
				"bars — persistent vertical indicators for changed rows",
				"classic — + / - markers on the first visual row only",
				"none — no diff indicator marker",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"Use config.json when you want this indicator preference to remain explicit alongside other diff rendering overrides.",
			]),
			inspectorPath: configPath,
			searchTerms: ["diff", "indicator", "bars", "classic", "none", "marker"],
		},
		{
			id: "enableThinkingLabel",
			label: "Thinking label",
			currentValue: toOnOff(config.enableThinkingLabel),
			values: ["on", "off"],
			inspectorTitle: "Thinking Label",
			inspectorSummary: [
				"Adds an explicit Thinking: label to supported provider reasoning blocks in the transcript.",
				"Presentation labels are removed again before model context is sent.",
			],
			inspectorOptions: [
				"on — show the transcript label",
				"off — leave Pi's reasoning block presentation unchanged",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"This setting is stored as transcript.thinkingLabel and applies without changing tool schemas.",
			]),
			inspectorPath: configPath,
			searchTerms: ["thinking", "reasoning", "label", "transcript"],
		},
		{
			id: "enableNativeUserMessageBox",
			label: "Native user message box",
			currentValue: toOnOff(config.enableNativeUserMessageBox),
			values: ["on", "off"],
			inspectorTitle: "Native User Message Box",
			inspectorSummary: [
				"Toggles the bordered native renderer used for user prompts inside the Pi transcript.",
				"Keep it on when you want clearer message separation, or turn it off to fall back to Pi's default user message rendering.",
			],
			inspectorOptions: [
				"on — bordered native user prompt box",
				"off — default Pi prompt rendering",
			],
			inspectorAdvanced: buildAdvancedNotes(config, capabilities, [
				"This switch only affects presentation. It does not change stored prompts, markdown handling, or tool behavior.",
			]),
			inspectorPath: configPath,
			searchTerms: ["user", "message", "box", "prompt", "native"],
		},
	);

	return items;
}

function applyPreset(config: ToolDisplayConfig, preset: ToolDisplayPreset): ToolDisplayConfig {
	return applyToolDisplayPreset(config, preset);
}

function applySetting(config: ToolDisplayConfig, id: string, value: string): ToolDisplayConfig {
	switch (id) {
		case "preset": {
			const parsed = parseToolDisplayPreset(value);
			return parsed ? applyPreset(config, parsed) : config;
		}
		case "toolIntentEnabled":
			return {
				...config,
				toolIntent: {
					...config.toolIntent,
					enabled: value === "on",
				},
			};
		case "toolCallStyle":
			return {
				...config,
				toolCallStyle: value as ToolDisplayConfig["toolCallStyle"],
			};
		case "enableThinkingLabel":
			return {
				...config,
				enableThinkingLabel: value === "on",
			};
		case "enableNativeUserMessageBox":
			return {
				...config,
				enableNativeUserMessageBox: value === "on",
			};
		case "readOutputMode":
			return {
				...config,
				readOutputMode: value as ToolDisplayConfig["readOutputMode"],
			};
		case "searchOutputMode":
			return {
				...config,
				searchOutputMode: value as ToolDisplayConfig["searchOutputMode"],
			};
		case "mcpOutputMode":
			return {
				...config,
				mcpOutputMode: value as ToolDisplayConfig["mcpOutputMode"],
			};
		case "previewLines":
			return {
				...config,
				previewLines: parseNumber(value, config.previewLines),
			};
		case "bashOutputMode":
			return {
				...config,
				bashOutputMode: value as ToolDisplayConfig["bashOutputMode"],
			};
		case "bashCollapsedLines":
			return {
				...config,
				bashCollapsedLines: parseNumber(value, config.bashCollapsedLines),
			};
		case "diffViewMode":
			return {
				...config,
				diffViewMode: value as ToolDisplayConfig["diffViewMode"],
			};
		case "diffIndicatorMode":
			return {
				...config,
				diffIndicatorMode: value as ToolDisplayConfig["diffIndicatorMode"],
			};
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

	return {
		anchor: "center",
		width,
		maxHeight,
		margin,
	};
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

export function handleToolDisplayArgs(args: string, ctx: ExtensionCommandContext, controller: ToolDisplayConfigController): boolean {
	const raw = args.trim();
	if (!raw) {
		return false;
	}

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

	if (normalized.startsWith("preset ")) {
		const candidate = normalized.slice("preset ".length).trim();
		const preset = parseToolDisplayPreset(candidate);
		if (!preset) {
			ctx.ui.notify(`Unknown preset. Use: /tool-display-intent preset ${PRESET_COMMAND_HINT}`, "warning");
			return true;
		}

		controller.setConfig(applyToolDisplayPreset(controller.getConfig(), preset), ctx);
		ctx.ui.notify(`Tool result profile set to ${preset}.`, "info");
		return true;
	}

	ctx.ui.notify(`Usage: /tool-display-intent [show|reset|preset ${PRESET_COMMAND_HINT}]`, "warning");
	return true;
}

export async function runToolDisplayCommandHandler(
	args: string,
	ctx: ExtensionCommandContext,
	controller: ToolDisplayConfigController,
): Promise<void> {
	if (handleToolDisplayArgs(args, ctx, controller)) {
		return;
	}

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
