import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	SURFACE_TITLE_MAX_WIDTH,
	SURFACE_TITLE_MIN_INNER_WIDTH,
	SURFACE_TITLE_RATIO,
	formatSurfaceScrollIndicator,
	planSurfaceBottomFrame,
	planSurfaceRow,
	planSurfaceStatus,
	planSurfaceStatusBudget,
	planSurfaceTopFrame,
	planWorkspaceTitle,
	renderSurfaceChunks,
	renderSurfaceTopMargin,
	safeSurfaceWidth,
	surfaceMetrics,
	surfaceTitleBudget,
} from "../surface-layout.js";
import type { WorkspaceLabelMode } from "../types.js";

const ANSI_PATTERN = /\x1b\[[0-?]*[ -/]*[@-~]/g;
const WIDTHS = [4, 12, 15, 16, 20, 56, 64, 72, 96, 120, 160];
const homePath = `${homedir()}/winnie/00_project/07_pi-glance`;

function stripAnsi(text: string): string {
	return text.replace(ANSI_PATTERN, "");
}

function plain(chunks: Parameters<typeof renderSurfaceChunks>[0]): string {
	return renderSurfaceChunks(chunks);
}

function colored(chunks: Parameters<typeof renderSurfaceChunks>[0]): string {
	return renderSurfaceChunks(chunks, {
		border: (text) => `\x1b[31m${text}\x1b[39m`,
		title: (text) => `\x1b[32m${text}\x1b[39m`,
		status: (text) => `\x1b[33m${text}\x1b[39m`,
		text: (text) => text,
		dim: (text) => `\x1b[2m${text}\x1b[22m`,
	});
}

function titlePlan(width: number, mode: WorkspaceLabelMode = "name", showTitle = true) {
	const metrics = surfaceMetrics(width);
	return planWorkspaceTitle({
		workspacePath: homePath,
		workspaceName: "07_pi-glance",
		mode,
		innerWidth: metrics.innerWidth,
		surfaceWidth: metrics.safeWidth,
		showTitle,
	});
}

for (const width of WIDTHS) {
	const metrics = surfaceMetrics(width);
	assert.equal(metrics.safeWidth, Math.max(4, width), `safe width clamps at ${width}`);
	assert.equal(metrics.innerWidth, metrics.safeWidth - 2, `inner width reserves borders at ${width}`);

	const title = titlePlan(width);
	const statusBudget = planSurfaceStatusBudget(metrics.innerWidth, title.width);
	const status = planSurfaceStatus("git main · ctx 23% · $0.042 · Sonnet 4", statusBudget, "…");
	const top = planSurfaceTopFrame({ width, left: title, status: status.text, statusEllipsis: "…" });
	const bottom = planSurfaceBottomFrame({ width });
	const bottomWithIndicator = planSurfaceBottomFrame({ width, scrollIndicator: formatSurfaceScrollIndicator("│ ↑ 123 more │", width) });
	const row = planSurfaceRow({ width, text: "Ask pi to improve the input surface...", prefix: "› " });
	assert.deepEqual(renderSurfaceTopMargin(width, 0), [], `zero top margin rows render no lines at width ${width}`);
	assert.deepEqual(renderSurfaceTopMargin(width), [" "], `default top margin is one defensive space at width ${width}`);
	assert.deepEqual(renderSurfaceTopMargin(width, 1), [" "], `one top margin row is one defensive space at width ${width}`);
	assert.deepEqual(renderSurfaceTopMargin(width, 2), [" ", " "], `two top margin rows are defensive spaces at width ${width}`);
	for (const line of renderSurfaceTopMargin(width, 2)) {
		assert.equal(line.trim(), "", `top margin line is blank after trim at width ${width}`);
		assert.ok(visibleWidth(line) <= metrics.safeWidth, `top margin should fit width ${width}`);
	}

	for (const [label, rendered] of [
		["top", plain(top.chunks)],
		["top colored", colored(top.chunks)],
		["bottom", plain(bottom.chunks)],
		["bottom indicator", plain(bottomWithIndicator.chunks)],
		["row", plain(row.chunks)],
	] as const) {
		assert.ok(visibleWidth(rendered) <= metrics.safeWidth, `${label} line should fit width ${width}: ${stripAnsi(rendered)}`);
	}
}

assert.deepEqual(renderSurfaceTopMargin(80, -1), [], "negative row count clamps to no top margin rows");
assert.deepEqual(renderSurfaceTopMargin(80, 99), [" ", " "], "large row count clamps to two top margin rows");
assert.deepEqual(renderSurfaceTopMargin(80, 1.9), [" "], "fractional row count floors before rendering");
assert.deepEqual(renderSurfaceTopMargin(80, Number.NaN), [], "non-finite row count renders no top margin rows");
assert.deepEqual(renderSurfaceTopMargin(0, 2), ["", ""], "zero width keeps row count but uses empty lines");
assert.deepEqual(renderSurfaceTopMargin(-1, 1), [""], "negative width keeps row count but uses an empty line");
assert.deepEqual(renderSurfaceTopMargin(Number.NaN, 1), [""], "non-finite width keeps row count but uses an empty line");
assert.equal(surfaceTitleBudget(200), SURFACE_TITLE_MAX_WIDTH, "title budget is capped at 48 columns");
assert.equal(surfaceTitleBudget(100), 42, "title budget uses the 42% ratio before the cap");
assert.equal(surfaceTitleBudget(99), Math.floor(99 * SURFACE_TITLE_RATIO), "title budget ratio is floored");

for (const width of [4, 12, 15]) {
	const title = titlePlan(width);
	assert.equal(title.kind, "fallback", `innerWidth < ${SURFACE_TITLE_MIN_INNER_WIDTH} uses horizontal fallback at width ${width}`);
	assert.equal(plain(title.chunks), "─", `fallback title is a single border segment at width ${width}`);
}

const minTitle = titlePlan(18);
assert.equal(minTitle.kind, "workspace", "innerWidth 16 is the first workspace-title width");
assert.equal(minTitle.label, "07_…", "innerWidth 16 title uses the tiny label budget");
assert.equal(plain(minTitle.chunks), "─ 07_… ", "innerWidth 16 title includes a padded truncated workspace name");

const hiddenTitle = titlePlan(120, "name", false);
assert.equal(hiddenTitle.kind, "hidden", "showTitle false records a hidden title plan");
assert.equal(plain(hiddenTitle.chunks), "─", "showTitle false leaves only the border lead-in");
const hiddenTop = planSurfaceTopFrame({ width: 120, left: hiddenTitle, status: "ctx 23%" });
assert.ok(!plain(hiddenTop.chunks).includes("07_pi-glance"), "showTitle false excludes workspace label from top frame");

const statusEmpty = planSurfaceTopFrame({ width: 64, left: titlePlan(64), status: "" });
assert.equal(statusEmpty.status.text, "", "empty status remains empty");
assert.equal(statusEmpty.status.width, 0, "empty status has zero width");
assert.ok(!plain(statusEmpty.chunks).includes("  ─╮"), "empty status does not add status chrome");

const statusNonEmpty = planSurfaceTopFrame({ width: 64, left: titlePlan(64), status: "ctx 23%" });
assert.equal(statusNonEmpty.status.text, "ctx 23%", "non-empty status is kept when it fits");
assert.ok(plain(statusNonEmpty.chunks).includes(" ctx 23% ─╮"), "non-empty status gets gap and right cap");

const nameLabel = titlePlan(160, "name");
assert.equal(nameLabel.label, "07_pi-glance", "name workspace label uses the workspace name");
assert.ok(plain(nameLabel.chunks).includes(" 07_pi-glance "), "name workspace title is padded");

const smartNarrow = titlePlan(72, "smart");
assert.equal(smartNarrow.label, "07_pi-glance", "smart workspace label uses name at narrow surface widths");
const smartMedium = titlePlan(120, "smart");
assert.equal(smartMedium.label, "…/00_project/07_pi-glance", "smart workspace label uses parent path at medium widths");
const pathWide = titlePlan(160, "path");
assert.equal(pathWide.label, "~/winnie/00_project/07_pi-glance", "path workspace label uses safe home-shortened path");

const longPath = "/mnt/data/workspaces/clients/acme/super/long/project/pi-glance";
const pathSmall = planWorkspaceTitle({
	workspacePath: longPath,
	workspaceName: "pi-glance",
	mode: "path",
	innerWidth: 54,
	surfaceWidth: 56,
});
assert.ok(pathSmall.label.includes("pi-glance"), "long path labels keep the project name when truncated");
assert.ok(!pathSmall.label.startsWith("/"), "long path labels avoid absolute path disclosure");
assert.ok(visibleWidth(pathSmall.title) <= pathSmall.budget, "long path title fits its budget");

const plainBottom = planSurfaceBottomFrame({ width: 12 });
assert.equal(plain(plainBottom.chunks), "╰──────────╯", "bottom frame without indicator fills the whole inner width");
assert.equal(visibleWidth(plain(plainBottom.chunks)), safeSurfaceWidth(12), "plain bottom frame reaches the safe width exactly");

const boundedProgressBottom = planSurfaceBottomFrame({ width: 20, status: "23%", contextProgress: { percent: 50, maxWidth: 6 } });
assert.equal(plain(boundedProgressBottom.chunks), "╰─────────╼━━ 23% ─╯", "bounded border progress should grow heavy cells leftward from the status");
assert.equal(boundedProgressBottom.progressWidth, 6, "bounded border progress should honor maxWidth");
assert.equal(boundedProgressBottom.leadingFillerWidth, 6, "bounded border progress should preserve leading border filler");
assert.equal(
	renderSurfaceChunks(boundedProgressBottom.chunks, {
		contextProgressEmpty: (text) => `<empty>${text}</empty>`,
		contextProgressFilled: (text) => `<filled>${text}</filled>`,
	}),
	"╰──────<empty>───</empty><filled>╼━━</filled> 23% ─╯",
	"border progress should expose separate empty and filled chunk roles for semantic styling",
);
const remainingProgressBottom = planSurfaceBottomFrame({ width: 20, status: "23%", contextProgress: { percent: 25 } });
assert.equal(remainingProgressBottom.progressWidth, 12, "remaining border progress should consume all filler before the fixed status");
assert.equal(remainingProgressBottom.leadingFillerWidth, 0, "remaining border progress should leave no unrelated leading filler");
assert.equal(plain(remainingProgressBottom.chunks), "╰─────────╼━━ 23% ─╯", "remaining border progress should keep exact frame geometry");
const unknownProgressBottom = planSurfaceBottomFrame({ width: 20, status: "?", contextProgress: { percent: null, maxWidth: 6 } });
assert.equal(unknownProgressBottom.progressWidth, 6, "unknown progress should retain its configured width");
assert.equal(plain(unknownProgressBottom.chunks), "╰────────────── ? ─╯", "unknown progress should remain a light border track");

const indicator = formatSurfaceScrollIndicator("╰── ↓ 45 more ─╯", 20);
assert.equal(indicator, "─── ↓ 45 more ", "down scroll indicator is extracted and framed");
const upIndicator = formatSurfaceScrollIndicator("╭── ↑ 7 more ─╮", 20);
assert.equal(upIndicator, "─── ↑ 7 more ", "up scroll indicator is extracted and framed");
const noIndicator = formatSurfaceScrollIndicator("╰────────╯", 20);
assert.equal(noIndicator, undefined, "scroll indicator returns undefined when absent");
const tinyIndicator = formatSurfaceScrollIndicator("↑ 123456789 more", 12);
assert.ok(tinyIndicator, "tiny scroll indicator still renders something");
assert.ok(visibleWidth(tinyIndicator!) <= surfaceMetrics(12).innerWidth, "tiny scroll indicator is truncated to inner width");
const tinyIndicatorBottom = planSurfaceBottomFrame({ width: 4, scrollIndicator: formatSurfaceScrollIndicator("↓ 999 more", 4) });
assert.equal(plain(tinyIndicatorBottom.chunks), "╰──╯", "tiny bottom indicator truncates to available inner width");
const indicatorBottom = planSurfaceBottomFrame({ width: 20, scrollIndicator: indicator });
assert.equal(plain(indicatorBottom.chunks), "╰─── ↓ 45 more ────╯", "bottom frame embeds down scroll indicator and fills the rest");
const upIndicatorBottom = planSurfaceBottomFrame({ width: 20, scrollIndicator: upIndicator });
assert.equal(plain(upIndicatorBottom.chunks), "╰─── ↑ 7 more ─────╯", "bottom frame embeds up scroll indicator and fills the rest");

const previewRow = planSurfaceRow({ width: 20, text: "abcdefghijklmnopq", prefix: "› " });
assert.equal(previewRow.contentBudget, 16, "preview row planning reserves borders and prefix");
assert.equal(plain(previewRow.chunks), "│› abcdefghijklmno…│", "preview row planning truncates and pads content");
assert.equal(visibleWidth(plain(previewRow.chunks)), safeSurfaceWidth(20), "preview row render reaches the safe width exactly");

const paddedRow = planSurfaceRow({ width: 20, text: "abcdefghijklmnopq", paddingX: 1, reserveRightPadding: true, ellipsis: "" });
assert.equal(paddedRow.contentBudget, 16, "padded row planning reserves borders and side padding");
assert.equal(plain(paddedRow.chunks), "│ abcdefghijklmnop │", "padded row planning truncates and preserves side padding");
assert.equal(visibleWidth(plain(paddedRow.chunks)), safeSurfaceWidth(20), "padded row render reaches the safe width exactly");

console.log("✓ surface layout checks passed");
