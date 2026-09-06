import assert from "node:assert/strict";
import test from "node:test";
import {
	buildDetailModel, DETAIL_LIMITS, DETAIL_TRUNCATION, formatDetailJson, sanitizeDetailText,
	type DetailField, type DetailRequest,
} from "../src/detail-viewer-model.ts";

type ToolRequest = Extract<DetailRequest, { kind: "tool" }>;
const tool = (result: unknown, args: unknown = {}, toolName = "custom_tool"): ToolRequest => ({ kind: "tool", toolName, result, args });
const native = (text: string, toolName = "custom_tool") => tool({ content: [{ type: "text", text }] }, {}, toolName);
const argsPage = (args: unknown, toolName = "custom_tool") => buildDetailModel(tool(undefined, args, toolName)).tabs[1];
const diff = "  1 first\n- 2 old\n+ 2 new";

test("successful Edit puts the diff in Result and preserves return text plus diff in Raw", () => {
	const returned = "Successfully replaced text.\nWarning: review the generated section.";
	const model = buildDetailModel(tool({
		content: [{ type: "text", text: returned }], details: { diff: `\x1b[31m${diff}\x1b[0m` },
	}, { path: "src/example.ts\x1b]52;c;hidden\x07" }, "edit"));
	assert.deepEqual(model.tabs.map((tab) => tab.id), ["result", "args", "details"]);
	assert.equal(model.tabs[0].label, "Result");
	assert.equal(model.tabs[0].text, diff);
	assert.deepEqual(model.tabs[0].diff, { filePath: "src/example.ts", source: "edit" });
	assert.equal(model.tabs[0].rawText, `${returned}\n\n${diff}`);
	assert.equal(model.tabs[0].presentation, "text");
	assert.equal(model.tabs[0].masked, false);
	assert.equal(model.tabs[0].truncated, false);
});

test("failed, missing-diff and unrelated custom tools never acquire a diff renderer", () => {
	const requests: ToolRequest[] = [
		{ ...tool({ content: ["Edit failed"], isError: true, details: { diff } }, {}, "edit") },
		{ ...tool({ content: ["Edit failed"], details: { diff } }, {}, "edit"), status: "failed" },
		tool({ content: ["No patch returned"] }, { oldText: "old", newText: "new", path: "does-not-exist" }, "edit"),
		tool({ content: ["No patch returned"], details: { diff: " \n\t" } }, {}, "edit"),
		tool({ content: ["No patch returned"], details: { diff: { patch: diff } } }, {}, "edit"),
		tool({ content: ["custom return"], details: { diff } }),
	];
	for (const request of requests) {
		const model = buildDetailModel(request);
		assert.equal(model.tabs[0].id, "result");
		assert.equal(model.tabs[0].diff, undefined);
		assert.equal(model.tabs[0].text, (request.result as { content: string[] }).content[0]);
		assert.ok(model.tabs.every((tab) => ["result", "args", "details"].includes(tab.id)));
	}
});

test("Edit Raw reserves space for both original return text and diff under character and line limits", () => {
	for (const text of ["warning\n".repeat(DETAIL_LIMITS.lines), ("warning " + "x".repeat(500) + "\n").repeat(300)]) {
		const primary = buildDetailModel(tool({ content: [text], details: { diff } }, {}, "edit")).tabs[0];
		assert.equal(primary.text, diff);
		assert.match(primary.rawText, /^warning/);
		assert.ok(primary.rawText.includes(diff));
		assert.equal(primary.truncated, true);
		assert.ok(primary.rawText.includes(DETAIL_TRUNCATION));
		assert.ok(primary.rawText.length < DETAIL_LIMITS.characters + 200);
		assert.ok(primary.rawText.split("\n").length <= DETAIL_LIMITS.lines + 1);
	}
});

