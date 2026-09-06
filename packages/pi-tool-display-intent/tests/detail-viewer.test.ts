import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth, type TuiMouseEvent } from "@earendil-works/pi-tui";
import { DetailViewer } from "../src/detail-viewer.ts";
import {
	buildDetailModel, DETAIL_LIMITS, DETAIL_TRUNCATION, formatDetailJson, sanitizeDetailText,
	type DetailRequest,
} from "../src/detail-viewer-model.ts";

const tool = (result: unknown, args: unknown = {}): DetailRequest => ({ kind: "tool", toolName: "custom_tool", result, args });
const plain = (lines: string[]) => lines.map((line) => sanitizeDetailText(line, false)).join("\n");
const native = (text: string) => tool({ content: [{ type: "text", text }] });
const wheel = (wheelDelta: number): TuiMouseEvent => ({
	type: "wheel", button: "none", x: 3, y: 3, screenX: 3, screenY: 3,
	width: 80, height: 10, shift: false, alt: false, ctrl: false, wheelDelta,
});

function viewer(request: DetailRequest, height = 10) {
	let currentHeight = height;
	let closes = 0;
	const component = new DetailViewer(buildDetailModel(request), {
		getHeight: () => currentHeight, onClose: () => closes++, onRender: () => {},
	});
	return { component, resize: (value: number) => { currentHeight = value; }, closes: () => closes };
}

test("native custom text preserves lines, indentation, code fences and SGR without business parsing", () => {
	const text = "  $ custom --verbose\n\n```ts\n  const value = 1;  // untouched\n```\n\x1b[31mERROR: original log\x1b[0m\n";
	const model = buildDetailModel(native(text));
	assert.equal(model.tabs[0].text, text);
	assert.equal(model.tabs[0].masked, false);
	assert.deepEqual(model.tabs.map((tab) => tab.label), ["Result", "Args"]);
});

test("pure JSON results are pretty JSON while non-JSON text stays native", () => {
	const model = buildDetailModel(native('{"rows":[{"id":1,"ok":true}],"next":null}'));
	assert.equal(model.tabs[0].text, JSON.stringify({ rows: [{ id: 1, ok: true }], next: null }, null, 2));
	assert.equal(buildDetailModel(native("prefix {\"id\":1}")).tabs[0].text, 'prefix {"id":1}');
});

test("formatting JSON does not alter escaped control data or mask original result values", () => {
	const data = { text: "line\r\n\x1b[31mred", token: "synthetic-result-value" };
	const text = buildDetailModel(native(JSON.stringify(data))).tabs[0].text;
	assert.deepEqual(JSON.parse(text), data);
	assert.doesNotMatch(text, /\x1b/);
});

test("ANSI sanitizer keeps SGR but removes OSC hyperlinks/clipboard, cursor commands and other controls", () => {
	const input = "\x1b[1;31mred\x1b[0m\x1b[38:2::1:2:3mRGB\x1b[m" +
		"\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\" +
		"\x1b]52;c;clipboard\x07\x1b[2J\x1b[10;4H\x1b[?25h\x1b7" +
		"\x1bPbinary\x1b\\\x1b_Gpixels\x1b\\\x1b^private\x1b\\" +
		"\x00\x07\x08\x7f\u202evisible\r\n  next\tcolumn";
	assert.equal(sanitizeDetailText(input), "\x1b[1;31mred\x1b[0m\x1b[38:2::1:2:3mRGB\x1b[mlinkvisible\n  next\tcolumn");
});

test("C1 controls and unterminated escape payloads never escape into the terminal", () => {
	assert.equal(sanitizeDetailText("a\x9d52;c;secret\x9cb\x90pixels\x9cc\x9b31md\x9b0m"), "abc\x1b[31md\x1b[0m");
	for (const suffix of ["\x1b]52;c;hidden", "\x1b_Ghidden", "\x1bPpayload", "\x1b[123;", "\x1b("]) {
		assert.equal(sanitizeDetailText(`safe${suffix}`), "safe");
	}
});

