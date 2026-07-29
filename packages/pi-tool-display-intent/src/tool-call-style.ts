import type { Component } from "@earendil-works/pi-tui";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { ToolCallStyle } from "./types.js";

export interface ToolCallStyleTheme {
	fg(color: string, text: string): string;
	bold(text: string): string;
}

export interface ToolCallStatusContext {
	executionStarted?: boolean;
	isError?: boolean;
	isPartial?: boolean;
}

const CLAUDE_TOOL_LABELS: Record<string, string> = {
	read: "Read",
	grep: "Search",
	find: "Find",
	ls: "List",
	bash: "Bash",
	edit: "Update",
	write: "Write",
	mcp: "MCP",
};

export function getClaudeToolLabel(toolName: string): string {
	return CLAUDE_TOOL_LABELS[toolName] ?? toolName;
}

export function formatClaudeStatusMarker(
	theme: ToolCallStyleTheme,
	context?: ToolCallStatusContext,
	runningFrame?: string,
): string {
	if (context?.isError) {
		return theme.fg("error", "●");
	}
	if (context?.isPartial) {
		return theme.fg("warning", runningFrame || "●");
	}
	return theme.fg("success", "●");
}

export function formatClaudeToolCall(
	toolName: string,
	target: string,
	metadataSuffix: string,
	intentSuffix: string,
	theme: ToolCallStyleTheme,
	context?: ToolCallStatusContext,
	runningFrame?: string,
): string {
	const marker = formatClaudeStatusMarker(theme, context, runningFrame);
	const label = getClaudeToolLabel(toolName);
	return `${marker} ${theme.fg("toolTitle", theme.bold(label))}(${target})${metadataSuffix}${intentSuffix}`;
}

function isComponent(value: unknown): value is Component {
	if (!value || typeof value !== "object") {
		return false;
	}
	const candidate = value as Partial<Component>;
	return typeof candidate.render === "function" && typeof candidate.invalidate === "function";
}

function stripLegacyResultMarker(line: string): string {
	const marker = "↳ ";
	const index = line.indexOf(marker);
	return index < 0 ? line : `${line.slice(0, index)}${line.slice(index + marker.length)}`;
}

export interface ClaudeToolResultStyleOptions {
	connectRows?: boolean;
	theme?: Pick<ToolCallStyleTheme, "fg">;
}

export class ClaudeToolResultComponent implements Component {
	constructor(
		private readonly child: Component,
		private readonly options: ClaudeToolResultStyleOptions = {},
	) {}

	render(width: number): string[] {
		if (width <= 0) {
			return [];
		}

		const firstPrefix = this.options.connectRows ? "  │ " : "  ⎿ ";
		const continuationPrefix = this.options.connectRows ? "  │ " : "    ";
		const lastPrefix = this.options.connectRows ? "  └ " : continuationPrefix;
		const prefixWidth = Math.max(
			visibleWidth(firstPrefix),
			visibleWidth(continuationPrefix),
			visibleWidth(lastPrefix),
		);
		const contentWidth = Math.max(1, width - prefixWidth);
		const childLines = this.child.render(contentWidth);
		const firstContentLine = childLines.findIndex((line) => visibleWidth(line) > 0);
		if (firstContentLine < 0) {
			return [];
		}

		const lastContentLine = childLines.length - 1;
		return childLines.map((rawLine, index) => {
			const plainPrefix = index === firstContentLine
				? (this.options.connectRows && firstContentLine === lastContentLine ? lastPrefix : firstPrefix)
				: (index === lastContentLine ? lastPrefix : continuationPrefix);
			const prefix = this.options.theme?.fg("muted", plainPrefix) ?? plainPrefix;
			const line = index === firstContentLine ? stripLegacyResultMarker(rawLine) : rawLine;
			return truncateToWidth(`${prefix}${line}`, width, "");
		});
	}

	invalidate(): void {
		this.child.invalidate();
	}
}

export function applyToolResultStyle(
	component: unknown,
	style: ToolCallStyle,
	options: ClaudeToolResultStyleOptions = {},
): unknown {
	if (style !== "claude" || component instanceof ClaudeToolResultComponent || !isComponent(component)) {
		return component;
	}
	return new ClaudeToolResultComponent(component, options);
}