test("successful Write shows only written content as additions and keeps the native return plus content in Raw", () => {
	const returned = "Successfully wrote file.\nWarning: review the generated section.";
	const content = "token=synthetic-visible\n- existing literal minus\n+ existing literal plus\n";
	const page = buildDetailModel({ ...tool({ content: [returned] }, { file_path: "/not-read-from-disk/config.env", content }, "write"), status: "success" }).tabs[0];
	assert.deepEqual(page.diff, { filePath: "/not-read-from-disk/config.env", source: "write" });
	assert.equal(page.text, "--- /dev/null\n+++ written-content\n@@ -0,0 +1,3 @@\n+1|token=synthetic-visible\n+2|- existing literal minus\n+3|+ existing literal plus");
	assert.equal(page.rawText, `${returned}\n\n${content}`);
	assert.equal(page.presentation, "text");
	assert.equal(page.masked, false);
	assert.equal(page.truncated, false);
});

test("Write supports empty content, blank lines and missing final newline without inventing added lines", () => {
	for (const [content, expected] of [
		["", "@@ -0,0 +0,0 @@"],
		["\n", "@@ -0,0 +1,1 @@\n+1|"],
		["first\n\n", "@@ -0,0 +1,2 @@\n+1|first\n+2|"],
		["first", "@@ -0,0 +1,1 @@\n+1|first\n\\ No newline at end of file"],
	]) {
		const page = buildDetailModel(tool({ content: ["written"] }, { path: "output.txt", content }, "write")).tabs[0];
		assert.deepEqual(page.diff, { filePath: "output.txt", source: "write" });
		assert.equal(page.text, `--- /dev/null\n+++ written-content\n${expected}`);
		assert.equal(page.rawText, `written\n\n${content}`);
		assert.equal(page.truncated, false);
	}
});

test("failed, incomplete or content-less Write never invents a successful additions view", () => {
	const args = { path: "output.txt", content: "not written" };
	const returned = { content: ["native return"] };
	for (const request of [
		tool({ ...returned, isError: true }, args, "write"),
		{ ...tool(returned, args, "write"), status: "failed" },
		{ ...tool(returned, args, "write"), status: "running" },
		{ ...tool(returned, args, "write"), status: "pending" },
		tool({ ...returned, isPartial: true }, args, "write"),
		tool(undefined, args, "write"), tool(null, args, "write"),
		...[{ path: "output.txt" }, { content: null }, { content: 42 }, { content: { text: "not written" } }].map((args) => tool(returned, args, "write")),
		tool(returned, args, "custom_write"),
	]) {
		const page = buildDetailModel(request).tabs[0];
		assert.equal(page.diff, undefined);
		assert.doesNotMatch(page.text, /written-content|\+not written/);
		if (request.result != null) assert.equal(page.rawText, "native return");
	}
});

test("Write bounds its additions and shares Raw budgets fairly between return text and actual content", () => {
	for (const [returned, content] of [
		["warning\n".repeat(DETAIL_LIMITS.lines), "token=synthetic-visible\n"],
		["warning\n", "token=synthetic-visible\n".repeat(DETAIL_LIMITS.lines + 50)],
		["warning\n".repeat(DETAIL_LIMITS.lines), `${"x".repeat(500)}\n`.repeat(1000)],
		["warning\n", "x".repeat(DETAIL_LIMITS.characters * 2)],
	]) {
		const page = buildDetailModel(tool({ content: [returned] }, { content }, "write")).tabs[0];
		assert.equal(page.diff?.source, "write");
		assert.equal(page.truncated, true);
		assert.match(page.rawText, /^warning/);
		assert.ok(page.rawText.includes(content.slice(0, 100)));
		assert.ok(page.rawText.includes(DETAIL_TRUNCATION));
		assert.doesNotMatch(page.rawText, /\+\+\+ written-content|@@ -0,0/);
		for (const text of [page.text, page.rawText]) {
			assert.ok(text.length < DETAIL_LIMITS.characters + 200);
			assert.ok(text.split("\n").length <= DETAIL_LIMITS.lines + 1);
		}
	}
});