test("result blocks remain in order and attachments contain metadata rather than pixels", () => {
	const text = buildDetailModel(tool({ content: [
		{ type: "text", text: "first" },
		{ type: "image", mimeType: "image/png", data: "not-real-pixels" },
		{ type: "text", text: "middle" },
		{ type: "audio", name: "voice.wav", data: "not-real-audio" },
		{ type: "text", text: "last" },
	] })).tabs[0].text;
	assert.ok(text.indexOf("first") < text.indexOf("image/png"));
	assert.ok(text.indexOf("image/png") < text.indexOf("middle"));
	assert.ok(text.indexOf("middle") < text.indexOf("voice.wav"));
	assert.ok(text.indexOf("voice.wav") < text.indexOf("last"));
	assert.match(text, /Attachment; non-text payload not displayed/);
	assert.doesNotMatch(text, /not-real-pixels|not-real-audio/);
});

test("unknown custom structured results and blocks are shown as JSON", () => {
	const data = { custom: { status: "done", rows: [1, 2] } };
	assert.deepEqual(JSON.parse(buildDetailModel(tool(data)).tabs[0].text), data);
	assert.deepEqual(JSON.parse(buildDetailModel(tool({ content: [data] })).tabs[0].text), data);
});

test("unknown typed resource and JSON blocks retain their structured content", () => {
	for (const block of [
		{ type: "resource", resource: { uri: "test://output", mimeType: "text/plain", text: "IMPORTANT RESULT" } },
		{ type: "json", data: { status: "ready", value: 42 } },
	]) {
		assert.deepEqual(JSON.parse(buildDetailModel(tool({ content: [block] })).tabs[0].text), block);
	}
});

test("Args and Metadata preserve credentials and token-like values without mutating snapshots", () => {
	const args = {
		api_key: "synthetic-api-secret", nested: [{ PASSWORD: "synthetic-password", clientSecret: { secret: "nested" } }],
		note: "Bearer synthetic-bearer", url: "https://name:synthetic-pass@example.test/?access_token=synthetic-query",
		opaque: "abCDef0123456789abCDef0123456789abcd", pat: "ghp_synthetic12345", jwt: "eyJhbGciOiJub25lIn0.eyJpZCI6MX0.signature",
		text: "Readable explanation ".repeat(30), normal: { enabled: true },
	};
	const before = JSON.stringify(args);
	const model = buildDetailModel(tool({ content: [], details: args }, args));
	for (const tab of model.tabs) {
		assert.deepEqual(JSON.parse(tab.rawText), args);
		assert.match(tab.text, /synthetic-api-secret/);
		assert.match(tab.text, /Readable explanation Readable explanation/);
		assert.match(tab.text, /"enabled": true/);
	}
	assert.equal(JSON.stringify(args), before);
	assert.equal(JSON.parse(model.tabs[1].text).nested[0].PASSWORD, "synthetic-password");
});

test("native result and steer text are not credential-masked or reformatted as parameter previews", () => {
	const text = "Original Bearer synthetic-visible-value\n  keep this line";
	assert.equal(buildDetailModel(native(text)).tabs[0].text, text);
	const steer = buildDetailModel({ kind: "steer", text: '{"original":true}\n' });
	assert.equal(steer.tabs[0].text, '{"original":true}\n');
	assert.equal(steer.showTabs, false);
	assert.equal(steer.tabs.length, 1);
});

test("Metadata is optional; details-only output preserves meaningful structured content", () => {
	for (const details of [undefined, null, {}, [], ""]) {
		assert.deepEqual(buildDetailModel(tool({ content: [], details })).tabs.map((tab) => tab.id), ["result", "args"]);
	}
	for (const details of [false, 0, { exitCode: 2, explanation: "Not allowed", token: "synthetic" }]) {
		const model = buildDetailModel(tool({ content: [{ type: "text", text: "" }], details }));
		assert.deepEqual(model.tabs.map((tab) => tab.id), ["result", "args", "details"]);
		assert.doesNotMatch(model.tabs[0].text, /Read-only|No result text\. Structured details:/);
		assert.ok(model.tabs[0].text.includes(formatDetailJson(details)));
		assert.equal(model.tabs[2].label, "Metadata");
		assert.equal(model.tabs[2].advanced, true);
	}
	assert.match(buildDetailModel(tool(undefined)).tabs[0].text, /No result content/);
});

