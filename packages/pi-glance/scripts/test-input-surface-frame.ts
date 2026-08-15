import { strict as assert } from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaultConfig } from "../config.js";
import { measureInputSurfaceFrame, renderInputSurfaceFrame } from "../input-surface-frame.js";
import { renderInputSurface } from "../renderer.js";
import { renderSurfaceTopMargin, surfaceMetrics, SURFACE_AUTOCOMPLETE_INDENT, SURFACE_CONTENT_PADDING_X } from "../surface-layout.js";
import { resolveBuiltInGlanceStyles, resolvePiThemeStyles, type ResolvedGlanceStyles } from "../theme-adapter.js";
import { onlySegments, richInputSurfaceState as richState, stripAnsi } from "./surface-test-harness.js";
import type { GlanceConfig } from "../types.js";

function minRows(config: GlanceConfig): number {
	return Math.max(2, Math.min(4, config.editor.minContentRows));
}

function assertFrameGeometry(lines: readonly string[], config: GlanceConfig, width: number, bodyLineCount: number, label: string): void {
	const metrics = measureInputSurfaceFrame(width);
	const topMarginRows = renderSurfaceTopMargin(metrics.safeWidth, config.editor.topMarginRows).length;
	const expected = topMarginRows + Math.max(minRows(config), bodyLineCount) + 2;
	assert.equal(lines.length, expected, `${label} should use top margin + top frame + padded body rows + bottom frame`);
	for (const [index, line] of lines.entries()) {
		assert.ok(visibleWidth(line) <= metrics.safeWidth, `${label} line ${index} should fit safeWidth ${metrics.safeWidth}: ${stripAnsi(line)}`);
	}
}

function assertExactFrameWidth(lines: readonly string[], width: number, label: string): void {
	for (const [index, line] of lines.entries()) {
		assert.equal(visibleWidth(line), width, `${label} line ${index} should exactly fill width ${width}: ${stripAnsi(line)}`);
	}
}

for (const width of [Number.NaN, -4, 0, 1, 4, 20, 80]) {
	const measured = measureInputSurfaceFrame(width);
	const legacy = surfaceMetrics(width);
	assert.equal(measured.safeWidth, legacy.safeWidth, `measure safeWidth should match surfaceMetrics at width ${width}`);
	assert.equal(measured.innerWidth, legacy.innerWidth, `measure innerWidth should match surfaceMetrics at width ${width}`);
	assert.equal(
		measured.editorContentWidth,
		Math.max(1, measured.safeWidth - 2 - SURFACE_CONTENT_PADDING_X * 2),
		`measure editorContentWidth should expose current live editor render width at width ${width}`,
	);
	assert.equal(
		measured.autocompleteIndent,
		Math.min(SURFACE_AUTOCOMPLETE_INDENT, Math.max(0, measured.safeWidth - 1)),
		`measure autocompleteIndent should expose current live editor autocomplete indent at width ${width}`,
	);
}

for (const theme of ["light", "dark", "high-contrast-light"] as const) {
	for (const width of [32, 56, 120]) {
		for (const showPromptIndicator of [true, false]) {
			const config = defaultConfig();
			config.theme = { light: theme, dark: theme };
			config.editor.topMarginRows = width === 32 ? 0 : 1;
			config.editor.minContentRows = 2;
			onlySegments(config, ["context", "model"]);
			const state = richState();
			const styles = resolveBuiltInGlanceStyles(theme);
			const contentLines = ["short", "Ask pi to improve the input surface with a long prompt that must be clipped"];
			const next = renderInputSurfaceFrame({
				state,
				config,
				width,
				styles,
				body: { kind: "preview", lines: contentLines, showPromptIndicator },
				chrome: { showTitle: width !== 32 },
			});
			assert.deepEqual(
				next,
				renderInputSurface(state, config, width, { contentLines, focused: showPromptIndicator, showTitle: width !== 32, styles }),
				`${theme} preview-like frame output should match the legacy renderer assembly at width ${width} (${showPromptIndicator ? "prompt" : "no prompt"})`,
			);
			assertFrameGeometry(next, config, width, contentLines.length, `${theme} preview-like frame`);
		}
	}
}

{
	const config = defaultConfig();
	config.editor.topMarginRows = 0;
	config.editor.minContentRows = 3;
	onlySegments(config, ["model"]);
	const state = richState();
	const styles = resolveBuiltInGlanceStyles(config.theme.light);
	assert.deepEqual(
		renderInputSurfaceFrame({ state, config, width: 56, styles, body: { kind: "preview" } }),
		renderInputSurface(state, config, 56, { styles }),
		"preview body with omitted lines should match the legacy renderer default single blank content row",
	);
}

