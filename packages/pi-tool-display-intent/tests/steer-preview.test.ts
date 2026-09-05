import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { layoutSteerPreview } from "../src/steer-preview.ts";

function numberedLines(count: number): string[] {
	return Array.from({ length: count }, (_, index) => `line ${index + 1}`);
}

function assertFits(rows: string[], width: number): void {
	for (const row of rows) {
		assert.ok(visibleWidth(row) <= width, `${JSON.stringify(row)} exceeds ${width} columns`);
		assert.doesNotMatch(row, /[\x00-\x1f\x7f-\x9f]/);
	}
}

test("eight body rows remain complete without omission metadata", () => {
	const lines = numberedLines(8);
	assert.deepEqual(layoutSteerPreview(lines.join("\n"), 80), {
		rows: lines,
		hiddenRows: 0,
	});
});

test("nine body rows keep the first three and last two with the exact hidden count", () => {
	const lines = numberedLines(9);
	const preview = layoutSteerPreview(lines.join("\n"), 80);
	assert.deepEqual(preview, {
		rows: ["line 1", "line 2", "line 3", "… 4 lines hidden · click to view", "line 8", "line 9"],
		hiddenRows: 4,
		omissionRow: 3,
	});
	assert.equal(preview.rows[preview.omissionRow!], "… 4 lines hidden · click to view");
});

test("the threshold counts wrapped display rows, not logical lines", () => {
	const text = "aabbccddeeffgghhii";
	assert.deepEqual(layoutSteerPreview(text, 2), {
		rows: ["aa", "bb", "cc", "… ", "hh", "ii"],
		hiddenRows: 4,
		omissionRow: 3,
	});
	assert.deepEqual(layoutSteerPreview(text, 3), {
		rows: ["aab", "bcc", "dde", "eff", "ggh", "hii"],
		hiddenRows: 0,
	});
});

test("eight soft-wrapped rows are not collapsed", () => {
	assert.deepEqual(layoutSteerPreview("aabbccddeeffgghh", 2), {
		rows: ["aa", "bb", "cc", "dd", "ee", "ff", "gg", "hh"],
		hiddenRows: 0,
	});
});

test("word wrapping uses the entire content width with no prefix budget", () => {
	assert.deepEqual(layoutSteerPreview("alpha beta gamma", 10), {
		rows: ["alpha beta", "gamma"],
		hiddenRows: 0,
	});
});

for (const [label, text, width, rows] of [
	["CJK", "你好世界", 4, ["你好", "世界"]],
	["emoji graphemes", "👩‍💻👍🏽🇨🇳🙂", 4, ["👩‍💻👍🏽", "🇨🇳🙂"]],
	["combining characters", "e\u0301e\u0301e\u0301", 2, ["e\u0301e\u0301", "e\u0301"]],
] as const) {
	test(`${label} wrap by terminal cells without splitting graphemes`, () => {
		const preview = layoutSteerPreview(text, width);
		assert.deepEqual(preview, { rows: [...rows], hiddenRows: 0 });
		assertFits(preview.rows, width);
	});
}

test("wide unicode contributes actual wrapped rows to the omission count", () => {
	const preview = layoutSteerPreview("甲乙丙丁戊己庚辛壬癸子丑寅卯辰巳午未", 4);
	assert.deepEqual(preview, {
		rows: ["甲乙", "丙丁", "戊己", "… 4 ", "辰巳", "午未"],
		hiddenRows: 4,
		omissionRow: 3,
	});
	assertFits(preview.rows, 4);
});

test("CRLF and CR normalize while indentation, internal spaces and blank lines survive", () => {
	const text = " \r\n\t\r  first  value  \r\n\r\n   \n\tsecond\tvalue \r\n\t";
	assert.deepEqual(layoutSteerPreview(text, 80), {
		rows: ["  first  value  ", "", "   ", "    second    value "],
		hiddenRows: 0,
	});
});

test("internal blank rows contribute to the collapse threshold and hidden count", () => {
	assert.deepEqual(layoutSteerPreview("first\n\n\n\n\n\n\n\nlast", 80), {
		rows: ["first", "", "", "… 4 lines hidden · click to view", "", "last"],
		hiddenRows: 4,
		omissionRow: 3,
	});
});

test("tabs expand to exactly four spaces before display wrapping", () => {
	assert.deepEqual(layoutSteerPreview("a\tb\n\tc", 6), {
		rows: ["a    b", "    c"],
		hiddenRows: 0,
	});
});