test("custom result fields remain inspectable when details is also present", () => {
	for (const content of [[], [{ type: "text", text: "visible body" }]]) {
		const model = buildDetailModel(tool({ content, summary: "IMPORTANT ANSWER", count: 3, details: { elapsed: 1 } }));
		const metadata = model.tabs.find((tab) => tab.id === "details")!;
		assert.match(metadata.rawText, /IMPORTANT ANSWER/);
		assert.match(metadata.rawText, /"count": 3/);
		if (content.length === 0) {
			assert.match(model.tabs[0].text, /IMPORTANT ANSWER/);
			assert.match(model.tabs[0].rawText, /"count": 3/);
		} else assert.equal(model.tabs[0].text, "visible body");
	}
});

test("supplementary metadata does not copy attachment payloads into Raw views", () => {
	const model = buildDetailModel(tool({
		content: [{ type: "image", data: "synthetic-pixels", mimeType: "image/png" }],
		summary: "IMPORTANT ANSWER", details: { elapsed: 1 },
	}));
	assert.match(model.tabs[0].text, /IMPORTANT ANSWER/);
	assert.doesNotMatch(model.tabs.map((tab) => tab.rawText).join("\n"), /synthetic-pixels/);
});

test("attachment-only results put their structured fallback first without reordering attachments", () => {
	const model = buildDetailModel(tool({
		content: [{ type: "image", name: "first.png" }, { type: "file", name: "second.pdf" }],
		details: { report: "meaningful fallback", tokenValue: "synthetic-hidden" },
	}));
	const text = model.tabs[0].text;
	assert.match(text, /meaningful fallback/);
	assert.doesNotMatch(text, /Read-only/);
	assert.ok(text.indexOf("meaningful fallback") < text.indexOf("first.png"));
	assert.ok(text.indexOf("first.png") < text.indexOf("second.pdf"));
	assert.match(text, /synthetic-hidden/);
});

test("failure titles are explicit and untrusted title metadata is terminal-safe", () => {
	const model = buildDetailModel({ kind: "tool", toolName: "bad\x1b]52;c;hidden\x07\nname", args: {}, result: { isError: true }, timing: "1s" });
	assert.equal(model.failed, true);
	assert.equal(model.title, "bad name");
	assert.equal(model.timing, "1s");
	assert.doesNotMatch(model.title, /\x1b|hidden|\n/);
	assert.equal(buildDetailModel({ ...tool({}), status: "failed" } as DetailRequest).failed, true);
	assert.equal(buildDetailModel({ ...tool({}), status: "completed" } as DetailRequest).failed, false);
});

test("structured inspection handles cycles and omits accessors/toJSON without executing them", () => {
	let calls = 0;
	const data: Record<string, unknown> = { retained: 1, toJSON: () => { calls++; throw Error("must not run"); } };
	Object.defineProperty(data, "getter", { enumerable: true, get: () => { calls++; throw Error("must not run"); } });
	data.self = data;
	const result = JSON.parse(formatDetailJson(data));
	assert.equal(calls, 0);
	assert.equal(result.retained, 1);
	assert.equal(result.self, "[Circular]");
	assert.equal(result.getter, "[Accessor omitted]");
	assert.equal(result.toJSON, "[function]");
});

