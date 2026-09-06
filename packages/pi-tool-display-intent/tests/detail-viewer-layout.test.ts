import assert from "node:assert/strict";
import test from "node:test";
import { initTheme } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { buildDetailModel, sanitizeDetailText, type DetailRequest } from "../src/detail-viewer-model.ts";
import { DetailViewer } from "../src/detail-viewer.ts";
import { colorDetailCode, colorDetailJson, renderDetailFields } from "../src/detail-content.ts";

const clean = (line: string) => sanitizeDetailText(line, false);
const text = (value: string) => ({ type: "text", text: value });
const tool = (args: unknown = {}, details?: unknown): DetailRequest => ({
	kind: "tool", toolName: "bash", target: "Bash", status: "success", timing: "0.8s  12:34:56", args,
	result: { content: [text("Completed")], ...(details === undefined ? {} : { details }) },
});
function viewer(request: DetailRequest, height = 20) {
	return new DetailViewer(buildDetailModel(request), { getHeight: () => height, onClose() {}, onRender() {} });
}
function click(x: number, y: number): TuiMouseEvent {
	return { type: "click", button: "left", x, y, screenX: x, screenY: y, width: 90, height: 20, shift: false, alt: false, ctrl: false };
}

test("Args and Raw retain credentials while showing multiline commands readably", () => {
	const request = tool({ command: "pnpm test\npnpm typecheck", timeout: 60, api_key: "synthetic-secret" });
	const before = structuredClone(request);
	const component = viewer(request);
	component.render(90);
	component.handleInput("\t");
	let lines = component.render(90).map(clean);
	assert.match(lines.join("\n"), /\[Args\]/);
	assert.match(lines.join("\n"), /pnpm test/);
	assert.match(lines.join("\n"), /pnpm typecheck/);
	assert.doesNotMatch(lines.join("\n"), /"command":|pnpm test\\n|Read-only/);
	assert.match(lines.join("\n"), /synthetic-secret/);
	assert.doesNotMatch(lines[2], /masked/);
	const rawColumn = lines[2].indexOf("Raw");
	assert.ok(rawColumn >= 0);
	assert.equal(component.handleMouse(click(rawColumn, 2))?.handled, true);
	lines = component.render(90).map(clean);
	assert.match(lines[2], /\[Raw\]/);
	assert.match(lines.join("\n"), /"command":/);
	assert.match(lines.join("\n"), /pnpm test\\npnpm typecheck/);
	assert.match(lines.join("\n"), /synthetic-secret/);
	component.handleInput("r");
	assert.doesNotMatch(component.render(90).map(clean).join("\n"), /"command":/);
	assert.deepEqual(request, before);
});

test("Metadata is behind the advanced entry and is excluded from the primary Tab cycle", () => {
	const component = viewer(tool({ timeout: 60 }, { note: "diagnostic information" }));
	let lines = component.render(90).map(clean);
	assert.doesNotMatch(lines[2], /Metadata|Details|Read-only|masked/);
	assert.ok(lines[2].includes("⋯"));
	component.handleInput("\t");
	assert.match(component.render(90).map(clean)[2], /\[Args\]/);
	component.handleInput("\t");
	assert.match(component.render(90).map(clean)[2], /\[Result\]/);
	lines = component.render(90).map(clean);
	assert.equal(component.handleMouse(click(lines[2].indexOf("⋯"), 2))?.handled, true);
	lines = component.render(90).map(clean);
	assert.match(lines[2], /\[Metadata\]/);
	assert.match(lines.join("\n"), /diagnostic information/);
	component.handleInput("m");
	assert.match(component.render(90).map(clean)[2], /\[Result\]/);
});

test("title status and footer position stay right-aligned without repeated chrome", () => {
	const component = viewer({ ...tool(), target: `Read(${"long-directory/".repeat(20)}file.ts)`, result: { content: [text(Array.from({ length: 20 }, (_, i) => `line ${i}`).join("\n"))] } } as DetailRequest, 10);
	for (const width of [50, 80, 100]) {
		const lines = component.render(width);
		const shown = lines.map(clean);
		assert.match(shown[1], /✓ 0\.8s\s*│$/);
		assert.match(shown[shown.length - 2], /\/20\s*│$/);
		assert.doesNotMatch(shown.join("\n"), /Tools —|Read-only|12:34:56/);
		assert.ok(lines.every((line) => visibleWidth(line) === width));
	}
});

