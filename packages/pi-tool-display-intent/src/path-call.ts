import { Text, visibleWidth, wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { compactPathForDisplay, shortenPath } from "./render-utils.js";

export interface PathCallRenderContextLike {
	expanded?: boolean;
	lastComponent?: unknown;
}

interface PathCallViewState {
	path?: string;
	expanded: boolean;
	buildLine(displayPath: string): string;
}

function normalizeRenderWidth(width: number): number {
	return Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
}

const LEADING_SEPARATOR_PLACEHOLDER = "\uE000";

interface ProtectedCallLine {
	content: string;
	placeholder?: string;
}

/**
 * Pi TUI's word wrapper moves an overlong second token onto a fresh line. For
 * Claude-style calls that can leave the one-character status marker orphaned.
 * Temporarily make its separator non-whitespace so the long token is hard-wrapped
 * together with the marker, then restore the visual space after rendering.
 */
function protectLeadingStatusSeparator(content: string, width: number): ProtectedCallLine {
	const wrapped = wrapTextWithAnsi(content, width);
	if (wrapped.length < 2 || visibleWidth(wrapped[0] ?? "") !== 1) {
		return { content };
	}

	const separatorIndex = content.indexOf(" ");
	if (separatorIndex < 0) {
		return { content };
	}

	return {
		content: `${content.slice(0, separatorIndex)}${LEADING_SEPARATOR_PLACEHOLDER}${content.slice(separatorIndex + 1)}`,
		placeholder: LEADING_SEPARATOR_PLACEHOLDER,
	};
}

function fitCollapsedPath(
	fullPath: string,
	width: number,
	buildLine: (displayPath: string) => string,
): string {
	const fullLine = buildLine(fullPath);
	if (visibleWidth(fullLine) <= width) {
		return fullPath;
	}

	const marker = "x";
	const fixedWidth = Math.max(0, visibleWidth(buildLine(marker)) - visibleWidth(marker));
	let pathBudget = Math.max(1, width - fixedWidth);
	let displayPath = compactPathForDisplay(fullPath, pathBudget);

	while (pathBudget > 1 && visibleWidth(buildLine(displayPath)) > width) {
		pathBudget--;
		displayPath = compactPathForDisplay(fullPath, pathBudget);
	}

	return displayPath;
}

/**
 * Width-aware call header for path-bearing tools.
 *
 * Collapsed tool rows compact only the path portion so metadata and intent stay
 * readable on one line. Expanded rows restore the complete path and let Text
 * perform normal wrapping when the terminal is narrower than that full value.
 */
export class PathCallComponent implements Component {
	private renderedContent?: string;
	private renderedText?: Text;

	constructor(private viewState: PathCallViewState) {}

	update(viewState: PathCallViewState): void {
		this.viewState = viewState;
	}

	render(width: number): string[] {
		const safeWidth = normalizeRenderWidth(width);
		if (safeWidth === 0) {
			return [];
		}

		const fullPath = shortenPath(this.viewState.path) || "...";
		const displayPath = this.viewState.expanded
			? fullPath
			: fitCollapsedPath(fullPath, safeWidth, this.viewState.buildLine);
		const content = this.viewState.buildLine(displayPath);
		const protectedLine = this.viewState.expanded
			? protectLeadingStatusSeparator(content, safeWidth)
			: { content };

		if (!this.renderedText) {
			this.renderedText = new Text(protectedLine.content, 0, 0);
			this.renderedContent = protectedLine.content;
		} else if (this.renderedContent !== protectedLine.content) {
			this.renderedText.setText(protectedLine.content);
			this.renderedContent = protectedLine.content;
		}

		const lines = this.renderedText.render(safeWidth);
		return protectedLine.placeholder
			? lines.map((line) => line.replace(protectedLine.placeholder!, " "))
			: lines;
	}

	invalidate(): void {
		this.renderedText?.invalidate();
		this.renderedText = undefined;
		this.renderedContent = undefined;
	}
}

export function renderPathCall(
	path: string | undefined,
	buildLine: (displayPath: string) => string,
	context?: PathCallRenderContextLike,
): PathCallComponent {
	const viewState: PathCallViewState = {
		path,
		expanded: context?.expanded === true,
		buildLine,
	};
	const component = context?.lastComponent instanceof PathCallComponent
		? context.lastComponent
		: new PathCallComponent(viewState);
	component.update(viewState);
	return component;
}
