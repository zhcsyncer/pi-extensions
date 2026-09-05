import assert from "node:assert/strict";
import test from "node:test";
import { visibleWidth } from "@earendil-works/pi-tui";
import { buildDetailModel, sanitizeDetailText, DETAIL_LIMITS, DETAIL_TRUNCATION, type DetailRequest } from "../src/detail-viewer-model.ts";
import { DetailViewer } from "../src/detail-viewer.ts";
import { createDetailDiffRenderer } from "../src/detail-diff.ts";

const diff = "--- a/config.ts\n+++ b/config.ts\n@@ -41,3 +41,3 @@\n const options = {\n-  wrap: false,\n+  wrap: true,\n };";
const request = (overrides: Partial<Extract<DetailRequest, { kind: "tool" }>> = {}): DetailRequest => ({
	kind: "tool", toolName: "edit", args: { path: "/not-read-from-disk/config.ts" },
	result: { content: [{ type: "text", text: "Successfully replaced text" }], details: { diff } },
	...overrides,
});
const plain = (lines: string[]) => lines.map((line) => sanitizeDetailText(line, false)).join("\n");

function viewer(input = request(), height = 30) {
	return new DetailViewer(buildDetailModel(input), { getHeight: () => height, onClose() {}, onRender() {} });
}

test("Edit Result is the diff, with the original return accessible in Raw mode", () => {
	const input = request();
	const before = structuredClone(input);
	const model = buildDetailModel(input);
	assert.deepEqual(model.tabs.map((tab) => tab.id), ["result", "args", "details"]);
	assert.equal(model.tabs[0].text, diff);
	assert.equal(model.tabs[0].diff?.filePath, "/not-read-from-disk/config.ts");
	assert.match(model.tabs[0].rawText, /Successfully replaced text/);
	assert.deepEqual(input, before);
	const component = viewer(input);
	const shown = plain(component.render(90));
	assert.match(shown, /\[Result\]/);
	assert.doesNotMatch(shown, /\[Diff\]/);
	assert.match(shown, /\+1\b.*-1\b/);
	assert.match(shown, /wrap: false/);
	assert.match(shown, /wrap: true/);
	assert.doesNotMatch(shown, /Ctrl\+O to expand/);
	component.handleInput("r");
	assert.match(plain(component.render(90)), /\[Raw\][\s\S]*Successfully replaced text/);
	component.handleInput("r");
	assert.match(plain(component.render(90)), /wrap: false/);
	component.handleInput("\t");
	assert.match(plain(component.render(90)), /\[Args\]/);
});

test("failed Edit keeps the error as the default instead of implying a patch was applied", () => {
	const model = buildDetailModel(request({ result: { isError: true, content: [{ type: "text", text: "Could not match old text" }], details: { diff } } }));
	assert.equal(model.tabs[0].id, "result");
	assert.equal(model.tabs.some((tab) => tab.diff !== undefined), false);
	assert.match(model.tabs[0].text, /Could not match old text/);
});

test("Edit without returned diff never invents a patch from arguments", () => {
	for (const payload of [undefined, "", "  ", { old: "old", new: "new" }]) {
		const model = buildDetailModel(request({
			args: { path: "/not-read-from-disk/config.ts", oldText: "old", newText: "new" },
			result: { content: [{ type: "text", text: "Edited" }], details: { diff: payload } },
		}));
		assert.equal(model.tabs[0].id, "result");
		assert.equal(model.tabs.some((tab) => tab.diff !== undefined), false);
	}
});

test("a custom tool's diff-named metadata is not guessed to be an Edit result", () => {
	assert.equal(buildDetailModel(request({ toolName: "custom_probe" })).tabs[0].id, "result");
});

test("Diff snapshots strip terminal controls and never evaluate metadata getters", () => {
	let evaluated = false;
	const model = buildDetailModel(request({ result: { details: { get diff() { evaluated = true; return diff; } } } }));
	assert.equal(evaluated, false);
	assert.equal(model.tabs[0].id, "result");
	const sanitized = buildDetailModel(request({ result: { details: { diff: `${diff}\x1b]52;c;clipboard\x07` } } }));
	assert.equal(sanitized.tabs[0].text, diff);
});

test("Diff snapshots keep the same explicit safety limits as other viewer pages", () => {
	const model = buildDetailModel(request({ result: { details: { diff: `@@ -1 +1 @@\n-${"x".repeat(200_000)}` } } }));
	assert.equal(model.tabs[0].id, "result");
	assert.ok(model.tabs[0].diff);
	assert.match(model.tabs[0].text, /Truncated/);
	assert.ok(model.tabs[0].text.length <= DETAIL_LIMITS.characters + DETAIL_TRUNCATION.length + 100);
});

test("the popup uses single-column wrapping without repeating line numbers on continuation rows", () => {
	const payload = "@@ -17 +17 @@\n-" + "old ".repeat(25) + "OLD_END\n+" + "new ".repeat(25) + "NEW_END";
	const renderer = createDetailDiffRenderer(payload, undefined);
	const lines = renderer.render(42);
	const shown = plain(lines);
	assert.match(shown, /OLD_END/);
	assert.match(shown, /NEW_END/);
	assert.equal(shown.split("\n").filter((line) => /^\s*17\s+│/.test(line)).length, 2);
	assert.match(shown, /│-/);
	assert.match(shown, /│\+/);
	assert.ok(lines.every((line) => visibleWidth(line) <= 42));
	const wide = plain(renderer.render(160));
	assert.match(wide, /OLD_END/);
	assert.match(wide, /NEW_END/);
	assert.equal(wide.split("\n").filter((line) => /^\s*17\s+│/.test(line)).length, 2);
});

test("Diff pages scroll, reflow on resize and remain bounded by the popup viewport", () => {
	const changes = Array.from({ length: 25 }, (_, index) => `-old ${index}\n+new ${index}`).join("\n");
	const component = viewer(request({ result: { details: { diff: `@@ -1,25 +1,25 @@\n${changes}` } } }), 12);
	assert.match(plain(component.render(60)), /\[Result\]/);
	component.handleInput("\x1b[F");
	assert.match(plain(component.render(60)), /new 24/);
	for (const width of [24, 40, 100]) {
		const lines = component.render(width);
		assert.ok(lines.length <= 12);
		assert.ok(lines.every((line) => visibleWidth(line) <= width));
	}
	component.handleInput("\x1b[H");
	assert.match(plain(component.render(60)), /\+25\b.*-25\b/);
});