{
	const config = defaultConfig();
	config.editor.topMarginRows = 2;
	config.editor.minContentRows = 4;
	onlySegments(config, ["model"]);
	const state = richState();
	const styles = resolveBuiltInGlanceStyles(config.theme.light);
	let capturedBudget = -1;
	let capturedStyles: unknown;
	const rawBody = "already-rendered \x1b[35mRAW\x1b[0m body";
	const frame = renderInputSurfaceFrame({
		state,
		config,
		width: 48,
		styles,
		body: { kind: "editor", lines: [rawBody] },
		chrome: {
			focus: "focused",
			topScrollIndicator: "─── ↑ 7 more ",
			bottomScrollIndicator: "─── ↓ 2 more ",
		},
		status: {
			render: (budget, receivedStyles) => {
				capturedBudget = budget;
				capturedStyles = receivedStyles;
				return "cached-status";
			},
		},
	});

	assert.equal(capturedStyles, styles, "custom status callback should receive the shared ResolvedGlanceStyles instance");
	assert.equal(capturedBudget, 30, "top scroll indicator should reserve the interactive left slot before budgeting status");
	assertFrameGeometry(frame, config, 48, 1, "editor-like frame");
	const topBorderIndex = 2;
	assert.ok(stripAnsi(frame[topBorderIndex] ?? "").includes("─── ↑ 7 more"), "top scroll indicator should be placed in the top-left frame slot");
	assert.ok(frame[topBorderIndex + 1]?.includes(rawBody), "editor body rows should remain already-rendered text while being wrapped by the frame");
	assert.match(stripAnsi(frame[topBorderIndex + 2] ?? ""), /^│ *│$/, "editor-like frame should pad body rows up to minContentRows");
	assert.ok(stripAnsi(frame.at(-1) ?? "").includes("─── ↓ 2 more"), "bottom scroll indicator should be placed in the bottom frame slot");
}

