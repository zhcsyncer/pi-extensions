import { strict as assert } from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaultConfig } from "../config.js";
import { parseGitStatus } from "../git.js";
import { renderInputSurfaceFrame } from "../input-surface-frame.js";
import { resolveBuiltInGlanceStyles, resolveGlanceRenderStyles, resolvePiThemeStyles } from "../theme-adapter.js";
import { renderWorktreeInline, worktreeInlineCandidates } from "../worktree-summary.js";
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
const firstThemed = renderWorktreeInline(dirty, 80, resolveGlanceRenderStyles(piConfig, { getPiStyles: () => activePiStyles }));
activePiStyles = resolvePiThemeStyles({ name: "worktree-pi-next", fg: (token, text) => `[next:${token}]${text}` });
const nextThemed = renderWorktreeInline(dirty, 80, resolveGlanceRenderStyles(piConfig, { getPiStyles: () => activePiStyles }));
assert.ok(firstThemed.includes("<success>"), "inline summary should initially use the current Pi theme source");
assert.ok(nextThemed.includes("[next:success]"), "inline summary should lazily re-resolve runtime Pi theme styles");
assert.equal(nextThemed.includes("<success>"), false, "inline summary should not retain stale pre-baked theme ANSI");

function bottomFrame(width = 80): { raw: string; plain: string; state: GlanceState } {
	const config = defaultConfig();
	config.git.worktreeSummary = "border-right";
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

const right = bottomFrame();
assert.equal(visibleWidth(right.raw), 80, "border-right summary should preserve exact frame width");
assert.ok(right.plain.endsWith(" 50% · Δ 6 files · +123 −99 ─╯"), "border-right should keep Git summary fixed at the far-right after context label");
assert.ok(right.plain.indexOf("╼") < right.plain.indexOf("50%"), "remaining context progress should occupy the space left of the fixed Git summary");
assert.ok(right.plain.indexOf("━") < right.plain.indexOf("Δ 6"), "remaining used progress should extend leftward before the right-side Git summary");
for (const width of [12, 24, 40, 80]) {
	const frame = bottomFrame(width);
	assert.equal(visibleWidth(frame.raw), width, `border-right frame should preserve exact width ${width}`);
}

const statusConfig = defaultConfig();
statusConfig.editor.topMarginRows = 0;
statusConfig.git.worktreeSummary = "status";
const statusFrame = renderInputSurfaceFrame({
	state: testState({ git: dirty }),
	config: statusConfig,
	width: 80,
	styles,
	body: { kind: "preview", lines: [""] },
});
assert.ok(stripAnsi(statusFrame[0] ?? "").startsWith("╭"), "status mode should not add an extra row above the input box");
assert.equal(stripAnsi(statusFrame.at(-1) ?? "").includes("Δ 6"), false, "status mode should keep working-tree counts out of the bottom border");

console.log("✓ working tree responsive, theme, and border-right composition checks passed");
