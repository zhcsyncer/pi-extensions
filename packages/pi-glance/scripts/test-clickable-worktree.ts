import { strict as assert } from "node:assert";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import { sliceByColumn, visibleWidth, type AutocompleteProvider, type EditorTheme, type TUI, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { defaultConfig } from "../config.js";
import { GlanceEditor } from "../editor.js";
import { renderInputSurfaceFrameWithWorktree } from "../input-surface-frame.js";
import { renderGlanceLineWithWorktree } from "../status-line.js";
import { resolveBuiltInGlanceStyles } from "../theme-adapter.js";
import { renderWorktreeInline } from "../worktree-summary.js";
import { dirtyInputSurfaceState, onlySegments, stripAnsi } from "./surface-test-harness.js";

const styles = resolveBuiltInGlanceStyles("dark");
function setup() {
	const config = defaultConfig();
	onlySegments(config, ["git"]);
	const state = dirtyInputSurfaceState();
	state.git.branch = "分支-Δ99";
	return { config, state };
}

// Test-only lookup of the visible affordance; production regions come from typed layout metadata.
function link(lines: string[]) {
	for (let row = 0; row < lines.length; row++) {
		const plain = stripAnsi(lines[row]!);
		const marker = plain.lastIndexOf(" ›");
		if (marker >= 0) return { row, start: visibleWidth(plain.slice(0, plain.lastIndexOf("Δ", marker))), end: visibleWidth(plain.slice(0, marker + 2)) };
	}
	return undefined;
}

for (const icons of ["plain", "nerd"] as const) {
	const { state, config } = setup();
	config.icons = icons;
	for (const width of [160, 80, 40, 10]) {
		const rendered = renderGlanceLineWithWorktree(state, config, width);
		const plain = stripAnsi(rendered.text);
		const marker = icons === "plain" ? "*" : "●";
		if (width >= 64) {
			assert.ok(rendered.worktreeRange);
			assert.equal(stripAnsi(sliceByColumn(rendered.text, rendered.worktreeRange.start, rendered.worktreeRange.end - rendered.worktreeRange.start)), "Δ2 +123 −99", "range must exclude branch text, even if it contains a lookalike Δ");
			assert.equal(plain.includes(marker), false);
		} else {
			assert.equal(rendered.worktreeRange, undefined);
			assert.ok(plain.includes(marker), "minimal/clipped summary must restore the dirty marker");
		}
		assert.ok(visibleWidth(rendered.text) <= width);
	}
	state.git.branch = "long分支".repeat(40);
	const clipped = renderGlanceLineWithWorktree(state, config, 80);
	assert.equal(clipped.worktreeRange, undefined);
	assert.ok(stripAnsi(clipped.text).endsWith(icons === "plain" ? "*" : "●"), "reserve marker space when shortening a long branch");
	config.git.showDirty = false;
	assert.equal(stripAnsi(renderGlanceLineWithWorktree(state, config, 80).text).includes(icons === "plain" ? "*" : "●"), false);
	state.git.status = "conflict";
	assert.ok(stripAnsi(renderGlanceLineWithWorktree(state, config, 80).text).endsWith(icons === "plain" ? "!" : "⚠"), "conflict remains independently visible");
}
{
	const { state, config } = setup();
	for (const status of ["clean", "unknown"] as const) {
		state.git.status = status;
		const result = renderGlanceLineWithWorktree(state, config, 80);
		assert.equal(result.worktreeRange, undefined);
		assert.equal(result.text.includes("*"), false);
	}
	state.git.status = "dirty";
	state.git.worktree.files = 0;
	assert.equal(renderGlanceLineWithWorktree(state, config, 80).worktreeRange, undefined);
	assert.ok(renderGlanceLineWithWorktree(state, config, 80).text.includes("*"));
	state.git.worktree.files = 2;
	assert.equal(renderWorktreeInline(state.git, 2, styles), "", "a half Δ count must never be emitted");
	config.segments = [{ id: "model", enabled: true }, { id: "git", enabled: true }];
	assert.equal(renderGlanceLineWithWorktree(state, config, 15).worktreeRange, undefined, "evicted Git segments have no clickable range");
	assert.equal(renderGlanceLineWithWorktree(state, config, 15).text.includes("*"), false, "do not force Git into other segments' space");
}

for (const position of ["status", "border-right"] as const) {
	for (const margin of [0, 1, 2] as const) {
		for (const minRows of [2, 4]) {
			for (const focus of ["focused", "unfocused"] as const) {
				const { state, config } = setup();
				config.git.worktreeSummary = position;
				config.editor.topMarginRows = margin;
				config.editor.minContentRows = minRows;
				config.context.progress = true;
				config.context.progressWidth = "remaining";
				for (const width of [8, 16, 35, 80, 140]) {
					const result = renderInputSurfaceFrameWithWorktree({ state, config, styles, width, body: { kind: "editor", lines: ["draft"] }, chrome: { focus, bottomScrollIndicator: "─── ↓ 2 more " }, interactiveWorktree: true });
					const region = result.worktreeRegion;
					if (region) {
						assert.equal(region.row, position === "status" ? margin : margin + minRows + 1);
						assert.match(stripAnsi(sliceByColumn(result.lines[region.row]!, region.start, region.end - region.start)), /^Δ ?2(?: |$)/);
						assert.ok(stripAnsi(sliceByColumn(result.lines[region.row]!, region.start, region.end - region.start)).endsWith(" ›"), "hit region must include the trailing affordance");
						assert.ok(result.lines[region.row]!.includes(styles.strongTitle(" ›")), "chevron must retain strong title styling even when unfocused");
						assert.deepEqual(link(result.lines), region, "visible affordance and typed range must describe the same complete summary");
						assert.equal(stripAnsi(result.lines[margin]!).includes("*"), false);
					} else {
						assert.equal(link(result.lines), undefined);
						if (width >= 16) assert.ok(stripAnsi(result.lines[margin]!).includes("*"), "absent final summary must retain dirty state");
					}
					assert.ok(result.lines.every((line) => visibleWidth(line) <= width));
					assert.ok(result.lines.every((line) => !/\x1b\[(?:[0-9]+;)*4(?:;[0-9]+)*m/.test(line)), "changes must not introduce underline SGR");
				}
				for (const kind of ["preview", "editor"] as const) {
					const rendered = renderInputSurfaceFrameWithWorktree({ state, config, styles, width: 140, body: { kind, lines: [""] }, interactiveWorktree: kind === "preview" });
					assert.equal(rendered.worktreeRegion, undefined, "preview and regular rendering must not pretend to be links");
					assert.equal(link(rendered.lines), undefined);
				}
			}
		}
	}
}

// Rendering budgets and colors are observable independently of mouse dispatch.
for (const position of ["status", "border-right"] as const) {
	const { state, config } = setup();
	config.git.worktreeSummary = position;
	for (let width = 4; width <= 150; width++) {
		const frame = renderInputSurfaceFrameWithWorktree({ state, config, styles, width, body: { kind: "editor", lines: [""] }, interactiveWorktree: true });
		assert.ok(frame.lines.every((line) => visibleWidth(line) <= width), `summary and marker must fit together at ${width} columns`);
		assert.equal(frame.lines.some((line) => stripAnsi(line).includes(" ›")), Boolean(frame.worktreeRegion), "no detached chevron or unmarked hit region");
		if (frame.worktreeRegion) {
			const { row, start, end } = frame.worktreeRegion;
			assert.match(stripAnsi(sliceByColumn(frame.lines[row]!, start, end - start)), /^Δ ?2.* ›$/);
		}
	}
	const color = (code: number) => (text: string) => `\x1b[${code}m${text}\x1b[39m`;
	if (position === "status") config.segments = [{ id: "git", enabled: true }, { id: "cost", enabled: true }];
	const colored = { ...styles, strongTitle: (text: string) => `\x1b[1m${color(95)(text)}\x1b[22m`, dim: color(90), border: color(36), success: color(32), error: color(31), segments: { ...styles.segments, git: { ...styles.segments.git, fg: color(34) }, cost: { ...styles.segments.cost, fg: color(35) } } };
	function colorAt(line: string, needle: string): number | undefined {
		const plain = stripAnsi(line);
		const index = plain.indexOf(needle);
		assert.ok(index >= 0, `expected visible ${needle}`);
		const target = visibleWidth(plain.slice(0, index));
		let column = 0;
		let foreground: number | undefined;
		for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
			if (part.startsWith("\x1b[")) {
				const code = Number(part.slice(2, -1));
				if (code === 0 || code === 39) foreground = undefined;
				else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97)) foreground = code;
			} else {
				for (const char of part) {
					column += visibleWidth(char);
					if (column > target) return foreground;
				}
			}
		}
		return foreground;
	}
	for (const status of ["dirty", "conflict"] as const) {
		state.git.status = status;
		state.git.worktree.conflicts = status === "conflict" ? ["conflict.ts"] : [];
		for (const focus of ["focused", "unfocused"] as const) {
			const frame = renderInputSurfaceFrameWithWorktree({ state, config, styles: colored, width: 150, body: { kind: "editor", lines: [""] }, chrome: { focus }, interactiveWorktree: true });
			assert.ok(frame.worktreeRegion);
			const row = frame.lines[frame.worktreeRegion.row]!;
			assert.equal(colorAt(row, "›"), 95, "affordance must retain its accent color in either focus state");
			assert.ok(row.includes(`\x1b[1m\x1b[95m ›\x1b[39m\x1b[22m`), "only the arrow gets bold accent styling with an explicit bold reset");
			assert.equal(colorAt(row, "+123"), focus === "unfocused" ? 90 : position === "status" ? 34 : 32, "addition color must not be replaced by the affordance color");
			assert.equal(colorAt(row, "−99"), focus === "unfocused" ? 90 : position === "status" ? 34 : 31, "deletion color must not be replaced by the affordance color");
			assert.equal(colorAt(row, position === "status" ? "╮" : "╯"), focus === "unfocused" ? 90 : 36, "accent marker must not leak into the frame");
			if (position === "status") assert.equal(colorAt(row, "$0.042"), focus === "unfocused" ? 90 : 35, "the next segment must keep its own color after the marker");
		}
	}
	for (const status of ["clean", "unknown"] as const) {
		state.git.status = status;
		const frame = renderInputSurfaceFrameWithWorktree({ state, config, styles, width: 150, body: { kind: "editor", lines: [""] }, interactiveWorktree: true });
		assert.equal(frame.worktreeRegion, undefined);
		assert.equal(frame.lines.some((line) => stripAnsi(line).includes(" ›")), false);
	}
}
{
	const { state, config } = setup();
	config.git.worktreeSummary = "border-right";
	const render = (width: number, interactiveWorktree: boolean) => renderInputSurfaceFrameWithWorktree({ state, config, styles, width, body: { kind: "editor", lines: [""] }, interactiveWorktree });
	assert.ok(stripAnsi(render(8, false).lines.at(-1)!).includes("Δ 2"), "regular mode must not reserve an invisible marker");
	assert.equal(render(8, true).worktreeRegion, undefined, "minimum summary without room for its marker must disappear together");
	assert.ok(render(8, true).lines.some((line) => stripAnsi(line).includes("*")), "marker reservation must preserve the dirty fallback");
	assert.ok(stripAnsi(render(10, true).lines.at(-1)!).includes("Δ 2 ›"), "minimum summary plus marker should fit at the exact boundary");
}