{
	const config = defaultConfig();
	config.editor.topMarginRows = 0;
	config.editor.minContentRows = 2;
	onlySegments(config, ["git", "cost", "context", "model"]);
	const state = richState();
	const styles = resolveBuiltInGlanceStyles(config.theme.light);

	let capturedNormalBudget = -1;
	renderInputSurfaceFrame({
		state,
		config,
		width: 48,
		styles,
		body: { kind: "editor", lines: [""] },
		status: {
			render: (budget) => {
				capturedNormalBudget = budget;
				return "status";
			},
		},
	});
	assert.equal(capturedNormalBudget, 42, "normal editing should budget status before the workspace title using only frame chrome");

	const narrow = renderInputSurfaceFrame({ state, config, width: 48, styles, body: { kind: "editor", lines: [""] } });
	const narrowTop = stripAnsi(narrow[0] ?? "");
	assert.ok(narrowTop.includes("git main *"), "narrow normal frame should preserve the first configured status segment");
	assert.ok(narrowTop.includes("$ $0.042"), "narrow normal frame should preserve a middle status segment that the old title-first budget dropped");
	assert.ok(narrowTop.includes("ctx 23%"), "narrow normal frame should protect the rightmost status segment that fits the status-first budget");
	assert.equal(narrowTop.includes("ai Sonnet 4"), false, "narrow status should still evict segments from the configured right edge");
	assert.ok(narrowTop.includes("07_pi"), "workspace title should shorten while some left-side space remains");
	assert.equal(narrowTop.includes("07_pi-glance"), false, "workspace title should not retain its full width ahead of protected status");
	assertExactFrameWidth(narrow, 48, "narrow status-first frame");

	const displaced = renderInputSurfaceFrame({ state, config, width: 52, styles, body: { kind: "editor", lines: [""] } });
	const displacedTop = stripAnsi(displaced[0] ?? "");
	assert.ok(displacedTop.includes("ai Sonnet 4"), "a later status segment should use space released by hiding the workspace title");
	assert.equal(displacedTop.includes("07_pi"), false, "workspace title should hide when protected status leaves no usable title slot");
	assertExactFrameWidth(displaced, 52, "title-displaced frame");

	const wide = renderInputSurfaceFrame({ state, config, width: 120, styles, body: { kind: "editor", lines: [""] } });
	const wideTop = stripAnsi(wide[0] ?? "");
	assert.ok(wideTop.includes("07_pi-glance"), "wide normal frame should keep the full workspace title");
	for (const expected of ["git main *", "$ $0.042", "ctx 23%", "ai anthropic/Sonnet 4 high"]) {
		assert.ok(wideTop.includes(expected), `wide normal frame should keep status ${expected}`);
	}
	assertExactFrameWidth(wide, 120, "wide coexistence frame");

	const bash = renderInputSurfaceFrame({
		state,
		config,
		width: 40,
		styles,
		body: { kind: "editor", lines: [""] },
		chrome: { modeLabel: "Bash" },
	});
	const bashTop = stripAnsi(bash[0] ?? "");
	assert.ok(bashTop.includes("Bash"), "Bash mode label should keep the interactive left slot on narrow frames");
	assert.equal(bashTop.includes("07_pi"), false, "Bash mode label should replace the workspace title");
	assert.ok(bashTop.includes("git main *") && bashTop.includes("$ $0.042"), "Bash mode should leave its remaining width to earlier status segments");
	assert.equal(bashTop.includes("ctx 23%"), false, "Bash mode should take width before later status segments");
	assertExactFrameWidth(bash, 40, "narrow Bash frame");

	const scrolled = renderInputSurfaceFrame({
		state,
		config,
		width: 40,
		styles,
		body: { kind: "editor", lines: [""] },
		chrome: { topScrollIndicator: "─── ↑ 7 more " },
	});
	const scrolledTop = stripAnsi(scrolled[0] ?? "");
	assert.ok(scrolledTop.includes("─── ↑ 7 more"), "top scroll indicator should keep the interactive left slot on narrow frames");
	assert.equal(scrolledTop.includes("07_pi"), false, "top scroll indicator should replace the workspace title");
	assert.ok(scrolledTop.includes("git main *") && scrolledTop.includes("$ $0.042"), "top scroll indicator should leave remaining width to earlier status segments");
	assert.equal(scrolledTop.includes("ctx 23%"), false, "top scroll indicator should take width before later status segments");
	assertExactFrameWidth(scrolled, 40, "narrow scrolled frame");

	const reorderedConfig = defaultConfig();
	reorderedConfig.editor.topMarginRows = 0;
	reorderedConfig.editor.minContentRows = 2;
	reorderedConfig.segments = (["model", "context", "cost", "git"] as const).map((id) => ({ id, enabled: true }));
	const reordered = renderInputSurfaceFrame({ state, config: reorderedConfig, width: 40, styles, body: { kind: "editor", lines: [""] } });
	const reorderedTop = stripAnsi(reordered[0] ?? "");
	const modelIndex = reorderedTop.indexOf("ai Sonnet 4");
	const contextIndex = reorderedTop.indexOf("ctx 23%");
	const costIndex = reorderedTop.indexOf("$ $0.042");
	assert.ok(modelIndex >= 0 && modelIndex < contextIndex && contextIndex < costIndex, "custom /glance order should define left-to-right status priority");
	assert.equal(reorderedTop.includes("git main"), false, "custom /glance order should evict the configured rightmost segment first");
	assertExactFrameWidth(reordered, 40, "custom-order frame");
}

{
	const config = defaultConfig();
	config.editor.topMarginRows = 0;
	config.editor.minContentRows = 2;
	onlySegments(config, ["model"]);
	const state = richState();
	const styles = resolveBuiltInGlanceStyles(config.theme.light);
	const statusWithControls = "\x1b[31mHOT\tNOW\x1b[0m";
	const focused = renderInputSurfaceFrame({
		state,
		config,
		width: 64,
		styles,
		body: { kind: "editor", lines: [""] },
		chrome: { focus: "focused" },
		status: { render: () => statusWithControls },
	});
	const unfocused = renderInputSurfaceFrame({
		state,
		config,
		width: 64,
		styles,
		body: { kind: "editor", lines: [""] },
		chrome: { focus: "unfocused" },
		status: { render: () => statusWithControls },
	});

	assert.ok(focused[0]?.includes(statusWithControls), "focused editor chrome should keep caller-rendered status bytes");
	assert.ok(unfocused[0]?.includes(styles.dim("HOT NOW")), "unfocused editor chrome should dim a control-stripped status copy");
	assert.ok(unfocused[0]?.startsWith(styles.dim("╭")), "unfocused editor chrome should dim border styling");
	assert.ok(stripAnsi(unfocused.at(-1) ?? "").startsWith("╰"), "unfocused editor bottom frame should keep the same visible border glyphs");
}

