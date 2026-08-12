import {
	keyText,
	type AgentToolResult,
	type Theme,
	type ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import {
	truncateToWidth,
	wrapTextWithAnsi,
	type Component,
} from "@earendil-works/pi-tui";
import { deriveProcessLabel, type ProcessEntry } from "./registry.ts";
import type { ProcessPaneState, ProcessRuntimeState } from "./manager.ts";
import type { HerdrProcessDetails, HerdrProcessInput } from "./tool.ts";

interface RenderLine {
	text: string;
	wrap?: boolean;
}

interface ProcessRenderContext {
	lastComponent?: Component;
	expanded: boolean;
	cwd: string;
	isError: boolean;
}

class ProcessToolComponent implements Component {
	private lines: RenderLine[] = [];

	setLines(lines: RenderLine[]): void {
		this.lines = lines;
	}

	render(width: number): string[] {
		if (width <= 0) return [];
		return this.lines.flatMap((line) => {
			if (!line.text) return [""];
			return line.wrap
				? wrapTextWithAnsi(line.text, width)
				: [truncateToWidth(line.text, width, "…")];
		});
	}

	invalidate(): void {}
}

const ANSI_ESCAPE = /[\u001b\u009b](?:\][^\u0007]*(?:\u0007|\u001b\\)|\[[0-?]*[ -/]*[@-~])/gu;
const UNSAFE_CONTROLS = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/gu;

export function sanitizeProcessDisplayText(value: string): string {
	return value
		.replace(ANSI_ESCAPE, "")
		.replace(UNSAFE_CONTROLS, "")
		.replaceAll("\t", "  ");
}

function compact(value: string, fallback = "process"): string {
	const normalized = sanitizeProcessDisplayText(value).replace(/\s+/gu, " ").trim();
	return normalized || fallback;
}

function textContent(result: AgentToolResult<HerdrProcessDetails>): string {
	return sanitizeProcessDisplayText(result.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text")
		.map((item) => item.text)
		.join("\n"));
}

function componentFor(context: { lastComponent?: Component }): ProcessToolComponent {
	return context.lastComponent instanceof ProcessToolComponent
		? context.lastComponent
		: new ProcessToolComponent();
}

function shortId(value: string | undefined): string | undefined {
	return value?.split(":").at(-1);
}

export function formatProcessLocation(entry: Pick<ProcessEntry, "paneId" | "workspaceId" | "tabId">): string {
	return [entry.workspaceId, shortId(entry.tabId), shortId(entry.paneId)]
		.filter((value): value is string => Boolean(value))
		.join(" · ");
}

function callLabel(args: HerdrProcessInput): string {
	if (args.label?.trim()) return compact(args.label);
	if (args.command?.trim()) return deriveProcessLabel(args.command);
	return "process";
}

function callTitle(args: HerdrProcessInput, theme: Theme): string {
	const title = (value: string) => theme.fg("toolTitle", theme.bold(value));
	const muted = (value: string) => theme.fg("muted", value);
	switch (args.action) {
		case "start": {
			const command = compact(args.command ?? "", "…");
			return `${title("▸ Start process")} ${theme.fg("accent", callLabel(args))}${muted(` — ${command}`)}`;
		}
		case "list":
			return title("▸ List managed processes");
		case "logs":
			return `${title("▸ Read process output")} ${theme.fg("accent", compact(args.target ?? "latest"))}${muted(` · last ${args.lines ?? 200} lines`)}`;
		case "stop":
			return `${title("▸ Stop process")} ${theme.fg("accent", compact(args.target ?? "latest"))}`;
		default:
			return title("▸ Manage Herdr process");
	}
}

export function renderHerdrProcessCall(
	args: HerdrProcessInput,
	theme: Theme,
	context: ProcessRenderContext,
): Component {
	const component = componentFor(context);
	const lines: RenderLine[] = [{ text: callTitle(args, theme) }];
	if (context.expanded && args.action === "start") {
		lines.push(
			{ text: theme.fg("dim", `  cwd       ${compact(args.cwd ?? context.cwd)}`), wrap: true },
			{ text: theme.fg("dim", `  shell     ${args.shell ?? "default"} · ${args.lifetime ?? "default lifetime"}`) },
			{ text: theme.fg("dim", `  split     ${args.direction ?? "default"}${args.ratio === undefined ? "" : ` · ${args.ratio}`}`) },
		);
		if (args.readyMatch || args.readyRegex) {
			lines.push({
				text: theme.fg("dim", `  readiness ${compact(args.readyMatch ?? args.readyRegex ?? "")} · ${args.readyTimeoutMs ?? "default timeout"}ms`),
				wrap: true,
			});
		}
	}
	component.setLines(lines);
	return component;
}

function stateIcon(state: ProcessRuntimeState, theme: Theme): string {
	switch (state) {
		case "running": return theme.fg("success", "●");
		case "starting": return theme.fg("warning", "◐");
		case "exited": return theme.fg("muted", "✓");
		case "unknown": return theme.fg("warning", "?");
	}
}

function agentMarker(pane: ProcessPaneState | undefined, theme: Theme): string {
	if (!pane?.agent && !pane?.hasAgentSession) return "";
	const agent = compact(pane.agent ?? "agent");
	const status = pane.agentStatus ? ` ${compact(pane.agentStatus)}` : "";
	return theme.fg("accent", ` · ◆ ${agent}${status}`);
}

function findResultEntry(details: HerdrProcessDetails | undefined): ProcessEntry | undefined {
	if (!details) return undefined;
	return details.registry.entries.find((entry) =>
		entry.paneId === details.paneId || entry.label === details.label);
}

function renderStartResult(details: HerdrProcessDetails, theme: Theme, expanded: boolean): RenderLine[] {
	const entry = findResultEntry(details);
	const label = compact(details.label ?? entry?.label ?? "process");
	const location = entry ? formatProcessLocation(entry) : compact(details.paneId ?? "pane");
	const lines: RenderLine[] = [{
		text: `${theme.fg("success", "✓")} ${theme.fg("accent", label)} ${theme.fg("muted", `started · ${location}`)}`,
	}];
	if (expanded && entry) {
		lines.push(
			{ text: theme.fg("dim", `  ${entry.shell ?? "pane"} · ${entry.lifetime} · ${compact(entry.cwd)}`), wrap: true },
			{ text: theme.fg("toolOutput", `  $ ${sanitizeProcessDisplayText(entry.command)}`), wrap: true },
		);
	}
	return lines;
}

function renderListResult(details: HerdrProcessDetails, theme: Theme, expanded: boolean): RenderLine[] {
	const entries = details.registry.entries;
	if (entries.length === 0) return [{ text: theme.fg("muted", "No managed processes") }];
	const states = details.processStates ?? {};
	const counts: Record<ProcessRuntimeState, number> = { running: 0, starting: 0, exited: 0, unknown: 0 };
	for (const entry of entries) counts[states[entry.paneId] ?? "unknown"] += 1;
	const summary = [
		`${entries.length} managed`,
		counts.running ? `● ${counts.running} running` : undefined,
		counts.starting ? `◐ ${counts.starting} starting` : undefined,
		counts.exited ? `✓ ${counts.exited} exited` : undefined,
		counts.unknown ? `? ${counts.unknown} unknown` : undefined,
	].filter(Boolean).join(" · ");
	const lines: RenderLine[] = [{ text: theme.fg("muted", summary) }];
	if (!expanded) return lines;
	for (const entry of entries) {
		const state = states[entry.paneId] ?? "unknown";
		const pane = details.processPanes?.[entry.paneId];
		lines.push({
			text: `  ${stateIcon(state, theme)} ${theme.fg("accent", compact(entry.label))} ${theme.fg("muted", `${state} · ${formatProcessLocation(entry)} · ${entry.lifetime} · ${entry.shell ?? "pane"}`)}${agentMarker(pane, theme)}`,
		});
		lines.push({ text: theme.fg("dim", `    ${compact(entry.cwd)} · $ ${sanitizeProcessDisplayText(entry.command)}`), wrap: true });
	}
	if (details.stalePaneIds?.length) {
		lines.push({ text: theme.fg("warning", `  Removed stale ownership: ${details.stalePaneIds.map((value) => compact(value)).join(", ")}`), wrap: true });
	}
	return lines;
}

function logBody(raw: string): string {
	const newline = raw.indexOf("\n");
	return raw.startsWith("[") && newline >= 0 ? raw.slice(newline + 1) : raw;
}

function renderLogsResult(
	result: AgentToolResult<HerdrProcessDetails>,
	details: HerdrProcessDetails,
	theme: Theme,
	expanded: boolean,
): RenderLine[] {
	const output = logBody(textContent(result)).trimEnd();
	const logicalLines = output ? output.split("\n") : [];
	const label = compact(details.label ?? "process");
	const location = compact(details.paneId ?? "pane");
	const truncation = details.truncated ? " · truncated" : "";
	if (expanded) {
		return [
			{ text: theme.fg("muted", `${label} · ${location}${truncation}`) },
			...logicalLines.map((line) => ({ text: theme.fg("toolOutput", line), wrap: true })),
		];
	}
	const previewCount = 5;
	const preview = logicalLines.slice(-previewCount);
	const hidden = logicalLines.length - preview.length;
	const lines: RenderLine[] = [{
		text: theme.fg("muted", `${label} · ${location} · ${logicalLines.length} lines${truncation}`),
	}];
	if (hidden > 0) {
		const expandKey = keyText("app.tools.expand") || "Ctrl+O";
		lines.push({ text: theme.fg("dim", `… ${hidden} earlier lines · ${expandKey} to expand`) });
	}
	lines.push(...preview.map((line) => ({ text: theme.fg("toolOutput", `  ${line}`) })));
	return lines;
}

function renderError(
	result: AgentToolResult<HerdrProcessDetails>,
	theme: Theme,
	expanded: boolean,
): RenderLine[] {
	const raw = textContent(result).trim() || "Herdr process operation failed";
	const lines = raw.split("\n");
	return expanded
		? lines.map((line, index) => ({
			text: theme.fg(index === 0 ? "error" : "toolOutput", `${index === 0 ? "✗ " : "  "}${line}`),
			wrap: true,
		}))
		: [{ text: theme.fg("error", `✗ ${compact(lines[0] ?? raw)}`) }];
}

export function renderHerdrProcessResult(
	result: AgentToolResult<HerdrProcessDetails>,
	options: ToolRenderResultOptions,
	theme: Theme,
	context: ProcessRenderContext,
): Component {
	const component = componentFor(context);
	if (options.isPartial) {
		component.setLines([{ text: theme.fg("warning", "◐ Updating managed process state…") }]);
		return component;
	}
	if (context.isError) {
		component.setLines(renderError(result, theme, options.expanded));
		return component;
	}
	const details = result.details;
	let lines: RenderLine[];
	if (!details) {
		const raw = textContent(result).trim();
		lines = raw ? [{ text: theme.fg("toolOutput", raw), wrap: options.expanded }] : [];
	} else {
		switch (details.action) {
			case "start": lines = renderStartResult(details, theme, options.expanded); break;
			case "list": lines = renderListResult(details, theme, options.expanded); break;
			case "logs": lines = renderLogsResult(result, details, theme, options.expanded); break;
			case "stop": lines = [{
				text: `${theme.fg("success", "✓")} ${theme.fg("accent", compact(details.label ?? "process"))} ${theme.fg("muted", `stopped · ${compact(details.paneId ?? "pane")}`)}`,
			}]; break;
			default: lines = [{ text: theme.fg("toolOutput", textContent(result)), wrap: options.expanded }];
		}
	}
	component.setLines(lines);
	return component;
}