{
	const { state, config } = setup();
	state.git.branch = "x".repeat(50);
	state.git.ahead = 0;
	state.git.behind = 0;
	const width = visibleWidth(renderGlanceLineWithWorktree(state, config, 200).text);
	assert.ok(renderGlanceLineWithWorktree(state, config, width).worktreeRange, "summary alone fits this exact status budget");
	const clickable = renderGlanceLineWithWorktree(state, config, width, 1, { styles }, false, " ›");
	assert.equal(clickable.worktreeRange, undefined, "a summary that cannot fit its affordance must be omitted as a whole");
	assert.equal(stripAnsi(clickable.text).includes("›"), false);
	assert.ok(stripAnsi(clickable.text).includes("*"));
}

const theme: EditorTheme = { borderColor: (s) => s, selectList: { selectedPrefix: (s) => s, selectedText: (s) => s, description: (s) => s, scrollInfo: (s) => s, noMatch: (s) => s } };
const keys = { matches: () => false } as unknown as KeybindingsManager;
function mouse(lines: string[], x: number, y: number, overrides: Partial<TuiMouseEvent> = {}): TuiMouseEvent {
	return { x, y, screenX: x + 5, screenY: y + 10, width: 100, height: lines.length, type: "click", button: "left", ctrl: false, alt: false, shift: false, ...overrides };
}
for (const position of ["status", "border-right"] as const) {
	const { state, config } = setup();
	config.git.worktreeSummary = position;
	config.editor.minContentRows = 4;
	config.editor.topMarginRows = 2;
	let reviews = 0;
	const tui = { mode: "fullscreen", terminal: { rows: 40 }, requestRender() {} };
	const editor = new GlanceEditor(tui as unknown as TUI, theme, keys, () => state, () => config, undefined, { onWorktreeReview: () => { reviews++; } });
	editor.focused = true;
	editor.setText("abcdef");
	let lines = editor.render(100);
	let region = link(lines)!;
	assert.ok(region);
	for (const type of ["press", "drag", "release"] as const) assert.equal(editor.handleMouse(mouse(lines, region.start, region.row, { type })), undefined, "summary gestures must remain available for terminal text selection");
	editor.handleMouse(mouse(lines, region.start, region.row, { button: "right" }));
	editor.handleMouse(mouse(lines, region.start - 1, region.row));
	editor.handleMouse(mouse(lines, region.end, region.row));
	assert.equal(reviews, 0);
	assert.equal(editor.handleMouse(mouse(lines, region.start + (position === "status" ? 1 : 2), region.row))?.handled, true);
	assert.equal(reviews, 1, "clicking the summary count must open review exactly once");
	assert.equal(editor.handleMouse(mouse(lines, region.end - 1, region.row))?.handled, true);
	assert.equal(reviews, 2, "clicking the chevron must also open review exactly once");
	reviews = 1; // Keep the remaining stale-region assertions independent of the extra gesture.
	editor.invalidate();
	editor.handleMouse(mouse(lines, region.start, region.row));
	assert.equal(reviews, 1, "invalidate must revoke old regions");
	lines = editor.render(100);
	region = link(lines)!;
	editor.handleMouse(mouse(lines, region.start, region.row, { width: 99 }));
	assert.equal(reviews, 1, "resize before render must reject old coordinates");
	tui.mode = "regular";
	assert.equal(link(editor.render(100)), undefined);
	editor.handleMouse(mouse(lines, region.start, region.row));
	assert.equal(reviews, 1);
	tui.mode = "fullscreen";
	config.git.worktreeSummary = position === "status" ? "border-right" : "status";
	lines = editor.render(100);
	editor.handleMouse(mouse(lines, region.start, region.row));
	assert.equal(reviews, 1, "moving the summary must revoke its old position");
	config.segments.find((segment) => segment.id === "git")!.enabled = false;
	assert.equal(link(editor.render(100)), undefined);
	config.segments.find((segment) => segment.id === "git")!.enabled = true;
	state.git.status = "clean";
	assert.equal(link(editor.render(100)), undefined, "clean hints must not be links");
	state.git.status = "dirty";
	// Actual inherited cursor movement, including native padding and outer frame offset.
	editor.setPaddingX(1);
	lines = editor.render(100);
	assert.equal(editor.handleMouse(mouse(lines, 2 + 1 + 2, config.editor.topMarginRows + 1))?.handled, true);
	assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
	lines = editor.render(100);
	assert.equal(editor.handleMouse(mouse(lines, 5, config.editor.topMarginRows + 2)), undefined, "extra min-body rows aren't native input or completions");
	assert.deepEqual(editor.getCursor(), { line: 0, col: 2 });
	// Same width, different height and margin must recompute bottom coordinates.
	config.git.worktreeSummary = "border-right";
	editor.setText("a\nb\nc\nd\ne\nf");
	config.editor.topMarginRows = 0;
	lines = editor.render(100);
	region = link(lines)!;
	assert.equal(region.row, lines.length - 1);
	editor.handleMouse(mouse(lines, region.start, region.row));
	assert.equal(reviews, 2);
	// Click real autocomplete rows after the extra padded body; retain the base editor's completion behavior.
	const provider: AutocompleteProvider = {
		getSuggestions: async () => ({ prefix: "src", items: [{ value: "src/a.ts", label: "src/a.ts" }, { value: "src/b.ts", label: "src/b.ts" }] }),
		applyCompletion: (_lines, _line, _col, item) => ({ lines: [item.value], cursorLine: 0, cursorCol: item.value.length }),
		shouldTriggerFileCompletion: () => true,
	};
	editor.setAutocompleteProvider(provider);
	editor.setText("src");
	editor.handleInput("\t");
	await Promise.resolve(); await Promise.resolve();
	lines = editor.render(100);
	const completionRow = lines.findIndex((line) => stripAnsi(line).includes("src/b.ts"));
	assert.ok(completionRow > 0);
	for (const [outward, inward, selected] of [[-1, 1, "src/b.ts"], [1, -1, "src/a.ts"]] as const) {
		const boundary = editor.handleMouse(mouse(lines, 5, completionRow, { type: "wheel", wheelDelta: outward }));
		assert.equal(boundary?.handled, true);
		assert.equal(boundary?.render, false, "wheel at the list boundary must remain a handled no-op");
		const moved = editor.handleMouse(mouse(lines, 5, completionRow, { type: "wheel", wheelDelta: inward }));
		assert.equal(moved?.handled, true, "reverse wheel without an intervening render must still reach autocomplete");
		assert.equal(moved?.render, true);
		assert.equal(editor.handleMouse(mouse(lines, 5, completionRow, { type: "wheel", wheelDelta: inward })), undefined, "a layout-changing operation must still revoke the old mouse frame until render");
		lines = editor.render(100);
		assert.ok(lines.some((line) => stripAnsi(line).includes(`→ ${selected}`)), "real SelectList selection must change");
	}
	assert.equal(editor.handleMouse(mouse(lines, 5, completionRow, { type: "press" }))?.handled, true);
	lines = editor.render(100); // Pi renders handled press by default, even on the already selected row.
	assert.equal(editor.handleMouse(mouse(lines, 5, completionRow, { type: "release" })), undefined);
	assert.equal(editor.handleMouse(mouse(lines, 5, completionRow))?.handled, true);
	assert.equal(editor.getText(), "src/b.ts", "press/release/click must preserve native completion with translated coordinates");
}
{
	const { state, config } = setup();
	config.git.worktreeSummary = "border-right";
	config.editor.topMarginRows = 1;
	const editor = new GlanceEditor({ mode: "fullscreen", terminal: { rows: 10 }, requestRender() {} } as unknown as TUI, theme, keys, () => state, () => config, undefined, { onWorktreeReview() {} });
	editor.focused = true;
	editor.setText("short");
	const short = editor.render(20);
	assert.ok(link(short));
	assert.equal(stripAnsi(short[1]!).includes("*"), false);
	editor.setText(Array.from({ length: 12 }, (_, i) => `line${i}`).join("\n"));
	for (let i = 0; i < 20; i++) editor.handleInput("\x1b[A");
	const scrolled = editor.render(20);
	assert.ok(stripAnsi(scrolled.at(-1)!).includes("more"));
	assert.equal(link(scrolled), undefined, "a scroll indicator may consume the bottom summary budget at the same width");
	assert.ok(stripAnsi(scrolled[1]!).includes("*"), "same-width scroll changes must restore the dirty marker, not reuse cached status");
	const visibleRow = scrolled.findIndex((line) => /line\d+/.test(stripAnsi(line)));
	const logicalLine = Number(stripAnsi(scrolled[visibleRow]!).match(/line(\d+)/)![1]);
	for (const type of ["press", "drag", "release"] as const) assert.equal(editor.handleMouse(mouse(scrolled, 3, visibleRow, { width: 20, type })), undefined, "body selection gestures must pass through to Pi's screen selection");
	editor.handleMouse(mouse(scrolled, 3, visibleRow, { width: 20 }));
	assert.deepEqual(editor.getCursor(), { line: logicalLine, col: 1 }, "scrolled body clicks must use the native visible-line map");
}
console.log("✓ clickable worktree visibility, dirty fallback, frame ranges and real editor mouse behavior passed");
