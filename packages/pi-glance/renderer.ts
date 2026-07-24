import { renderInputSurfaceFrame } from "./input-surface-frame.js";
import { resolveGlanceRenderStyles, type GlanceRenderStyleContext } from "./theme-adapter.js";
import type { GlanceConfig, GlanceState } from "./types.js";

interface InputSurfaceRenderOptions extends GlanceRenderStyleContext {
	contentLines?: string[];
	focused?: boolean;
	showTitle?: boolean;
}

export function renderInputSurfacePreview(config: GlanceConfig, width: number, options: InputSurfaceRenderOptions = {}): string[] {
	const state: GlanceState = {
		workspace: { name: "pi-glance", path: "/Users/winnie/projects/pi-glance" },
		git: {
			repo: true,
			branch: "main",
			detached: false,
			sha: "a1b2c3d",
			upstream: "origin/main",
			ahead: 2,
			behind: 1,
			staged: 1,
			unstaged: 1,
			untracked: 0,
			conflicts: 0,
			dirty: true,
			status: "dirty",
			updatedAt: Date.now(),
		},
		providers: { availableCount: 2 },
		model: { id: "claude-sonnet-4-20250514", provider: "anthropic", displayName: "Sonnet 4", thinking: "high", reasoning: true },
		runtime: {
			autoCompactEnabled: true,
		},
		context: { tokens: 46_800, window: 200_000, percent: 23.4 },
		usage: { input: 12_400, output: 3_100, cacheRead: 800, cacheWrite: 0, cost: 0.042 },
		throughput: { lastTurn: null, currentRun: null },
		version: 0,
	};
	return renderInputSurface(state, config, width, options);
}

export function renderInputSurface(
	state: GlanceState,
	config: GlanceConfig,
	width: number,
	options: InputSurfaceRenderOptions = {},
): string[] {
	const styles = resolveGlanceRenderStyles(config.theme, options);
	return renderInputSurfaceFrame({
		state,
		config,
		width,
		styles,
		body: {
			kind: "preview",
			lines: options.contentLines,
			showPromptIndicator: Boolean(options.focused),
		},
		chrome: {
			showTitle: options.showTitle,
		},
	});
}