test("SGR, CSI, OSC hyperlinks and cursor commands cannot leak into preview rows", () => {
	const text = "\x1b[31mred\x1b[0m \x1b]8;;https://example.com\x07link\x1b]8;;\x1b\\"
		+ "\x1b[2J\x1b[?25l\x1b[12;3H\x1b7\x1b8\x1b(B!\x00\x08\x07\x7f";
	const preview = layoutSteerPreview(text, 80);
	assert.deepEqual(preview, { rows: ["red link!"], hiddenRows: 0 });
	assertFits(preview.rows, 80);
});

test("C1 sequences and terminal string payloads are removed, not shown as text", () => {
	const text = "a\x9b31mb\x9b0m\x9d0;title\x9cc"
		+ "\x1bPpayload\nmore\x1b\\d\x1b_pi:c\x1b\\e"
		+ "\x1b^private\x1b\\f\x1bXignored\x1b\\g";
	const preview = layoutSteerPreview(text, 80);
	assert.deepEqual(preview, { rows: ["abcdefg"], hiddenRows: 0 });
	assertFits(preview.rows, 80);
});

for (const sequence of ["\x1b]0;unterminated title", "\x1b[31;", "\x1b_unterminated marker", "\x1b"]) {
	test(`unfinished terminal sequence ${JSON.stringify(sequence)} is safe`, () => {
		assert.deepEqual(layoutSteerPreview(`body${sequence}`, 80), { rows: ["body"], hiddenRows: 0 });
	});
}

test("control-only edge lines are trimmed after sanitizing", () => {
	assert.deepEqual(layoutSteerPreview("\x1b[31m\nbody\n\x1b[0m", 80), {
		rows: ["body"], hiddenRows: 0,
	});
});

for (const width of [1, 2, 3, 8, 20]) {
	test(`omission label is a single discoverable row at width ${width}`, () => {
		const preview = layoutSteerPreview("a\nb\nc\nd\ne\nf\ng\nh\ni", width);
		assert.equal(preview.rows.length, 6);
		assert.equal(preview.hiddenRows, 4);
		assert.equal(preview.omissionRow, 3);
		assert.equal(preview.rows[preview.omissionRow!], "… 4 lines hidden · click to view".slice(0, width));
		assertFits(preview.rows, width);
	});
}

test("one-cell viewports replace unrepresentable wide graphemes without phantom rows", () => {
	const preview = layoutSteerPreview("你好🙂", 1);
	assert.deepEqual(preview, { rows: ["…", "…", "…"], hiddenRows: 0 });
	assertFits(preview.rows, 1);
});

for (const text of ["🙂".repeat(9), "甲乙丙丁戊己庚辛壬"]) {
	test(`one-cell unicode rows still have an exact hidden count for ${text}`, () => {
		const preview = layoutSteerPreview(text, 1);
		assert.deepEqual(preview, {
			rows: ["…", "…", "…", "…", "…", "…"],
			hiddenRows: 4,
			omissionRow: 3,
		});
	});
}

for (const width of [0, -1, NaN, Infinity, -Infinity, 0.5]) {
	test(`unusable width ${String(width)} returns an empty safe layout`, () => {
		assert.deepEqual(layoutSteerPreview("nonempty\nbody", width), { rows: [], hiddenRows: 0 });
	});
}

test("fractional widths use only whole terminal columns", () => {
	assert.deepEqual(layoutSteerPreview("abcdef", 2.9), {
		rows: ["ab", "cd", "ef"], hiddenRows: 0,
	});
});

for (const text of ["", " \t\r\n\r ", "\x1b[31m\x1b[0m", "\x1b]title\x07"]) {
	test(`empty display content ${JSON.stringify(text)} has no rows or omission`, () => {
		assert.deepEqual(layoutSteerPreview(text, 80), { rows: [], hiddenRows: 0 });
	});
}

test("large input retains only the preview head and tail but counts all omitted rows", () => {
	const preview = layoutSteerPreview(numberedLines(20_000).join("\n"), 80);
	assert.deepEqual(preview, {
		rows: ["line 1", "line 2", "line 3", "… 19995 lines hidden · click to view", "line 19999", "line 20000"],
		hiddenRows: 19_995,
		omissionRow: 3,
	});
});
