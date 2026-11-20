import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";
import {
	initTheme, Theme, ToolExecutionComponent, type ToolDefinition,
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import {
	TuiMainScreen, TuiAltScreen, Editor, stripTerminalSequences, visibleWidth, type Component,
} from "@earendil-works/pi-tui";
import { PreviewText } from "../src/preview-text.ts";
import { ClaudeToolResultComponent } from "../src/tool-call-style.ts";
import { DEFAULT_TOOL_DISPLAY_CONFIG, type ToolDisplayConfig } from "../src/types.ts";
import { createDisplaySession } from "./helpers/display-session.ts";
import { AggregateTerminal } from "./helpers/aggregate-terminal.ts";
import { openDetailViewer } from "../src/detail-viewer.ts";

const INPUT_UNITS = 1_000_000;
const INPUT_LINES = 20_000;
const INPUT_BLOCKS = 1000;
const BODY = "D2BODY_";
const plain = (lines: string[]) => lines.map(stripTerminalSequences).join("\n");
const omission = /omitt|truncat|limit|hidden|more lines|省略|截断|超限/i;
type PreviewOptions = ConstructorParameters<typeof PreviewText>[0];
type Harness = Awaited<ReturnType<typeof createDisplaySession>>;
type ResultRenderer = NonNullable<ToolDefinition["renderResult"]>;
type ToolRenderContext = Parameters<ResultRenderer>[3];
type HostResult = Parameters<ResultRenderer>[0] & { isError: boolean };

function workCounter() {
	const counts = { body: 0, bodyUnits: 0, prefix: 0, probeOrOther: 0 };
	return {
		counts,
		observe(text: string) {
			if (text.includes(BODY)) { counts.body++; counts.bodyUnits += text.length; }
			else if (/^[\s│└⎿]+$/u.test(text) && /[│└⎿]/u.test(text)) counts.prefix++;
			else counts.probeOrOther++;
		},
		reset() { counts.body = counts.bodyUnits = counts.prefix = counts.probeOrOther = 0; },
	};
}
function compatibleTheme() {
	const work = workCounter();
	let color = 31;
	const theme = {
		appearance: "dark" as const,
		fg(_token: string, text: string) {
			work.observe(text);
			// Empty-string probes cannot detect this legitimate fg-only theme's palette.
			return text ? `\x1b[${color}m${text}\x1b[39m` : "";
		},
	};
	return { theme, work, changeColor() { color = 32; } };
}
function linesFor(id = 0, count = 32) {
	return Array.from({ length: count }, (_, row) => `${BODY}${id}_${row} \x1b[36m中文\x1b[0m ${"word ".repeat(22)}`);
}
function preview(lines: string[], theme: PreviewOptions["theme"], extra: Partial<PreviewOptions> = {}) {
	return new PreviewText({ lines, theme, maxRows: 8, expanded: false, ...extra });
}
function staticChild(lines: string[]): Component {
	return { render: () => lines, invalidate() {} };
}
function config(): ToolDisplayConfig {
	return {
		...structuredClone(DEFAULT_TOOL_DISPLAY_CONFIG), resultMode: "preview", previewRows: 8,
		readOutputMode: "preview", searchOutputMode: "preview", mcpOutputMode: "preview", bashOutputMode: "preview",
	};
}
function host(h: Harness, ui: TuiMainScreen | TuiAltScreen, result: HostResult, id = "d2-call", display = true) {
	const component = new ToolExecutionComponent("bash", id, { command: "printf fixture" }, { outputPad: 0 },
		display ? h.displayTool("bash") : h.session.getToolDefinition("bash"), ui, h.cwd);
	component.setArgsComplete();
	component.markExecutionStarted();
	component.updateResult(result, false);
	return component;
}
function textResult(text: string) {
	return { content: [{ type: "text" as const, text }], details: {}, isError: false };
}

// Fixed load from the frozen contract. Count work, not platform-dependent milliseconds.
for (const count of [100, 300]) {
	for (const layer of ["preview", "double", "native"] as const) {
		test(`T1 warm work: ${count} completed records, ${layer}, 3 warm + 30 redraws`, async (t) => {
			const observed = compatibleTheme();
			const work = observed.work;
			let harness: Harness | undefined;
			let ui: TuiMainScreen | undefined;
			if (layer === "native") {
				initTheme("dark", false);
				const original = Theme.prototype.fg;
				t.mock.method(Theme.prototype, "fg", function (token, text) {
					work.observe(text);
					return original.call(this, token, text);
				});
				harness = await createDisplaySession(config());
				ui = new TuiMainScreen(new AggregateTerminal());
			}
			try {
				const make = (id: number, minimal = false): Component => {
					const lines = minimal ? [`${BODY}control`] : linesFor(id);
					if (layer === "native") return host(harness!, ui!, textResult(lines.join("\n")), `d2-${id}`);
					const inner = preview(lines, observed.theme);
					return layer === "preview" ? inner : new ClaudeToolResultComponent(inner, { theme: observed.theme, connectRows: true });
				};
				// A one-row control bounds constant theme probes, including probes that
				// happen to use connector strings. Body-sized prefix work must not scale.
				const controls = Array.from({ length: count }, (_, i) => make(i, true));
				for (let pass = 0; pass < 3; pass++) for (const item of controls) item.render(100);
				work.reset();
				for (let pass = 0; pass < 30; pass++) for (const item of controls) item.render(100);
				const constantPrefixAllowance = work.counts.prefix;
				const records = Array.from({ length: count }, (_, i) => make(i));
				let expected: string[][] = [];
				for (let pass = 0; pass < 3; pass++) expected = records.map((item) => item.render(100).slice());
				assert.ok(expected.every((output) => plain(output).includes(BODY)), "real body must remain visible");
				work.reset();
				for (let pass = 0; pass < 30; pass++) {
					for (let i = 0; i < records.length; i++) assert.deepEqual(records[i].render(100), expected[i]);
				}
				t.diagnostic(JSON.stringify({ records: count, layer, ...work.counts, constantPrefixAllowance }));
				assert.equal(work.counts.body, 0, "warm redraw recolored body content");
				assert.ok(work.counts.prefix <= constantPrefixAllowance, "warm connector generation still scales with body rows");
			} finally { await harness?.close(); }
		});
	}
}

for (const layer of ["preview", "shell"] as const) {
	test(`T1 ${layer}: A → B → A retains only the current formatted width`, () => {
		const { theme, work } = compatibleTheme();
		const item = layer === "preview" ? preview(linesFor(), theme)
			: new ClaudeToolResultComponent(staticChild(linesFor()), { theme, connectRows: true });
		const measure = (width: number) => {
			work.reset();
			const output = item.render(width).slice();
			return { output, work: layer === "preview" ? work.counts.body : work.counts.prefix };
		};
		const firstA = measure(100);
		const warmA = measure(100);
		const b = measure(64);
		const backA = measure(100);
		assert.deepEqual(warmA.output, firstA.output);
		assert.deepEqual(backA.output, firstA.output);
		assert.ok(b.output.every((line) => visibleWidth(line) <= 64));
		assert.ok(b.work > warmA.work, "resize must redo width-dependent body layout");
		assert.ok(backA.work > warmA.work, "old A layout must not survive as a historical-width cache");
	});

	test(`T1 ${layer}: same appearance and same theme object with different ANSI changes output`, () => {
		const { theme, changeColor } = compatibleTheme();
		const item = layer === "preview" ? preview([`${BODY}palette`], theme)
			: new ClaudeToolResultComponent(staticChild([`${BODY}palette`]), { theme, connectRows: true });
		const before = item.render(100).slice();
		changeColor();
		const after = item.render(100);
		assert.equal(plain(after), plain(before));
		assert.notDeepEqual(after, before);
		assert.ok(after.some((line) => line.includes("\x1b[32m")));
	});
}

test("T1 preview: same array plus invalidate refreshes content", () => {
	const { theme } = compatibleTheme();
	const lines = [`${BODY}before`];
	const item = preview(lines, theme);
	assert.match(plain(item.render(100)), /D2BODY_before/);
	lines[0] = `${BODY}after`;
	item.invalidate();
	assert.match(plain(item.render(100)), /D2BODY_after/);
	assert.doesNotMatch(plain(item.render(100)), /D2BODY_before/);
});

test("T1 shell: child.render remains live, including reused arrays and equal fresh arrays", () => {
	const { theme, work } = compatibleTheme();
	const lines = Array.from({ length: 32 }, (_, i) => `${BODY}before_${i}`);
	let renders = 0;
	let fresh = false;
	const item = new ClaudeToolResultComponent({ render() { renders++; return fresh ? [...lines] : lines; }, invalidate() {} }, { theme, connectRows: true });
	const before = item.render(100).slice();
	fresh = true;
	work.reset();
	assert.deepEqual(item.render(100), before);
	const unchangedWork = work.counts.prefix;
	fresh = false;
	lines[0] = `${BODY}after`;
	work.reset();
	const after = item.render(100);
	assert.match(plain(after), /D2BODY_after/);
	assert.doesNotMatch(plain(after), /D2BODY_before_0\b/);
	assert.equal(renders, 3, "outer cache must not skip dynamic children");
	assert.ok(work.counts.prefix > unchangedWork, "content comparison must use bounded strings, not array identity");
});

for (const display of [false, true]) {
	test(`${display ? "T2 display" : "SDK control"}: same-object updateResult, partial/final, expand and resize`, async () => {
		initTheme("dark", false);
		const h = await createDisplaySession(config(), [], { display });
		const terminal = new AggregateTerminal();
		const ui = new TuiMainScreen(terminal);
		try {
			assert.ok(!h.session.getActiveToolNames().includes("codemode"), "ordinary display must not require codemode");
			const result = textResult(`${BODY}before`);
			const item = host(h, ui, result, "d2-update", display);
			assert.match(plain(item.render(100)), /D2BODY_before/);
			result.content[0].text = `${BODY}progress`;
			item.updateResult(result, true);
			assert.match(plain(item.render(100)), /D2BODY_progress/);
			result.content[0].text = Array.from({ length: 24 }, (_, i) => `${BODY}final_${i}`).join("\n");
			item.updateResult(result, false);
			const collapsed = plain(item.render(100));
			assert.doesNotMatch(collapsed, /D2BODY_progress/);
			item.setExpanded(true);
			assert.match(plain(item.render(100)), /D2BODY_final_23/);
			assert.ok(item.render(40).every((line) => visibleWidth(line) <= 40));
			item.setExpanded(false);
			assert.equal(plain(item.render(100)), collapsed);
		} finally { await h.close(); }
	});
}

for (const layer of ["preview", "shell"] as const) {
	test(`T1 ${layer}: input and formatted body are bounded before coloring`, () => {
		const { theme, work } = compatibleTheme();
		const lines = Array.from({ length: 12_000 }, (_, i) => `${BODY}${i} ${"word ".repeat(15)}`);
		const original = lines.slice();
		const item = layer === "preview" ? preview(lines, theme, { expanded: true, expandedRowCap: 20_000 })
			: new ClaudeToolResultComponent(staticChild(lines), { theme, connectRows: true });
		const output = item.render(100);
		assert.deepEqual(lines, original, "display budget must not mutate original content");
		assert.match(plain(output), omission, "budget exhaustion must be explicit");
		// Count all ordinary body rows, excluding only the explicit bounded omission message.
		const body = output.filter((line) => !omission.test(stripTerminalSequences(line)));
		assert.ok(body.reduce((sum, line) => sum + line.length, 0) <= INPUT_UNITS, "formatted current body exceeds 1m UTF-16 units");
		assert.ok(work.counts.bodyUnits <= INPUT_UNITS, "coloring saw more than the owned input budget");
	});

	test(`T1 ${layer}: logical-line cap does not traverse an accessor after 20000 lines`, () => {
		const { theme } = compatibleTheme();
		const lines = Array.from({ length: INPUT_LINES + 1 }, () => "x");
		let reads = 0;
		Object.defineProperty(lines, INPUT_LINES, { configurable: true, get() { reads++; return "FORBIDDEN_TAIL"; } });
		const item = layer === "preview" ? preview(lines, theme, { expanded: true, expandedRowCap: INPUT_LINES })
			: new ClaudeToolResultComponent(staticChild(lines), { theme, connectRows: true });
		const output = item.render(100);
		assert.equal(reads, 0, "budgeting must precede array traversal");
		assert.doesNotMatch(plain(output), /FORBIDDEN_TAIL/);
		assert.match(plain(output), omission);
	});
}

// Call the actual registered renderer to isolate extension-owned extraction from
// native host prework. The frozen budget does not constrain host internals.
async function renderOwnedResult(result: HostResult, expanded = true) {
	initTheme("dark", false);
	let theme: Theme | undefined;
	const h = await createDisplaySession(config(), [{ name: "d2_fixture" }, {
		name: "d2_theme_source",
		renderResult(_result, _options, actualTheme) { theme = actualTheme; return staticChild(["theme control"]); },
	}]);
	try {
		const ui = new TuiMainScreen(new AggregateTerminal());
		const native = new ToolExecutionComponent("d2_theme_source", "theme-control", {}, {},
			h.session.getToolDefinition("d2_theme_source"), ui, h.cwd);
		native.updateResult(textResult("theme control"), false);
		native.render(100);
		assert.ok(theme, "native SDK must supply its complete theme");
		const render = h.renderers("d2_fixture")?.renderResult;
		assert.equal(typeof render, "function", "generic registered renderer must exist");
		const context: ToolRenderContext = {
			args: {}, toolCallId: "d2-budget", state: {}, lastComponent: undefined,
			cwd: h.cwd, executionStarted: true, argsComplete: true, isPartial: false,
			expanded, showImages: false, isError: result.isError, durationMs: undefined, outputPad: 0,
			invalidate() {},
		};
		return render(result, { expanded, isPartial: false }, theme, context).render(100);
	} finally { await h.close(); }
}

test("Fixture control: registered generic fallback actually displays ordinary text", async () => {
	assert.match(plain(await renderOwnedResult(textResult(`${BODY}ordinary`))), /D2BODY_ordinary/);
});

test("T1 extraction: block cap precedes text access and keeps the source result intact", async () => {
	let reads = 0;
	const result = textResult("");
	result.content = Array.from({ length: INPUT_BLOCKS + 1 }, () => ({ type: "text", text: "short" }));
	Object.defineProperty(result.content[INPUT_BLOCKS], "text", { enumerable: true, get() { reads++; return "FORBIDDEN_BLOCK"; } });
	const output = await renderOwnedResult(result);
	assert.equal(reads, 0, "extension read a content block beyond its budget");
	assert.equal(result.content.length, INPUT_BLOCKS + 1);
	assert.ok(Object.getOwnPropertyDescriptor(result.content[INPUT_BLOCKS], "text")?.get);
	assert.doesNotMatch(plain(output), /FORBIDDEN_BLOCK/);
	assert.match(plain(output), omission);
});

test("T1 extraction: display never invokes text getters", async () => {
	let reads = 0;
	const block = { type: "text" as const, get text() { reads++; return "GETTER_SIDE_EFFECT"; } };
	const output = await renderOwnedResult({ content: [block], details: {}, isError: true });
	assert.equal(reads, 0);
	assert.match(plain(output), omission);
});

test("T1 extraction: huge text is bounded before full split and original text is immutable", async (t) => {
	const text = `${BODY}${"word ".repeat(220_000)}FORBIDDEN_AFTER_INPUT_BUDGET`;
	let oversizedSplits = 0;
	const originalSplit = String.prototype.split;
	t.mock.method(String.prototype, "split", function (...args: Parameters<typeof originalSplit>) {
		if (String(this).startsWith(BODY) && String(this).length > INPUT_UNITS) oversizedSplits++;
		return originalSplit.apply(this, args);
	});
	const result = textResult(text);
	Object.freeze(result.content[0]); Object.freeze(result.content); Object.freeze(result);
	const output = await renderOwnedResult(result);
	assert.equal(result.content[0].text, text);
	assert.doesNotMatch(plain(output), /FORBIDDEN_AFTER_INPUT_BUDGET/);
	assert.match(plain(output), omission);
	assert.equal(oversizedSplits, 0, "bounded output alone cannot excuse full oversized-input splitting");
});

for (const boundary of ["units", "lines"] as const) {
	test(`T1 extraction: ${boundary} budget stops before accessing the next block`, async () => {
		let reads = 0;
		const content = boundary === "units" ? "x".repeat(INPUT_UNITS + 1) : "x\n".repeat(INPUT_LINES + 1);
		const result: HostResult = { content: [
			{ type: "text", text: content },
			{ type: "text", get text() { reads++; return "FORBIDDEN_NEXT_BLOCK"; } },
		], details: {}, isError: false };
		const output = await renderOwnedResult(result);
		assert.equal(reads, 0, "input guard must run before extracting or joining all blocks");
		assert.doesNotMatch(plain(output), /FORBIDDEN_NEXT_BLOCK/);
		assert.match(plain(output), omission);
	});
}

test("T1 extraction: pathological text object must not invoke toJSON or coercion", async () => {
	let sideEffects = 0;
	const value = {
		toJSON() { sideEffects++; return "FORBIDDEN_JSON"; },
		toString() { sideEffects++; return "FORBIDDEN_COERCION"; },
	};
	// Intentionally invalid external result, not a claimed SDK-valid text fixture.
	const result = { content: [{ type: "text", text: value }], details: {}, isError: true } as unknown as HostResult;
	let output: string[] = [];
	await assert.doesNotReject(async () => { output = await renderOwnedResult(result); });
	assert.equal(sideEffects, 0);
	assert.match(plain(output), omission);
	assert.equal((result.content[0] as unknown as { text: unknown }).text, value);
});

test("T1 error summary: collapsed errors retain the stricter 240-unit summary bound", async () => {
	const result = { ...textResult(`${BODY}error ${"q".repeat(300)}FORBIDDEN_ERROR_TAIL`), isError: true };
	Object.freeze(result.content[0]); Object.freeze(result.content); Object.freeze(result);
	const output = plain(await renderOwnedResult(result, false));
	assert.match(output, /D2BODY_error/);
	assert.doesNotMatch(output, /FORBIDDEN_ERROR_TAIL/);
	assert.ok((output.match(/q/g) ?? []).length <= 240);
	assert.match(output, /…|\.\.\.|omitt|truncat/i);
});

test("T1 config getter plus native TUI invalidation changes an existing history row", async () => {
	initTheme("dark", false);
	const currentConfig = config();
	const h = await createDisplaySession(currentConfig);
	const terminal = new AggregateTerminal(); terminal.columns = 100; terminal.rows = 24;
	const ui = new TuiMainScreen(terminal);
	try {
		const item = host(h, ui, textResult(Array.from({ length: 20 }, (_, i) => `${BODY}config_${i}`).join("\n")));
		ui.addChild(item); ui.start(); ui.renderNow();
		assert.match(plain(item.render(100)), /D2BODY_config_6/);
		// The sanctioned harness exposes the production config getter. This covers
		// its consumer, not /tools persistence or a fabricated UI/event notification.
		currentConfig.previewRows = 2;
		ui.invalidate(); ui.requestRender(); ui.renderNow();
		assert.match(plain(item.render(100)), /D2BODY_config_0/);
		assert.doesNotMatch(plain(item.render(100)), /D2BODY_config_6/);
		currentConfig.previewRows = 8;
		ui.invalidate(); ui.requestRender(); ui.renderNow();
		assert.match(plain(item.render(100)), /D2BODY_config_6/);
	} finally { ui.stop(); await h.close(); }
});

for (const mode of ["regular", "fullscreen"] as const) {
	test(`T2 native ${mode}: notified content and resize remain visible through real terminal paint`, async () => {
		initTheme("dark", false);
		const h = await createDisplaySession(config());
		const terminal = new AggregateTerminal();
		terminal.columns = 100; terminal.rows = 24;
		const ui = mode === "regular" ? new TuiMainScreen(terminal) : new TuiAltScreen(terminal);
		try {
			const result = textResult(`${BODY}initial`);
			const item = host(h, ui, result);
			const identity = (text: string) => text;
			const editor = new Editor(ui, { borderColor: identity, selectList: {
				selectedPrefix: identity, selectedText: identity, description: identity,
				scrollInfo: identity, noMatch: identity,
			} });
			ui.addChild(item); ui.addChild(editor); ui.setFocus(editor);
			ui.start(); ui.renderNow();
			assert.match(stripTerminalSequences(terminal.writes.join("")), /D2BODY_initial/);
			terminal.writes.length = 0;
			result.content[0] = { type: "text", text: `${BODY}notified` };
			item.updateResult(result, false);
			terminal.resize(64, 24); ui.renderNow();
			assert.match(stripTerminalSequences(terminal.writes.join("")), /D2BODY_notified/);
			terminal.onInput!("abc"); terminal.onInput!("\x7f"); ui.renderNow();
			assert.equal(editor.getText(), "ab", "native input/backspace must not be lost during history redraw");
			assert.ok(item.render(64).every((line) => visibleWidth(line) <= 64));
		} finally { ui.stop(); await h.close(); }
	});
}

// Only the custom-dialog bridge is supplied here; focus, keys, overlays and
// invalidation belong to the real TUI. No fake ctx.ui.invalidate or private state.
async function mountDialog(session: Harness["session"], ui: TuiMainScreen, terminal: AggregateTerminal) {
	// The SDK declares this UI factory parameter but does not re-export its class
	// from the package root. Load the installed SDK class, not a lookalike stub.
	const { KeybindingsManager } = await import(new URL("./core/keybindings.js", import.meta.resolve("@earendil-works/pi-coding-agent")).href);
	const keybindings = new KeybindingsManager();
	const runner = session.extensionRunner;
	const base = runner.getUIContext();
	let component: Component & { dispose?(): void };
	let close = () => {};
	let mounted: (component: Component) => void;
	const ready = new Promise<Component>((resolve) => { mounted = resolve; });
	const context: typeof base = {
		...base,
		custom: (factory, options) => new Promise((resolve, reject) => {
			let overlay: ReturnType<typeof ui.showOverlay>;
			const done = (result) => { overlay?.hide(); component?.dispose?.(); resolve(result); };
			close = () => done(undefined);
			Promise.resolve(factory(ui, base.theme, keybindings, done)).then((created) => {
				component = created;
				const positioning = typeof options?.overlayOptions === "function" ? options.overlayOptions() : options?.overlayOptions;
				overlay = ui.showOverlay(component, positioning);
				options?.onHandle?.(overlay);
				ui.renderNow(); mounted(component);
			}, reject);
		}),
	};
	runner.setUIContext(context, "tui");
	return {
		context, ready, close: () => close(),
		view: () => plain(component.render(terminal.columns)),
		key(data: string) { terminal.onInput!(data); ui.renderNow(); return plain(component.render(terminal.columns)); },
	};
}

const toolsUiCase = "T2 /tools keys persist 8 to 12, refresh the same row and survive reload";
test(toolsUiCase, async () => {
	// A fresh process fixes the config root BEFORE any product module import.
	// It inherits run-isolated's empty credentials and network namespace.
	if (!process.env.PI_D2_TOOLS_UI_CHILD) {
		const root = mkdtempSync(join(tmpdir(), "pi-d2-tools-ui-"));
		try {
			const { NODE_TEST_CONTEXT: _testWorker, ...environment } = process.env;
			const child = spawnSync(process.execPath, ["--import", "tsx", "--test", `--test-name-pattern=^${toolsUiCase}$`, fileURLToPath(import.meta.url)], {
				cwd: fileURLToPath(new URL("..", import.meta.url)), encoding: "utf8", timeout: 30_000,
				env: { ...environment, PI_CODING_AGENT_DIR: root, PI_D2_TOOLS_UI_CHILD: "1" },
			});
			assert.ifError(child.error);
			assert.equal(child.status, 0, child.stdout + child.stderr);
			assert.match(child.stdout, /tests 1\b/, "the fresh process must execute its one UI contract");
		} finally { rmSync(root, { recursive: true, force: true }); }
		return;
	}
	initTheme("dark", false);
	const agentDir = process.env.PI_CODING_AGENT_DIR!;
	const configPath = join(agentDir, "extension-data/pi-tool-display-intent/config.json");
	mkdirSync(dirname(configPath), { recursive: true });
	writeFileSync(configPath, JSON.stringify({ version: 2, toolCalls: { layout: "individual" }, results: { mode: "preview", previewRows: 8 } }));
	const settingsManager = SettingsManager.inMemory({ packages: [] });
	const loader = new DefaultResourceLoader({
		cwd: agentDir, agentDir, settingsManager, noExtensions: true, noSkills: true, noThemes: true,
		noPromptTemplates: true, noContextFiles: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../extensions/tool-display-intent.ts", import.meta.url))],
	});
	await loader.reload();
	assert.deepEqual(loader.getExtensions().errors, []);
	const modelRuntime = await ModelRuntime.create({ authPath: join(agentDir, "auth.json"), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const { session } = await createAgentSession({ cwd: agentDir, agentDir, settingsManager, modelRuntime, resourceLoader: loader, sessionManager: SessionManager.inMemory(agentDir) });
	const terminal = new AggregateTerminal(); terminal.columns = 100; terminal.rows = 36;
	const ui = new TuiMainScreen(terminal);
	const dialog = await mountDialog(session, ui, terminal);
	const errors: unknown[] = [];
	let prompt: Promise<unknown> | undefined;
	try {
		await session.bindExtensions({ uiContext: dialog.context, mode: "tui", onError: (error) => errors.push(error) });
		const result = textResult(Array.from({ length: 20 }, (_, i) => `HISTORY_ROW_${i}`).join("\n"));
		const makeRow = () => {
			const renderers = session.extensionRunner.resolveToolRenderers("bash", () => session.getToolDefinition("bash"));
			const row = new ToolExecutionComponent("bash", "persisted-history", { command: "printf fixture" }, { outputPad: 0 }, renderers, ui, agentDir);
			row.setArgsComplete(); row.markExecutionStarted(); row.updateResult(result, false);
			return row;
		};
		const historicalRow = makeRow();
		ui.addChild(historicalRow); ui.start(); ui.renderNow();
		assert.match(plain(historicalRow.render(100)), /HISTORY_ROW_7\b/);
		assert.doesNotMatch(plain(historicalRow.render(100)), /HISTORY_ROW_11\b/);
		prompt = session.prompt("/tools");
		await Promise.race([dialog.ready, prompt.then(() => { throw new Error("/tools completed without mounting its settings panel"); })]);
		assert.match(dialog.view(), /Preview Rows/i);
		for (let i = 0; i < 3; i++) dialog.key("\x1b[B");
		dialog.key(" ");
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).results.previewRows, 12);
		// Deliberately no test-side invalidate/updateResult: the actual command owns the notification.
		assert.match(plain(historicalRow.render(100)), /HISTORY_ROW_11\b/);
		dialog.key("\x1b"); await prompt;
		await session.reload();
		assert.deepEqual(loader.getExtensions().errors, []);
		assert.match(plain(makeRow().render(100)), /HISTORY_ROW_11\b/);
		assert.equal(JSON.parse(readFileSync(configPath, "utf8")).results.previewRows, 12);
		assert.deepEqual(errors, []);
	} finally { dialog.close(); await prompt?.catch(() => {}); ui.stop(); session.dispose(); }
});

test("T2 detail viewer keys bound Result, Args, Metadata and Raw without touching original objects", async (t) => {
	initTheme("dark", false);
	const h = await createDisplaySession(config(), [], { display: false });
	const terminal = new AggregateTerminal(); terminal.columns = 100; terminal.rows = 24;
	const ui = new TuiMainScreen(terminal);
	const dialog = await mountDialog(h.session, ui, terminal);
	let sideEffects = 0;
	const largeTail = "x".repeat(160 * 1024) + "FORBIDDEN_STRUCTURED_TAIL";
	const args = Object.freeze({ head: "ARGS_HEAD", get accessor() { sideEffects++; return "FORBIDDEN_GETTER"; }, toJSON() { sideEffects++; return "FORBIDDEN_TOJSON"; }, tail: largeTail });
	const details = Object.freeze({ note: "META_HEAD", get accessor() { sideEffects++; return "FORBIDDEN_GETTER"; }, toJSON() { sideEffects++; return "FORBIDDEN_TOJSON"; }, tail: largeTail });
	const text = "RESULT_HEAD\n" + "result line\n".repeat(5000) + "FORBIDDEN_RESULT_TAIL";
	const result = Object.freeze({ content: Object.freeze([Object.freeze({ type: "text", text })]), details });
	const accessor = Object.getOwnPropertyDescriptor(args, "accessor")!.get;
	let fullOriginalSerializations = 0;
	const stringify = JSON.stringify;
	t.mock.method(JSON, "stringify", function (value, ...rest) {
		if (value === args || value === details || value === result || value === result.content || value === result.content[0] || value === largeTail || value === text) fullOriginalSerializations++;
		return stringify.call(JSON, value, ...rest);
	});
	let viewing: Promise<void> | undefined;
	try {
		ui.start();
		viewing = openDetailViewer(h.session.extensionRunner.createCommandContext(), { kind: "tool", toolName: "fixture", args, result });
		await Promise.race([dialog.ready, viewing.then(() => { throw new Error("detail viewer closed without a popup"); })]);
		assert.match(dialog.view(), /RESULT_HEAD/);
		assert.match(dialog.key("\x1b[F"), omission);
		assert.doesNotMatch(dialog.view(), /FORBIDDEN_RESULT_TAIL/);
		dialog.key("\t"); dialog.key("\x1b[H");
		assert.match(dialog.view(), /ARGS_HEAD/);
		const argsFormatted = dialog.view();
		assert.notEqual(dialog.key("r"), argsFormatted, "Raw must visibly switch the Args presentation");
		dialog.key("\x1b[H");
		assert.match(dialog.view(), /ARGS_HEAD/);
		assert.match(dialog.key("\x1b[F"), omission);
		assert.doesNotMatch(dialog.view(), /FORBIDDEN_STRUCTURED_TAIL/);
		dialog.key("m"); dialog.key("\x1b[H");
		assert.match(dialog.view(), /META_HEAD/);
		const metadataFormatted = dialog.view();
		assert.notEqual(dialog.key("r"), metadataFormatted, "Raw must visibly switch the Metadata presentation");
		dialog.key("\x1b[H");
		assert.match(dialog.view(), /META_HEAD/);
		assert.match(dialog.key("\x1b[F"), omission);
		assert.doesNotMatch(dialog.view(), /FORBIDDEN_STRUCTURED_TAIL/);
		dialog.key("\x1b"); await viewing;
		assert.equal(sideEffects, 0);
		assert.equal(fullOriginalSerializations, 0, "serialize a bounded safe snapshot, never the original result/args");
		assert.equal(args.tail, largeTail); assert.equal(details.tail, largeTail); assert.equal(result.content[0].text, text);
		assert.equal(Object.getOwnPropertyDescriptor(args, "accessor")!.get, accessor);
	} finally { dialog.close(); await viewing?.catch(() => {}); ui.stop(); await h.close(); }
});