test("Write strips terminal controls from content and path without evaluating accessors", () => {
	const page = buildDetailModel(tool({ content: ["written"] }, {
		path: "file.txt\x1b]52;c;hidden\x07", content: "\x1b[31mBearer synthetic-visible\x1b[0m\r\n\x1b[2J",
	}, "write")).tabs[0];
	assert.equal(page.diff?.filePath, "file.txt");
	assert.equal(page.rawText, "written\n\nBearer synthetic-visible\n");
	assert.equal(page.text, "--- /dev/null\n+++ written-content\n@@ -0,0 +1,1 @@\n+1|Bearer synthetic-visible");
	let calls = 0;
	const forbidden = () => { calls++; throw new Error("must not execute"); };
	const args = Object.defineProperties({}, {
		content: { enumerable: true, get: forbidden }, path: { enumerable: true, get: forbidden },
	});
	assert.equal(buildDetailModel(tool({ content: ["native return"] }, args, "write")).tabs[0].diff, undefined);
	assert.equal(calls, 0);
});

test("Args exposes typed scalars, decoded multiline strings and structured nested values", () => {
	const input = { command: "first\n  second\nthird", count: 3, enabled: true, absent: null, nested: { names: ["one", "two"] }, list: [1, false] };
	const page = argsPage(input);
	assert.equal(page.presentation, "fields");
	const expected: DetailField[] = [
		{ key: "command", value: input.command, kind: "string" },
		{ key: "count", value: "3", kind: "number" },
		{ key: "enabled", value: "true", kind: "boolean" },
		{ key: "absent", value: "null", kind: "null" },
		{ key: "nested", value: JSON.stringify(input.nested, null, 2), kind: "json" },
		{ key: "list", value: JSON.stringify(input.list, null, 2), kind: "json" },
	];
	assert.deepEqual(page.fields, expected);
	assert.equal(page.rawText, JSON.stringify(input, null, 2));
	assert.equal(page.text, page.rawText);
	assert.equal(page.masked, false);
	assert.equal(page.truncated, false);
});

test("only a string Bash command carries a language hint from the same sanitized Args snapshot", () => {
	const command = "TOKEN=synthetic-visible\x1b]52;c;hidden\x07 printf '%s' \"$(whoami)\"\n# shell source";
	const page = argsPage({ command, description: "ordinary string", nested: { command: "not a shell field" } }, "bash");
	const snapshot = JSON.parse(page.rawText);
	assert.deepEqual(page.fields?.[0], { key: "command", kind: "string", value: snapshot.command, language: "bash" });
	assert.equal(snapshot.command, sanitizeDetailText(command, false));
	assert.ok(page.fields?.slice(1).every((field) => field.language === undefined));
	assert.equal(page.masked, false);
	for (const toolName of ["custom_tool", "read", "write"]) {
		assert.ok(argsPage({ command }, toolName).fields?.every((field) => field.language === undefined));
	}
	for (const command of [null, false, 123, { value: "echo test" }, ["echo"]]) {
		assert.equal(argsPage({ command }, "bash").fields?.[0].language, undefined);
	}
});

test("a large multiline Bash command remains typed source instead of a clipped JSON string", () => {
	const command = Array.from({ length: 400 }, (_, index) => `echo "line ${index}" # shell command`).join("\n");
	assert.ok(command.length > DETAIL_LIMITS.lineCharacters);
	const page = argsPage({ command, timeout: 60 }, "bash");
	assert.equal(page.presentation, "fields");
	assert.equal(page.fields?.find((field) => field.key === "command")?.value, command);
	assert.equal(page.fields?.find((field) => field.key === "command")?.language, "bash");
	assert.equal(JSON.parse(page.rawText).command, command);
	assert.equal(page.truncated, false);
});

test("credentials and token-like strings survive typed fields and Raw without mutating Args", () => {
	const input = {
		api_key: "synthetic-key-value", nested: { PASSWORD: "synthetic-password-value", normal: 2 },
		note: "Bearer synthetic-bearer-value", url: "https://name:synthetic-pass@example.test/?access_token=synthetic-query",
		pat: "ghp_synthetic12345", readable: "ordinary readable content", auth: "Basic synthetic-basic-value",
		private_key: "-----BEGIN PRIVATE KEY-----\nsynthetic-private-key\n-----END PRIVATE KEY-----",
		long: "abcdefghijklmnopqrstuvwxyz1234567890", jwt: "eyJsynthetic.payload.signature", key: "sk-synthetic12345",
	};
	const before = JSON.stringify(input);
	const page = argsPage(input);
	assert.equal(page.masked, false);
	assert.equal(page.truncated, false);
	assert.equal(page.presentation, "fields");
	assert.deepEqual(JSON.parse(page.rawText), input);
	assert.equal(page.text, page.rawText);
	for (const item of page.fields!) {
		assert.deepEqual(item.kind === "json" ? JSON.parse(item.value) : item.value, input[item.key as keyof typeof input]);
	}
	assert.equal(JSON.stringify(input), before);
});

