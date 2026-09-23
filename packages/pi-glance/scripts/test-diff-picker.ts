import { strict as assert } from "node:assert";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { CURSOR_MARKER, KeybindingsManager, TUI_KEYBINDINGS, visibleWidth } from "@earendil-works/pi-tui";
import { DiffRevisionPicker, filterDiffRevisions, type DiffRevisionChoice } from "../diff-picker.js";
import type { DiffRevisionCandidate } from "../diff-target.js";

const candidates: DiffRevisionCandidate[] = [
	{ name: "feature/parser", ref: "refs/heads/feature/parser", sha: "a".repeat(40), subject: "Handle escaped input", kind: "branch" },
	{ name: "v2", ref: "refs/tags/v2", sha: "b".repeat(40), subject: "Release search", kind: "tag" },
	{ name: "cccccccccccc", ref: "c".repeat(40), sha: "c".repeat(40), subject: "Fix Search results", kind: "commit" },
];
assert.deepEqual(filterDiffRevisions(candidates, "PARSER"), [candidates[0]], "name matching should be case-insensitive substring search");
assert.deepEqual(filterDiffRevisions(candidates, "bbbbbb"), [candidates[1]], "SHA fragments should match");
assert.deepEqual(filterDiffRevisions(candidates, "fix results"), [candidates[2]], "commit subjects should match multiple search terms");
assert.deepEqual(filterDiffRevisions(candidates, "nothing"), []);
const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text } as Theme;
const keys = new KeybindingsManager(TUI_KEYBINDINGS);
function picker(items = candidates) {
	const results: Array<DiffRevisionChoice | undefined> = [];
	const component = new DiffRevisionPicker("Compare — from", items, theme, keys, (result) => results.push(result), () => {});
	return { component, results };
}
{
	const { component, results } = picker();
	component.handleInput("\x1b[B");
	component.handleInput("\r");
	assert.deepEqual(results, [{ ref: candidates[1]!.sha, label: "v2" }], "down/enter must select the candidate's captured object ID, not a moving branch name");
}
{
	const { component, results } = picker();
	component.handleInput("results");
	component.handleInput("\r");
	assert.deepEqual(results, [{ ref: candidates[2]!.sha, label: candidates[2]!.name }], "typing must filter rather than navigate the list");
}
{
	const { component, results } = picker();
	component.handleInput("HEAD~12");
	component.handleInput("\x1b[D");
	component.handleInput("\x7f");
	component.handleInput("\r");
	assert.deepEqual(results, [{ ref: "HEAD~2", label: "HEAD~2" }], "left and backspace must edit Input, not control the list");
}
{
	const { component, results } = picker();
	component.handleInput("\x1b[200~HEAD");
	component.handleInput("\r");
	assert.deepEqual(results, [], "an Enter inside a split paste must never submit");
	component.handleInput("~1\x1b[201~");
	component.handleInput("\r");
	assert.deepEqual(results, [{ ref: "HEAD~1", label: "HEAD~1" }], "Input should normalize paste and retain the typed-ref action");
}
{
	const { component, results } = picker();
	component.handleInput("v2");
	component.handleInput("\x1b[A");
	component.handleInput("\r");
	assert.deepEqual(results, [{ ref: "v2", label: "v2" }], "typed-ref action should remain available even when candidates match");
}
{
	const { component, results } = picker([]);
	component.handleInput("\r");
	assert.deepEqual(results, [], "empty input must not create an empty-ref action");
	component.handleInput("\x1b");
	assert.deepEqual(results, [undefined], "Escape must cancel without selecting a ref");
}
{
	const { component } = picker([{ ...candidates[0]!, name: "long-分支".repeat(40), subject: "topic".repeat(80) }]);
	component.focused = true;
	assert.ok(component.render(80).some((line) => line.includes(CURSOR_MARKER)), "focus must reach Input so Pi can position the IME cursor");
	component.focused = false;
	assert.ok(component.render(80).every((line) => !line.includes(CURSOR_MARKER)), "unfocused picker must not claim the cursor");
	for (const width of [1, 2, 4, 10, 40, 80]) {
		assert.ok(component.render(width).every((line) => visibleWidth(line) <= width), `picker must respect ${width} columns`);
	}
}
console.log("✓ diff picker filtering, paste, navigation, cancellation, focus and width checks passed");