test("large text, huge lines and deep/wide JSON have bounded output and explicit truncation notices", () => {
	const long = buildDetailModel(native("x".repeat(DETAIL_LIMITS.characters * 3))).tabs[0].text;
	assert.match(long, /Truncated: long line/);
	assert.ok(long.includes(DETAIL_TRUNCATION));
	assert.ok(long.length < DETAIL_LIMITS.characters + 200);
	const many = buildDetailModel(native("line\n".repeat(DETAIL_LIMITS.lines + 100))).tabs[0].text;
	assert.ok(many.split("\n").length <= DETAIL_LIMITS.lines + 1);
	assert.ok(many.includes(DETAIL_TRUNCATION));
	let deep: unknown = { value: 1 };
	for (let i = 0; i < 1000; i++) deep = { child: deep };
	assert.match(formatDetailJson(deep), /Truncated/);
	const wide = formatDetailJson(Array.from({ length: 50000 }, (_, i) => i));
	assert.match(wide, /Truncated/);
	assert.ok(wide.length < DETAIL_LIMITS.characters + 200);
});

test("many empty content blocks cannot bypass the viewer work budget", () => {
	const model = buildDetailModel(tool({ content: Array.from({ length: 10000 }, () => ({ type: "text", text: "" })) }));
	assert.ok(model.tabs[0].text.includes(DETAIL_TRUNCATION));
});

test("viewport respects width and height including zero/tiny terminals and wide characters", () => {
	const { component, resize } = viewer(native("\x1b[32m中文 e\u0301 \tvery long line " + "0123456789".repeat(20) + "\nnext"));
	for (const height of [0, 1, 2, 3, 4, 5, 6, 7, 12]) {
		resize(height);
		for (const width of [0, 1, 2, 3, 4, 8, 20, 80]) {
			const lines = component.render(width);
			assert.ok(lines.length <= height, `${width}x${height}: ${lines.length} rows`);
			for (const line of lines) assert.ok(visibleWidth(line) <= width, `${width} columns: ${JSON.stringify(line)}`);
		}
	}
});

const numbered = Array.from({ length: 30 }, (_, i) => `line ${String(i).padStart(2, "0")}`).join("\n");

test("arrow/page/home/end scrolling clamps at both ends without blank pages", () => {
	const { component } = viewer({ kind: "steer", text: numbered }, 6);
	assert.match(plain(component.render(50)), /line 00\s*\nline 01/);
	component.handleInput("\x1b[A");
	assert.match(plain(component.render(50)), /line 00/);
	component.handleInput("\x1b[B");
	assert.doesNotMatch(plain(component.render(50)), /line 00/);
	component.handleInput("\x1b[6~");
	assert.match(plain(component.render(50)), /line 05/);
	component.handleInput("\x1b[5~");
	assert.match(plain(component.render(50)), /line 01/);
	component.handleInput("\x1b[F");
	assert.match(plain(component.render(50)), /line 26\s*\nline 27\s*\nline 28\s*\nline 29/);
	component.handleInput("\x1b[6~");
	assert.match(plain(component.render(50)), /line 26/);
	component.handleInput("\x1b[H");
	assert.match(plain(component.render(50)), /line 00/);
});

test("normalized wheel input scrolls and consumes boundary events rather than leaking to transcript", () => {
	const { component } = viewer({ kind: "steer", text: numbered }, 6);
	component.render(50);
	assert.equal(component.handleMouse(wheel(-1000))?.handled, true);
	assert.match(plain(component.render(50)), /line 00/);
	assert.equal(component.handleMouse(wheel(3))?.handled, true);
	assert.match(plain(component.render(50)), /line 03/);
	component.handleMouse(wheel(1000));
	assert.match(plain(component.render(50)), /line 29/);
	component.handleMouse(wheel(Number.NaN));
	assert.match(plain(component.render(50)), /line 29/);
});

test("tabs retain separate offsets and resizing reclamps them", () => {
	const { component, resize } = viewer(tool({ content: [{ type: "text", text: numbered }], details: { description: "details data" } }, { query: "args data" }), 8);
	component.render(70);
	component.handleInput("\x1b[6~");
	assert.match(plain(component.render(70)), /line 03/);
	component.handleInput("\t");
	assert.match(plain(component.render(70)), /\[Args\]/);
	assert.doesNotMatch(plain(component.render(70)), /masked/);
	assert.match(plain(component.render(70)), /args data/);
	component.handleInput("m");
	assert.match(plain(component.render(70)), /\[Metadata\]/);
	component.handleInput("m");
	assert.match(plain(component.render(70)), /\[Args\]/);
	component.handleInput("\t");
	assert.match(plain(component.render(70)), /line 03/);
	component.handleInput("m");
	assert.match(plain(component.render(70)), /\[Metadata\]/);
	component.handleInput("\t");
	component.handleInput("\x1b[F");
	resize(40);
	const screen = plain(component.render(70));
	assert.match(screen, /line 00/);
	assert.match(screen, /line 29/);
});