test("masked stays false and literal safety markers do not imply truncation", () => {
	for (const args of [{ query: "clean", max: 10 }, { api_key: "[REDACTED]" }, { note: DETAIL_TRUNCATION }, { note: "token=synthetic-visible-value" }]) {
		const page = argsPage(args);
		assert.equal(page.masked, false);
		assert.equal(page.truncated, false);
		assert.deepEqual(JSON.parse(page.rawText), args);
	}
});

test("truncated Args never becomes a partial field list, and non-object Args stays JSON", () => {
	let deep: unknown = { kept: true };
	for (let i = 0; i < DETAIL_LIMITS.depth + 2; i++) deep = { nested: deep };
	for (const input of [{ first: 1, oversized: "x".repeat(DETAIL_LIMITS.characters * 2) }, deep, Array.from({ length: DETAIL_LIMITS.nodes + 10 }, () => 1)]) {
		const page = argsPage(input);
		assert.equal(page.truncated, true);
		assert.notEqual(page.presentation, "fields");
		assert.equal(page.fields, undefined);
		assert.ok(page.rawText.includes(DETAIL_TRUNCATION));
	}
	for (const input of [[1, 2], "plain scalar", 3, false, null]) {
		const page = argsPage(input);
		assert.equal(page.presentation, "json");
		assert.equal(page.fields, undefined);
		assert.equal(page.truncated, false);
		assert.deepEqual(JSON.parse(page.rawText), input);
	}
});

test("Metadata is optional and advanced, preserving the same credentials in normal and Raw views", () => {
	for (const details of [undefined, null, {}, [], ""]) {
		assert.deepEqual(buildDetailModel(tool({ content: ["done"], details })).tabs.map((tab) => tab.id), ["result", "args"]);
	}
	for (const details of [false, 0, { count: 2 }, { token: "synthetic-hidden" }]) {
		const model = buildDetailModel(tool({ content: ["done"], details }));
		const page = model.tabs[2];
		assert.equal(page.id, "details");
		assert.equal(page.label, "Metadata");
		assert.equal(page.advanced, true);
		assert.ok(model.tabs.slice(0, 2).every((tab) => !tab.advanced));
		assert.equal(page.presentation, "json");
		assert.equal(page.text, page.rawText);
		assert.deepEqual(JSON.parse(page.rawText), details);
		assert.equal(page.masked, false);
	}
});

test("details-only and empty results use concise structured fallback without a policy prelude", () => {
	const details = { exitCode: 2, explanation: "Not allowed", token: "synthetic-hidden" };
	const page = buildDetailModel(tool({ content: [{ type: "text", text: "" }], details })).tabs[0];
	assert.equal(page.presentation, "json");
	assert.deepEqual(JSON.parse(page.rawText), details);
	assert.equal(page.text, page.rawText);
	assert.equal(page.masked, false);
	assert.doesNotMatch(page.text, /Read-only|Structured details/);
	const empty = buildDetailModel(tool(undefined)).tabs[0];
	assert.equal(empty.presentation, "json");
	assert.match(JSON.parse(empty.rawText).message, /No result content/);
	const meaningful = { content: [], summary: "nothing matched", count: 0 };
	assert.deepEqual(JSON.parse(buildDetailModel(tool(meaningful)).tabs[0].rawText), meaningful);
});

