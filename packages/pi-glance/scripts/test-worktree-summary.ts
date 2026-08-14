import { strict as assert } from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaultConfig } from "../config.js";
import { parseGitStatus } from "../git.js";
import { renderInputSurfaceFrame } from "../input-surface-frame.js";
import { resolveBuiltInGlanceStyles, resolveGlanceRenderStyles, resolvePiThemeStyles } from "../theme-adapter.js";
import {
	WorktreeSummaryWidget,
	renderAboveWorktreeSummary,
	renderWorktreeInline,
	worktreeInlineCandidates,
} from "../worktree-summary.js";
import { onlySegments, stripAnsi } from "./surface-test-harness.js";
import { testState } from "./helpers.js";
import type { GitSnapshot, GlanceState } from "../types.js";

function snapshot(overrides: Partial<GitSnapshot["worktree"]> = {}): GitSnapshot {
	const base = parseGitStatus(
		["# branch.oid 1234567890abcdef1234567890abcdef12345678", "# branch.head main", `1 AM N... 100644 100644 100644 ${"a".repeat(40)} ${"b".repeat(40)} changed.ts`, ""].join("\0"),
		1000,
		{ additions: 123, deletions: 99 },
	);
	return {
		...base,
		worktree: {
			...base.worktree,
			files: 6,
			...overrides,
		},
	};
}

const styles = resolveBuiltInGlanceStyles("dark");
const lightStyles = resolveBuiltInGlanceStyles("light");
const dirty = snapshot();
const glanceConfig = defaultConfig();
glanceConfig.colorSource = "glance";
glanceConfig.theme = { light: "light", dark: "dark" };
const resolvedLight = resolveGlanceRenderStyles(glanceConfig, { ambientTone: "light" });
const resolvedDark = resolveGlanceRenderStyles(glanceConfig, { ambientTone: "dark" });
assert.equal(resolvedLight.themeId, "light", "Glance color source should select the configured light palette for light terminals");
assert.equal(resolvedDark.themeId, "dark", "Glance color source should select the configured dark palette for dark terminals");
assert.notEqual(renderWorktreeInline(dirty, 80, resolvedLight), renderWorktreeInline(dirty, 80, resolvedDark), "working tree ANSI should follow the selected Glance light/dark palette");
assert.notEqual(renderWorktreeInline(dirty, 80, lightStyles), renderWorktreeInline(dirty, 80, styles), "direct light and dark ResolvedGlanceStyles should remain visually distinct");

assert.equal(stripAnsi(renderWorktreeInline(dirty, 80, styles)), "Δ 6 files · +123 −99", "wide inline summary should use the full responsive candidate");
assert.equal(stripAnsi(renderWorktreeInline(dirty, 15, styles)), "Δ 6 · +123 −99", "medium inline summary should drop the files label before stats");
assert.equal(stripAnsi(renderWorktreeInline(dirty, 3, styles)), "Δ 6", "narrow inline summary should preserve the delta and unique file count");
for (const width of [1, 3, 8, 15, 24, 80]) {
	assert.ok(visibleWidth(renderWorktreeInline(dirty, width, styles)) <= width, `inline summary should fit width ${width}`);
}
assert.equal(worktreeInlineCandidates(dirty).length, 3, "normal dirty summaries should expose exactly full, compact, and minimal candidates");

const conflict = snapshot({ conflicts: ["a.ts", "b.ts"], files: 6 });
conflict.conflicts = 2;
conflict.status = "conflict";
assert.equal(stripAnsi(renderWorktreeInline(conflict, 80, styles)), "! 2 conflicts · Δ 6 files · +123 −99", "wide conflict summary should expose conflicts ahead of normal stats");
assert.equal(stripAnsi(renderWorktreeInline(conflict, 3, styles)), "! 2", "narrow conflict summary should retain conflict count ahead of file details");

const clean = parseGitStatus("# branch.oid 1234567890abcdef1234567890abcdef12345678\0# branch.head main\0", 1000, { additions: 0, deletions: 0 });
assert.equal(stripAnsi(renderWorktreeInline(clean, 80, styles)), "Δ clean", "wide clean summary should be explicit");
assert.equal(renderWorktreeInline(clean, 3, styles), "", "clean summary should be the first fact hidden on narrow borders");

const compact = renderAboveWorktreeSummary(dirty, "above-compact", 80, styles);
assert.equal(compact.length, 1, "above compact should be one unframed widget line");
assert.equal(stripAnsi(compact[0] ?? ""), "● Working tree · 6 files · +123 −99    /diff", "above compact should include the review hint and tracked stats");
assert.equal(stripAnsi(compact[0] ?? "").includes("╭"), false, "above compact should never add an input/dialog border");

