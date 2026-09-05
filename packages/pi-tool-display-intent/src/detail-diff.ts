import type { Theme } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { renderEditDiffResult } from "./diff-renderer.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG } from "./types.js";

export type DetailDiffTheme = Pick<Theme, "fg" | "bold"> & Partial<Pick<Theme, "bg" | "getBgAnsi" | "getFgAnsi">>;

/** Reuse our pure diff renderer, never a tool's arbitrary renderResult callback. */
export function createDetailDiffRenderer(text: string, filePath: string | undefined, theme?: DetailDiffTheme): Component {
	return renderEditDiffResult(
		{ diff: text },
		{ expanded: true, filePath },
		{
			...DEFAULT_TOOL_DISPLAY_CONFIG,
			diffViewMode: "unified",
			diffIndicatorMode: "classic",
			diffWordWrap: true,
			// The snapshot model already bounds input. The popup scrolls rendered
			// rows itself; a second Ctrl+O truncation hint would be misleading here.
			expandedPreviewMaxRows: 0,
		},
		{
			fg: (color, value) => theme?.fg(color as Parameters<Theme["fg"]>[0], value) ?? value,
			bold: (value) => theme?.bold(value) ?? value,
			...(theme?.bg ? { bg: (color: string, value: string) => theme.bg!(color as Parameters<Theme["bg"]>[0], value) } : {}),
			...(theme?.getBgAnsi ? { getBgAnsi: (color: string) => theme.getBgAnsi!(color as Parameters<Theme["getBgAnsi"]>[0]) } : {}),
			...(theme?.getFgAnsi ? { getFgAnsi: (color: string) => theme.getFgAnsi!(color as Parameters<Theme["getFgAnsi"]>[0]) } : {}),
		},
		text,
	);
}