test("whole JSON Result is pretty while Raw preserves original textual formatting and escaped data", () => {
	const data = { text: "line\r\n\x1b[31mred", token: "synthetic-original-result" };
	const raw = ` \n${JSON.stringify(data)}\n`;
	const page = buildDetailModel(native(raw)).tabs[0];
	assert.equal(page.presentation, "json");
	assert.equal(page.text, JSON.stringify(data, null, 2));
	assert.equal(page.rawText, raw);
	assert.equal(page.masked, false);
	assert.deepEqual(JSON.parse(page.text), data);
	const mixed = buildDetailModel(tool({ content: ['{"a":1}', '{"b":2}'] })).tabs[0];
	assert.equal(mixed.presentation, "text");
	assert.equal(mixed.text, '{"a":1}\n\n{"b":2}');
	assert.equal(mixed.rawText, mixed.text);
});

test("built-in source and logs remain literal even with clear Markdown syntax", () => {
	const text = "# heading\n```ts\nconst x = 1;\n```\n[link](https://example.test)";
	for (const toolName of ["read", "bash", "grep", "find", "ls", "edit", "write"]) {
		const page = buildDetailModel(native(text, toolName)).tabs[0];
		assert.equal(page.presentation, "text", toolName);
		assert.equal(page.text, text);
		assert.equal(page.rawText, text);
	}
});

test("Read selects Markdown only for known case-insensitive Markdown paths and keeps fences intact", () => {
	const text = "# Report\n\n```bash\nprintf 'token=synthetic-visible'\n```";
	for (const path of ["README.md", "guide.MARKDOWN", "components.Example.MdX"]) {
		for (const key of ["path", "file_path"]) {
			const page = buildDetailModel(tool({ content: [text] }, { [key]: path }, "read")).tabs[0];
			assert.equal(page.presentation, "markdown");
			assert.equal(page.text, text);
			assert.equal(page.rawText, text);
		}
	}
	for (const path of ["script.py", "src/markdown.ts", "README.md.bak", "notes.txt", "README"]) {
		assert.equal(buildDetailModel(tool({ content: [text] }, { path }, "read")).tabs[0].presentation, "text");
	}
	for (const text of ["plain Markdown paragraph", "{\"example\":true}"]) {
		const page = buildDetailModel(tool({ content: [text] }, { path: "guide.md" }, "read")).tabs[0];
		assert.equal(page.presentation, "markdown");
		assert.equal(page.rawText, text);
	}
});

test("custom results select Markdown for unambiguous common syntax and preserve original fences and Raw", () => {
	for (const text of [
		"# Report\nSome text", "```js\nconst value = 1;\n```", "~~~bash\nprintf 'hello'\n~~~",
		"[Documentation](https://example.test)", "- first\n- second", "* first\n* second", "+ first\n+ second",
		"1. First step\n2. Second step", "1) First step\n2) Second step", "> A quoted result", "**Important**", "__Important__",
		"A **bold** statement.", "| Name | Count |\n| :--- | ---: |\n| sample | 2 |",
		"Name | Count\n--- | ---\nsample | 2",
	]) {
		const page = buildDetailModel(native(text)).tabs[0];
		assert.equal(page.presentation, "markdown");
		assert.equal(page.text, text);
		assert.equal(page.rawText, text);
	}
	for (const text of ["Normal result", "a * b", "log # not a heading", "[not a link]", "prefix {\"id\":1}", "2 * 3", "-1 remaining", "x > y", "a**b**c", "| no separator |", "--- | ---"]) {
		assert.equal(buildDetailModel(native(text)).tabs[0].presentation, "text", text);
	}
});

test("ordered result blocks retain text and display only known attachment metadata", () => {
	const page = buildDetailModel(tool({ content: [
		{ type: "text", text: "first" },
		{ type: "image", mimeType: "image/png", data: "hidden-pixels" },
		{ type: "text", text: "middle" },
		{ type: "audio", name: "voice.wav", data: "hidden-audio" },
		{ type: "video", name: "movie.webm", source: { data: "hidden-video" } },
		{ type: "file", name: "report.pdf", data: "hidden-file" },
		{ type: "text", text: "last" },
	] })).tabs[0];
	const ordered = ["first", "image/png", "middle", "voice.wav", "movie.webm", "report.pdf", "last"];
	for (let i = 1; i < ordered.length; i++) assert.ok(page.rawText.indexOf(ordered[i - 1]) < page.rawText.indexOf(ordered[i]));
	assert.doesNotMatch(page.rawText, /hidden-pixels|hidden-audio|hidden-video|hidden-file/);
	assert.match(page.rawText, /encodedCharacters/);
	assert.equal(page.text, page.rawText);
	assert.equal(page.masked, false);
});