const detailed = renderAboveWorktreeSummary(dirty, "above-detailed", 50, styles);
assert.equal(detailed.length, 2, "above detailed should be exactly two unframed widget lines");
assert.equal(stripAnsi(detailed[0] ?? ""), "● Working tree · 6 files    /diff", "detailed first line should keep title, files, and review hint");
assert.ok(stripAnsi(detailed[1] ?? "").startsWith("+123 −99  "), "detailed second line should lead with additions and deletions");
assert.ok((detailed[1] ?? "").includes(styles.success("━".repeat(13))), "detailed ratio bar should color the rounded addition share with success");
assert.ok((detailed[1] ?? "").includes(styles.error("━".repeat(11))), "detailed ratio bar should color the remaining deletion share with error");
const unavailable = renderAboveWorktreeSummary(snapshot({ additions: null, deletions: null }), "above-detailed", 50, styles);
assert.equal(stripAnsi(unavailable[1] ?? ""), "Line statistics unavailable", "uncalculable detailed stats should be omitted rather than guessed");
for (const mode of ["above-compact", "above-detailed"] as const) {
	for (const width of [4, 12, 24, 50, 80]) {
		for (const line of renderAboveWorktreeSummary(conflict, mode, width, styles)) {
			assert.ok(visibleWidth(line) <= width, `${mode} conflict line should fit width ${width}`);
		}
	}
}

const piStyles = resolvePiThemeStyles({
	name: "worktree-pi",
	fg: (token, text) => `<${token}>${text}</${token}>`,
	bold: (text) => `<bold>${text}</bold>`,
});
const piConfig = defaultConfig();
piConfig.colorSource = "pi";
const resolvedPi = resolveGlanceRenderStyles(piConfig, { getPiStyles: () => piStyles });
const themed = renderWorktreeInline(conflict, 80, resolvedPi);
assert.ok(themed.includes("<success>Δ</success>"), "Follow Pi should style the Git title through the Git segment semantic token");
assert.ok(themed.includes("<warning>!</warning>"), "Follow Pi should style conflict status through warning");
assert.ok(themed.includes("<error> 2 conflicts</error>"), "Follow Pi should style conflict details through error");
assert.ok(themed.includes("<muted> · </muted>"), "Follow Pi should style separators through separator/dim semantics");

let activePiStyles = piStyles;
const widgetState = testState({ git: dirty });
const widgetConfig = defaultConfig();
widgetConfig.colorSource = "pi";
const widget = new WorktreeSummaryWidget(() => widgetState, () => widgetConfig, { getPiStyles: () => activePiStyles });
const firstTheme = widget.render(80).join("\n");
activePiStyles = resolvePiThemeStyles({ name: "worktree-pi-next", fg: (token, text) => `[next:${token}]${text}` });
widget.invalidate();
const nextTheme = widget.render(80).join("\n");
assert.ok(firstTheme.includes("<success>"), "widget should initially use the current Pi theme source");
assert.ok(nextTheme.includes("[next:success]"), "widget invalidation should lazily re-resolve runtime Pi theme styles");
assert.equal(nextTheme.includes("<success>"), false, "widget should not retain stale pre-baked theme ANSI");

function bottomFrame(mode: "border-left" | "border-right", width = 80): { raw: string; plain: string; state: GlanceState } {
	const config = defaultConfig();
	config.git.worktreeSummary = mode;
	config.context.progress = true;
	config.context.progressStyle = "border";
	config.context.progressWidth = "remaining";
	config.context.text = "percent";
	config.bottomDetails.showAutoCompact = false;
	onlySegments(config, ["context"]);
	const state = testState({ git: dirty, context: { tokens: 100_000, window: 200_000, percent: 50 } });
	const raw = renderInputSurfaceFrame({
		state,
		config,
		width,
		styles,
		body: { kind: "preview", lines: [""] },
	}).at(-1) ?? "";
	return { raw, plain: stripAnsi(raw), state };
}

const right = bottomFrame("border-right");
assert.equal(visibleWidth(right.raw), 80, "border-right summary should preserve exact frame width");
assert.ok(right.plain.endsWith(" 50% · Δ 6 files · +123 −99 ─╯"), "border-right should keep Git summary fixed at the far-right after context label");
assert.ok(right.plain.indexOf("╼") < right.plain.indexOf("50%"), "remaining context progress should occupy the space left of the fixed Git summary");
assert.ok(right.plain.indexOf("━") < right.plain.indexOf("Δ 6"), "remaining used progress should extend leftward before the right-side Git summary");

const left = bottomFrame("border-left");
assert.equal(visibleWidth(left.raw), 80, "border-left summary should preserve exact frame width");
assert.ok(left.plain.startsWith("╰─ Δ 6 files · +123 −99 "), "border-left should embed the same responsive summary at the left edge");
assert.ok(left.plain.includes("50% ─╯"), "border-left should remain composable with context progress details on the right");
const narrowLeft = bottomFrame("border-left", 16);
assert.ok(narrowLeft.plain.includes("Δ 6"), "narrow border-left should retain the minimal Git candidate");
assert.ok(narrowLeft.plain.includes("50%"), "border-left should not double-charge chrome width and prematurely hide a fitting context label");
for (const mode of ["border-left", "border-right"] as const) {
	for (const width of [12, 24, 40, 80]) {
		const frame = bottomFrame(mode, width);
		assert.equal(visibleWidth(frame.raw), width, `${mode} frame should preserve exact width ${width}`);
	}
}

console.log("✓ working tree responsive, detailed ratio, theme, and border composition checks passed");
