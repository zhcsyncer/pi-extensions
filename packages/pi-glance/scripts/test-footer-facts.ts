import { strict as assert } from "node:assert";
import type { ReadonlyFooterDataProvider, Theme } from "@earendil-works/pi-coding-agent";
import { renderExtensionStatusLine, StatusOnlyFooter } from "../footer.js";
import { INPUT_STASH_STATUS_KEY } from "../input-stash.js";
import { setProviderCount } from "../state.js";
import type { GlanceState } from "../types.js";
import { testState } from "./helpers.js";

function providerState(availableCount: number, version = 0): GlanceState {
	return testState({ providers: { availableCount }, version });
}

function fakeTheme(): Theme {
	return {
		fg: (_color: string, text: string) => text,
		bold: (text: string) => text,
	} as unknown as Theme;
}

function footerData(statuses: ReadonlyMap<string, string> = new Map()): ReadonlyFooterDataProvider {
	return {
		getGitBranch: () => null,
		getExtensionStatuses: () => statuses,
		getAvailableProviderCount: () => 1,
		onBranchChange: () => () => {},
	};
}

{
	const state = providerState(2, 7);
	assert.equal(setProviderCount(state, 2), false, "same provider count should report no change");
	assert.equal(state.providers.availableCount, 2, "same provider count should preserve availableCount");
	assert.equal(state.version, 7, "same provider count should not bump version");
}

{
	const state = providerState(2, 7);
	assert.equal(setProviderCount(state, 3), true, "different provider count should report changed");
	assert.equal(state.providers.availableCount, 3, "different provider count should update availableCount");
	assert.equal(state.version, 8, "different provider count should bump version once");
	assert.equal(setProviderCount(state, 3), false, "repeated same provider count should report no change");
	assert.equal(state.version, 8, "repeated same provider count should not bump version again");
}

{
	const statuses = new Map([
		["z-last", "  indexing\nfiles  "],
		["a-first", "permission strict"],
	]);
	assert.equal(
		renderExtensionStatusLine(statuses, 80, fakeTheme()),
		"permission strict indexing files",
		"extension statuses should be sorted, sanitized, and retained",
	);
}

{
	const footer = new StatusOnlyFooter({ theme: fakeTheme(), footerData: footerData() });
	assert.deepEqual(footer.render(80), [], "footer should remain empty when no extension status exists");
	assert.doesNotThrow(() => footer.invalidate(), "footer invalidate should be a no-op");
	assert.doesNotThrow(() => footer.dispose(), "footer dispose should be a no-op");
}

{
	const statuses = new Map([ ["todo", "3 tasks pending"] ]);
	const footer = new StatusOnlyFooter({ theme: fakeTheme(), footerData: footerData(statuses) });
	assert.deepEqual(footer.render(80), ["3 tasks pending"], "footer should preserve extension statuses without optional Pi informational rows");
}

{
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => text,
	} as unknown as Theme;
	const statuses = new Map([
		[INPUT_STASH_STATUS_KEY, "Press again to discard “throw away”"],
		["todo", "3 tasks pending"],
	]);
	assert.equal(
		renderExtensionStatusLine(statuses, 80, theme),
		"<warning>Press again to discard “throw away”</warning> 3 tasks pending",
		"input-stash confirm prompts should use warning color in the footer",
	);
}

{
	const theme = {
		fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
		bold: (text: string) => text,
	} as unknown as Theme;
	const statuses = new Map([
		["fast-mode", "fast: on · Ctrl+F"],
		[INPUT_STASH_STATUS_KEY, "Press again to discard “throw away”"],
	]);
	assert.equal(
		renderExtensionStatusLine(statuses, 80, theme),
		"<warning>Press again to discard “throw away”</warning> fast: on · Ctrl+F",
		"input-stash confirm prompts should stay left of other extension statuses",
	);
}

console.log("✓ status-only footer checks passed");