test("attachment-only fallback keeps details before attachments without dropping their order", () => {
	const page = buildDetailModel(tool({
		content: [{ type: "image", name: "first.png" }, { type: "file", name: "second.pdf" }],
		details: { report: "meaningful fallback", token: "synthetic-hidden" },
	})).tabs[0];
	assert.ok(page.rawText.indexOf("meaningful fallback") < page.rawText.indexOf("first.png"));
	assert.ok(page.rawText.indexOf("first.png") < page.rawText.indexOf("second.pdf"));
	assert.doesNotMatch(page.rawText, /Read-only/);
	assert.match(page.rawText, /synthetic-hidden/);
	assert.equal(page.masked, false);
});

test("unknown typed blocks and genuinely structured output retain meaningful safe JSON", () => {
	for (const value of [
		{ custom: { status: "done", rows: [1, 2] } },
		{ type: "resource", resource: { uri: "test://output", text: "IMPORTANT RESULT" } },
		{ type: "json", data: { status: "ready", value: 42 } },
	]) {
		for (const result of [value, { content: [value] }]) {
			const page = buildDetailModel(tool(result)).tabs[0];
			assert.equal(page.presentation, "json");
			assert.deepEqual(JSON.parse(page.rawText), value);
			assert.equal(page.masked, false);
		}
	}
	const value = { type: "resource", password: "synthetic-visible" };
	const page = buildDetailModel(tool(value)).tabs[0];
	assert.equal(page.masked, false);
	assert.deepEqual(JSON.parse(page.rawText), value);
});

test("titles contain only the safe bounded target, with separate status and timing", () => {
	const model = buildDetailModel({
		...tool({ isError: true }), target: "src/example\x1b]52;c;hidden\x07\nfile.ts", timing: "\x1b[31m1s\x1b[0m",
	});
	assert.equal(model.title, "src/example file.ts");
	assert.equal(model.failed, true);
	assert.equal(model.status, "failed");
	assert.equal(model.timing, "1s");
	assert.doesNotMatch(model.title, /Tools|Failed|1s|hidden|\x1b|\n/);
	const completed = buildDetailModel({ ...tool({}), status: "completed" });
	assert.equal(completed.title, "custom_tool");
	assert.equal(completed.status, "completed");
	assert.equal(completed.failed, false);
	assert.equal(completed.timing, undefined);
	assert.equal(buildDetailModel({ ...tool({}), status: "failure" }).failed, true);
	assert.ok(buildDetailModel({ ...tool({}), target: "x".repeat(DETAIL_LIMITS.characters * 2) }).title.length <= 160);
});

test("Steer has only a literal Result and sanitized original Raw, without status or tabs", () => {
	const text = '{"original":true}\nBearer synthetic-visible-value\x1b]52;c;hidden\x07';
	const model = buildDetailModel({ kind: "steer", text });
	assert.equal(model.title, "Steer");
	assert.equal(model.showTabs, false);
	assert.equal(model.failed, false);
	assert.equal(model.status, undefined);
	assert.equal(model.tabs.length, 1);
	assert.equal(model.tabs[0].id, "result");
	assert.equal(model.tabs[0].presentation, "text");
	assert.equal(model.tabs[0].text, sanitizeDetailText(text));
	assert.equal(model.tabs[0].rawText, sanitizeDetailText(text));
	assert.equal(model.tabs[0].masked, false);
});

