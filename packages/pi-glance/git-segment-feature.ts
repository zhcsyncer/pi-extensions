import { GIT_SHA_MODE_VALUES } from "./config-options.js";
import type { SegmentFeature } from "./segment-feature.js";
import type { GlanceConfig, SegmentData, SegmentRenderContext } from "./types.js";

const POLL_INTERVALS = [2000, 5000, 10000, 30000] as const;

function nextIn<T extends string | number>(current: T, values: readonly T[]): T {
	const index = values.indexOf(current);
	return values[(index + 1) % values.length] ?? values[0]!;
}

function nextNumber<T extends number>(current: number, values: readonly T[]): T {
	const index = values.indexOf(current as T);
	return values[(index + 1) % values.length] ?? values[0]!;
}

function onOff(value: boolean): string {
	return value ? "on" : "off";
}

function formatPolling(ms: number): string {
	if (ms % 1000 === 0) return `${ms / 1000}s`;
	return `${ms}ms`;
}

function gitBranchLabel(ctx: SegmentRenderContext): string {
	const git = ctx.state.git;
	if (git.branch) {
		if (ctx.config.git.shaMode === "always" && git.sha) return `${git.branch} ${git.sha}`;
		return git.branch;
	}
	if (git.detached && git.sha && ctx.config.git.shaMode !== "off") return git.sha;
	return "HEAD";
}

function gitStatusMark(ctx: SegmentRenderContext): string {
	const status = ctx.state.git.status;
	if (status === "conflict") return ctx.config.icons === "nerd" ? "⚠" : "!";
	if (status === "dirty") return ctx.config.icons === "nerd" ? "●" : "*";
	return "";
}

function gitDetailParts(ctx: SegmentRenderContext): string[] {
	const git = ctx.state.git;
	const parts: string[] = [];
	const status = gitStatusMark(ctx);
	if (status && (ctx.config.git.showDirty || git.status === "conflict")) parts.push(status);
	if (ctx.config.git.showAheadBehind) {
		if (git.ahead > 0) parts.push(`↑${git.ahead}`);
		if (git.behind > 0) parts.push(`↓${git.behind}`);
	}
	return parts;
}

function collectGit(ctx: SegmentRenderContext): SegmentData | undefined {
	const git = ctx.state.git;
	if (!git.repo) return undefined;
	const branch = gitBranchLabel(ctx);
	const parts = gitDetailParts(ctx);
	const secondary = parts.join(" ") || undefined;
	const minimalStatus = git.status === "conflict" || ctx.config.git.showDirty ? gitStatusMark(ctx) : "";
	return {
		primary: branch,
		secondary,
		display: {
			minimal: [branch, minimalStatus].filter(Boolean).join(" "),
		},
	};
}

export const gitSegmentFeature = {
	id: "git",
	label: "Git",
	defaultEnabled: true,
	settings: [
		{
			id: "git.dirtyMarker",
			label: "Dirty marker",
			hint: "Conflicts always stay visible.",
			kind: "toggle",
			value: (config: GlanceConfig) => onOff(config.git.showDirty),
			mutate: (config: GlanceConfig) => {
				config.git.showDirty = !config.git.showDirty;
			},
		},
		{
			id: "git.aheadBehind",
			label: "Ahead / behind",
			hint: "Show upstream counts.",
			kind: "toggle",
			value: (config: GlanceConfig) => onOff(config.git.showAheadBehind),
			mutate: (config: GlanceConfig) => {
				config.git.showAheadBehind = !config.git.showAheadBehind;
			},
		},
		{
			id: "git.sha",
			label: "SHA",
			hint: "Keep branches quiet unless enabled.",
			kind: "cycle",
			value: (config: GlanceConfig) => config.git.shaMode,
			mutate: (config: GlanceConfig) => {
				config.git.shaMode = nextIn(config.git.shaMode, GIT_SHA_MODE_VALUES);
			},
		},
		{
			id: "git.polling",
			label: "Polling",
			hint: "Check external Git changes.",
			kind: "cycle",
			value: (config: GlanceConfig) => formatPolling(config.git.pollIntervalMs),
			mutate: (config: GlanceConfig) => {
				config.git.pollIntervalMs = nextNumber(config.git.pollIntervalMs, POLL_INTERVALS);
			},
		},
	],
	collect: collectGit,
} as const satisfies SegmentFeature;
