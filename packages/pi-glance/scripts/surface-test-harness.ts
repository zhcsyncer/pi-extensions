import { testState } from "./helpers.js";
import type { GlanceConfig, GlanceState, SegmentId } from "../types.js";

const ANSI_PATTERN = /\x1b(?:\][^\x07]*(?:\x07|\x1b\\)|_[^\x07]*(?:\x07|\x1b\\)|\[[0-?]*[ -/]*[@-~])/g;

export function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

export function onlySegments(config: GlanceConfig, ids: SegmentId[]): void {
	const enabled = new Set(ids);
	config.segments = config.segments.map((segment) => ({ ...segment, enabled: enabled.has(segment.id) }));
}

export function richInputSurfaceState(): GlanceState {
	return testState({
		workspace: { name: "07_pi-glance", path: "/Users/winnie/00_project/07_pi-glance" },
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
			updatedAt: 0,
		},
		providers: { availableCount: 2 },
		model: { id: "claude-sonnet-4-20250514", provider: "anthropic", displayName: "Sonnet 4", thinking: "high" },
		context: { tokens: 46_800, window: 200_000, percent: 23.4 },
		usage: { input: 12_400, output: 3_100, cacheRead: 800, cacheWrite: 0, cost: 0.042 },
	});
}

export function dirtyInputSurfaceState(): GlanceState {
	return richInputSurfaceState();
}