test("structured snapshots omit cycles, accessors and methods without evaluating them", () => {
	let calls = 0;
	const forbidden = () => { calls++; throw new Error("must not execute"); };
	const input: Record<string, unknown> = { retained: 1, toJSON: forbidden };
	Object.defineProperty(input, "getter", { enumerable: true, get: forbidden });
	Object.defineProperty(input, "token", { enumerable: true, get: forbidden });
	input.self = input;
	const page = argsPage(input);
	assert.equal(page.presentation, "fields");
	const parsed = JSON.parse(page.rawText);
	assert.equal(parsed.retained, 1);
	assert.equal(parsed.self, "[Circular]");
	assert.equal(parsed.getter, "[Accessor omitted]");
	assert.equal(parsed.token, "[Accessor omitted]");
	assert.equal(parsed.toJSON, "[function]");
	assert.deepEqual(page.fields?.find((item) => item.key === "getter"), { key: "getter", kind: "string", value: "[Accessor omitted]" });
	const type = { toString: forbidden, toJSON: forbidden };
	buildDetailModel(tool({ content: [{ type, value: 42 }], details: input }, input));
	const array = ["first", "second"];
	Object.defineProperty(array, "0", { get: forbidden });
	buildDetailModel(tool({ content: array }));
	const bytes = new Uint8Array(4);
	Object.defineProperty(bytes, "byteLength", { get: forbidden });
	assert.match(formatDetailJson(bytes), /4 bytes/);
	assert.equal(calls, 0);
});

test("terminal controls stay inert in normal and Raw views, including decoded Args fields", () => {
	const text = "\x1b[31mred\x1b[0m\x1b]8;;https://example.test\x1b\\link\x1b]8;;\x1b\\" +
		"\x1b]52;c;clipboard\x07\x1b[2J\x1b[10;4H\x00\x07\u202evisible\r\nnext\x1bPunterminated";
	const result = buildDetailModel(native(text)).tabs[0];
	assert.equal(result.rawText, "\x1b[31mred\x1b[0mlinkvisible\nnext");
	assert.equal(result.text, result.rawText);
	const page = argsPage({ value: text });
	assert.equal(page.fields?.[0].value, "redlinkvisible\nnext");
	assert.doesNotMatch(page.rawText, /clipboard|unterminated|https|\x1b|\u202e/);
});

test("oversized source, long lines, many blocks and control-heavy inputs report bounded truncation", () => {
	for (const text of [
		"x".repeat(DETAIL_LIMITS.characters * 3),
		"line\n".repeat(DETAIL_LIMITS.lines + 100),
		"\x1b]52;c;" + "x".repeat(DETAIL_LIMITS.characters * 3),
	]) {
		const page = buildDetailModel(native(text)).tabs[0];
		assert.equal(page.truncated, true);
		assert.ok(page.rawText.includes(DETAIL_TRUNCATION));
		assert.ok(page.rawText.length < DETAIL_LIMITS.characters + 200);
		assert.ok(page.rawText.split("\n").length <= DETAIL_LIMITS.lines + 1);
		assert.doesNotMatch(page.rawText, /\x1b\]/);
	}
	const blocks = buildDetailModel(tool({ content: Array.from({ length: 10000 }, () => ({ type: "text", text: "" })) })).tabs[0];
	assert.equal(blocks.truncated, true);
	assert.ok(blocks.rawText.includes(DETAIL_TRUNCATION));
	const key = "\x00".repeat(DETAIL_LIMITS.characters * 2) + "password";
	const page = argsPage({ [key]: 123456789 });
	assert.equal(page.truncated, true);
	assert.equal(page.fields, undefined);
	assert.doesNotMatch(page.rawText, /123456789/);
});

test("exported JSON formatter boolean only controls string sanitization, never credentials", () => {
	const input = { token: "ghp_synthetic12345", value: "Bearer synthetic-visible\x1b[31mred\x1b[0m\r\nnext" };
	assert.deepEqual(JSON.parse(formatDetailJson(input)), { ...input, value: "Bearer synthetic-visiblered\nnext" });
	assert.deepEqual(JSON.parse(formatDetailJson(input, false)), input);
});

test("exported JSON formatter retains its string API and bounds bigint conversion", () => {
	assert.equal(typeof formatDetailJson({ count: 2 }), "string");
	assert.equal(JSON.parse(formatDetailJson(42n)), "42n");
	assert.ok(formatDetailJson(1n << 5000n).includes(DETAIL_TRUNCATION));
	const text = formatDetailJson({ long: "value".repeat(100) }, true, 32);
	assert.ok(text.length <= 32 + DETAIL_TRUNCATION.length + 1);
	assert.ok(text.includes(DETAIL_TRUNCATION));
});
