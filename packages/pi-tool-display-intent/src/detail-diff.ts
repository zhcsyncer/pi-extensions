import type { Theme } from "@earendil-works/pi-coding-agent";
import { wrapTextWithAnsi, type Component } from "@earendil-works/pi-tui";
import { renderEditDiffResult } from "./diff-renderer.js";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "./types.js";

export type DetailDiffTheme = Pick<Theme, "fg" | "bold"> & Partial<Pick<Theme, "bg" | "getBgAnsi" | "getFgAnsi">>;

/** Reuse our pure diff renderer, never a tool's arbitrary renderResult callback. */
export function createDetailDiffRenderer(
	text: string,
	filePath: string | undefined,
	theme?: DetailDiffTheme,
	config: ToolDisplayConfig = DEFAULT_TOOL_DISPLAY_CONFIG,
	source?: "edit" | "write",
): Component {
	const renderer = renderEditDiffResult(
		{ diff: text },
		{ expanded: true, filePath },
		{
			...config,
			// Write shows supplied content, not a before/after comparison. A split
			// layout would reserve an empty old-content pane even on wide screens.
			diffViewMode: source === "write" ? "unified" : config.diffViewMode,
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
	if (source !== "write") return renderer;
	return {
		render(width) {
			if (!Number.isFinite(width) || width <= 0) return [];
			const caption = "Written content · all additions (not an overwrite diff)";
			return [...wrapTextWithAnsi(theme?.fg("muted", caption) ?? caption, width), ...renderer.render(width)];
		},
		invalidate: () => renderer.invalidate(),
	};
}
