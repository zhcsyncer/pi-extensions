import { strict as assert } from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaultConfig } from "../config.js";
import { measureInputSurfaceFrame, renderInputSurfaceFrame } from "../input-surface-frame.js";
import { renderInputSurface } from "../renderer.js";
import { renderSurfaceTopMargin, surfaceMetrics, SURFACE_AUTOCOMPLETE_INDENT, SURFACE_CONTENT_PADDING_X } from "../surface-layout.js";
import { resolveBuiltInGlanceStyles } from "../theme-adapter.js";
import { onlySegments, richInputSurfaceState as richState, stripAnsi } from "./surface-test-harness.js";
import type { GlanceConfig } from "../types.js";

function minRows(config: GlanceConfig): number {
	return Math.max(2, Math.min(4, config.editor.minContentRows));
}

function assertFrameGeometry(lines: readonly string[], config: GlanceConfig, width: number, bodyLineCount: number, label: string): void {
	const metrics = measureInputSurfaceFrame(width);
	const topMarginRows = renderSurfaceTopMargin(metrics.safeWidth, config.editor.topMarginRows).length;
	assert.equal(lines.length, topMarginRows + Math.max(minRows(config), bodyLineCount) + 2, `${label} should use top margin + top frame + padded body rows + bottom frame`);
	for (const [index, line] of lines.entries()) {
		assert.ok(visibleWidth(line) <= metrics.safeWidth, `${label} line ${index} should fit safeWidth ${metrics.safeWidth}: ${stripAnsi(line)}`);
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
	assert.ok(capturedBudget >= 0, "custom status callback should receive a concrete top-frame budget");
	assertFrameGeometry(frame, config, 48, 1, "editor-like frame");
	assert.ok(stripAnsi(frame[2] ?? "").includes("─── ↑ 7 more"), "top scroll indicator should be placed in the top-left frame slot");
	assert.ok(frame[3]?.includes(rawBody), "editor body rows should remain already-rendered text while being wrapped by the frame");
	assert.match(stripAnsi(frame[4] ?? ""), /^│ *│$/, "editor-like frame should pad body rows up to minContentRows");
	assert.ok(stripAnsi(frame.at(-1) ?? "").includes("─── ↓ 2 more"), "bottom scroll indicator should be placed in the bottom frame slot");
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

console.log("✓ input surface frame checks passed");