test("clear custom Markdown is rendered, and Raw reveals its unchanged source", () => {
	initTheme("dark", false);
	const source = "## Heading\n\n**Important** text";
	const component = viewer({ kind: "tool", toolName: "custom_report", args: {}, result: { content: [text(source)] } });
	const formatted = component.render(90).map(clean).join("\n");
	assert.match(formatted, /Heading/);
	assert.match(formatted, /Important/);
	assert.doesNotMatch(formatted, /## Heading|\*\*Important\*\*/);
	component.handleInput("r");
	assert.match(component.render(90).map(clean).join("\n"), /## Heading/);
	assert.match(component.render(90).map(clean).join("\n"), /\*\*Important\*\*/);
});

test("Markdown files render as Markdown while Raw still shows their source", () => {
	initTheme("dark", false);
	const source = "# Readme\n\n**Important**\n\n- first\n- second";
	const component = viewer({ kind: "tool", toolName: "read", args: { path: "README.md" }, result: { content: [text(source)] } });
	const rendered = component.render(90).map(clean).join("\n");
	assert.match(rendered, /Readme/);
	assert.doesNotMatch(rendered, /# Readme|\*\*Important\*\*/);
	component.handleInput("r");
	assert.match(component.render(90).map(clean).join("\n"), /# Readme/);
});

test("Bash command fields use shell syntax highlighting without changing their content", () => {
	initTheme("dark", false);
	const command = 'for file in *.ts; do\n  echo "$file"\ndone';
	const model = buildDetailModel(tool({ command }));
	assert.equal(model.tabs[1].fields?.find((field) => field.key === "command")?.language, "bash");
	const highlighted = colorDetailCode(command, "bash");
	assert.equal(clean(highlighted), command);
	assert.match(highlighted, /\x1b\[/);
	const body = renderDetailFields(model.tabs[1].fields ?? [], 70);
	assert.match(body.join("\n"), /\x1b\[/);
	assert.match(body.map(clean).join("\n"), /for file in \*\.ts; do/);
});

test("field layouts preserve multiline and nested values within narrow terminal bounds", () => {
	const fields = [
		{ key: "path", value: "src/config.ts", kind: "string" as const },
		{ key: "command", value: "first command\nsecond command END", kind: "string" as const },
		{ key: "options", value: '{\n  "enabled": true\n}', kind: "json" as const },
	];
	const wide = renderDetailFields(fields, 60).join("\n");
	assert.match(wide, /path\s+src\/config.ts/);
	assert.match(wide, /command\n  first command\n  second command END/);
	assert.match(wide, /"enabled": true/);
	for (const width of [1, 4, 12, 30]) {
		const rows = renderDetailFields(fields, width);
		assert.ok(rows.every((row) => visibleWidth(row) <= width));
	}
});

test("long Args stay at the end across resize, Metadata navigation and invalidation", () => {
	const args = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${String(index).padStart(2, "0")}`, "long value ".repeat(6)]));
	const component = viewer(tool(args, { note: "extra metadata" }), 10);
	component.render(90);
	component.handleInput("\t");
	component.handleInput("\x1b[F");
	assert.match(component.render(90).map(clean).join("\n"), /field19/);
	assert.match(component.render(30).map(clean).join("\n"), /field19/);
	component.handleInput("m");
	component.render(30);
	component.handleInput("m");
	assert.match(component.render(30).map(clean).join("\n"), /field19/);
	component.invalidate();
	assert.match(component.render(30).map(clean).join("\n"), /field19/);
});

test("resizing a middle Args page retains the same field rather than its old screen row", () => {
	const args = Object.fromEntries(Array.from({ length: 20 }, (_, index) => [`field${String(index).padStart(2, "0")}`, "long value ".repeat(6)]));
	const component = viewer(tool(args), 10);
	component.render(90);
	component.handleInput("\t");
	for (let i = 0; i < 6; i++) component.handleInput("\x1b[B");
	assert.match(component.render(90).map(clean).join("\n"), /field06/);
	assert.match(component.render(30).map(clean).join("\n"), /field06/);
});

test("JSON coloring never changes the source data or escapes", () => {
	const source = '{\n  "text": "line\\nwith \\"quotes\\"",\n  "enabled": true,\n  "count": -2.5\n}';
	const colored = colorDetailJson(source, { fg: (_color, value) => `\x1b[32m${value}\x1b[0m`, bold: (value) => value });
	assert.equal(clean(colored), source);
});