{
	const styles = resolveBuiltInGlanceStyles("dark");
	function progressBottom(
		progressStyle: GlanceConfig["context"]["progressStyle"],
		progressWidth: GlanceConfig["context"]["progressWidth"],
		percent: number | null = 23.4,
		bottomScrollIndicator?: string,
		activeStyles: ResolvedGlanceStyles = styles,
	): string {
		const config = defaultConfig();
		config.editor.topMarginRows = 0;
		config.context.progress = true;
		config.context.text = "percent";
		config.context.progressStyle = progressStyle;
		config.context.progressWidth = progressWidth;
		config.bottomDetails.showAutoCompact = false;
		onlySegments(config, ["context"]);
		const base = richState();
		const state = { ...base, context: { ...base.context, tokens: percent === null ? null : base.context.tokens, percent } };
		return renderInputSurfaceFrame({
			state,
			config,
			width: 80,
			styles: activeStyles,
			body: { kind: "preview", lines: [""] },
			chrome: { bottomScrollIndicator },
		}).at(-1) ?? "";
	}

	const trackThird = stripAnsi(progressBottom("track", "third"));
	const trackRemaining = stripAnsi(progressBottom("track", "remaining"));
	const borderThird = stripAnsi(progressBottom("border", "third"));
	const borderRemaining = stripAnsi(progressBottom("border", "remaining"));
	assert.ok(trackThird.includes("╶") && trackThird.includes("╴ 23%"), "track/third should preserve the standalone track renderer");
	assert.ok(trackRemaining.includes("╶") && trackRemaining.indexOf("╶") < trackThird.indexOf("╶"), "track/remaining should expand into earlier bottom-border space");
	assert.equal(borderThird.includes("╶"), false, "border/third should not render a standalone track");
	assert.ok(borderThird.includes("╼") && borderThird.includes("━"), "border/third should render a light-to-heavy border transition");
	assert.ok([...borderRemaining].filter((char) => char === "━").length > [...borderThird].filter((char) => char === "━").length, "border/remaining should use more heavy progress cells than border/third");
	for (const [label, line] of Object.entries({ trackThird, trackRemaining, borderThird, borderRemaining })) {
		assert.equal(visibleWidth(line), 80, `${label} bottom frame should preserve exact surface width`);
	}

	const normal = progressBottom("border", "third", 23.4);
	const warning = progressBottom("border", "third", 70);
	const error = progressBottom("border", "third", 85);
	assert.ok(normal.includes(styles.segments.context.fg(`╼${"━".repeat(4)}`)), "border progress below 70 percent should use context color");
	assert.ok(warning.includes(styles.warn(`╼${"━".repeat(15)}`)), "border progress at 70 percent should use warning color");
	assert.ok(error.includes(styles.error(`╼${"━".repeat(19)}`)), "border progress at 85 percent should use error color");
	assert.ok(normal.includes(styles.border("─")), "Glance border progress empty track should use the selected palette border");
	const unknown = progressBottom("border", "third", null);
	assert.ok(unknown.includes(styles.dim("─".repeat(25))), "unknown border progress should use a dim light track");
	assert.equal(stripAnsi(unknown).includes("━"), false, "unknown border progress should not render heavy used cells");

	const withScroll = progressBottom("border", "remaining", 70, "─── ↓ 2 more ");
	assert.ok(stripAnsi(withScroll).includes("─── ↓ 2 more "), "remaining border progress should preserve the bottom scroll indicator");
	assert.ok(withScroll.includes(styles.warn(`╼${"━".repeat(40)}`)), "remaining border progress should retain risk styling after reserving scroll-indicator space");
	assert.equal(visibleWidth(withScroll), 80, "remaining border progress with scroll indicator should preserve exact width");

	const piCodes: Record<string, number> = {
		accent: 31,
		warning: 32,
		error: 33,
		border: 34,
		dim: 35,
		muted: 36,
		text: 37,
	};
	const piStyles = resolvePiThemeStyles({
		name: "progress-pi",
		fg: (token, text) => `\x1b[${piCodes[token] ?? 39}m${text}\x1b[0m`,
	});
	const piNormal = progressBottom("border", "third", 23.4, undefined, piStyles);
	const piWarning = progressBottom("border", "third", 70, undefined, piStyles);
	const piError = progressBottom("border", "third", 85, undefined, piStyles);
	assert.ok(piNormal.includes("\x1b[31m╼━━━━\x1b[0m"), "Follow Pi normal context progress should use the Pi accent token");
	assert.ok(piNormal.includes("\x1b[34m─\x1b[0m"), "Follow Pi empty progress track should use the Pi border token");
	assert.ok(piWarning.includes(`\x1b[32m╼${"━".repeat(15)}\x1b[0m`), "Follow Pi warning context progress should use the Pi warning token");
	assert.ok(piError.includes(`\x1b[33m╼${"━".repeat(19)}\x1b[0m`), "Follow Pi error context progress should use the Pi error token");
}

console.log("✓ input surface frame checks passed");