test("clickable tabs use component-local coordinates and expose their actual content", () => {
	const { component } = viewer(tool({ content: [{ type: "text", text: "result data" }] }, { query: "args data" }));
	const screen = component.render(80).map((line) => sanitizeDetailText(line, false));
	const y = screen.findIndex((line) => line.includes("[Result]"));
	const x = screen[y].indexOf("Args");
	assert.equal(component.handleMouse({ ...wheel(0), type: "click", button: "left", x, y })?.handled, true);
	assert.match(plain(component.render(80)), /\[Args\]/);
	assert.match(plain(component.render(80)), /args data/);
});

test("long lines wrap into vertically scrollable rows without losing text or SGR", () => {
	const source = "0123456789abcdefghijklmnopqrstuvwxyz";
	const { component } = viewer({ kind: "steer", text: `\x1b[31m${source}\x1b[0m` }, 2);
	const seen: string[] = [];
	for (let i = 0; i < 4; i++) {
		const lines = component.render(10);
		seen.push(sanitizeDetailText(lines[0], false).trimEnd());
		assert.match(lines[0], /\x1b\[31m/);
		assert.ok(lines.every((line) => visibleWidth(line) <= 10));
		component.handleInput("\x1b[B");
	}
	assert.equal(seen.join(""), source);
	assert.match(plain(component.render(10)), /^uvwxyz/);
	component.handleInput("\x1b[H");
	assert.match(plain(component.render(10)), /^0123456789/);
});

test("resizing reflows the source and keeps the reading position within a long line", () => {
	const { component } = viewer({ kind: "steer", text: "0123456789abcdefghijklmnopqrstuvwxyz" }, 2);
	component.render(10);
	component.handleInput("\x1b[B");
	component.handleInput("\x1b[B");
	assert.match(plain(component.render(10)), /^klmnopqrst/);
	assert.match(plain(component.render(20)), /^klmnopqrstuvwxyz/);
	assert.match(plain(component.render(80)), /^0123456789abcdefghijklmnopqrstuvwxyz/);
});

test("wrapped CJK and emoji remain whole and accessible by vertical scrolling", () => {
	const { component } = viewer({ kind: "steer", text: "中文🙂中文🙂" }, 2);
	assert.match(plain(component.render(6)), /^中文🙂/);
	component.handleInput("\x1b[B");
	const lines = component.render(6);
	assert.match(plain(lines), /^中文🙂/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 6));
});

test("multiline SGR is carried into scrolled lines and reset before viewer chrome", () => {
	const { component } = viewer({ kind: "steer", text: "\x1b[31mfirst\nsecond\nthird\x1b[0m" }, 2);
	component.render(20);
	component.handleInput("\x1b[B");
	const lines = component.render(20);
	assert.match(lines[0], /\x1b\[31msecond/);
	assert.ok(lines[0].endsWith("\x1b[0m"));
	assert.doesNotMatch(lines[1], /\x1b\[31m/);
});

test("steer is read-only, has no tab controls, and Esc closes exactly once", () => {
	const { component, closes } = viewer({ kind: "steer", text: "original text" });
	const before = plain(component.render(100));
	component.handleInput("\t");
	component.handleInput("replacement text");
	assert.equal(plain(component.render(100)), before);
	assert.doesNotMatch(before, /Tab tabs|\[Result\]|\[Args\]/);
	component.handleInput("\x1b");
	component.handleInput("\x1b");
	assert.equal(closes(), 1);
});
