import { strict as assert } from "node:assert";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { KeybindingsManager } from "@earendil-works/pi-coding-agent";
import type { EditorTheme, TUI } from "@earendil-works/pi-tui";
import { defaultConfig } from "../config.js";
import { GlanceEditor } from "../editor.js";
import {
	INPUT_STASH_CONFIRM_WINDOW_MS,
	inputHasText,
	isInputStashConfirmArmed,
	resolveInputStashAction,
} from "../input-stash.js";
import { INPUT_STASH_MARK_FULL, INPUT_STASH_MARK_SHORT, resolveInputStashChrome } from "../input-stash-chrome.js";
import { createInputStashStore, getInputStashPath } from "../input-stash-store.js";
import { INPUT_STASH_CONFIRM_NOTIFY, INPUT_STASH_DISCARD_NOTIFY } from "../input-stash-runtime.js";
import { renderInputSurfaceFrame } from "../input-surface-frame.js";
import { resolveBuiltInGlanceStyles } from "../theme-adapter.js";
import { createGitHarness, createRuntimeHarness, createRuntimeTestContext } from "./runtime-harness.js";
import { onlySegments, richInputSurfaceState, stripAnsi } from "./surface-test-harness.js";

function assertAction(
	input: Parameters<typeof resolveInputStashAction>[0],
	expected: ReturnType<typeof resolveInputStashAction>,
	label: string,
): void {
	assert.equal(resolveInputStashAction(input), expected, label);
}

{
	assert.equal(inputHasText("draft"), true, "non-empty text should count as occupied");
	assert.equal(inputHasText("  draft  "), true, "padded text should still count as occupied");
	assert.equal(inputHasText(""), false, "empty string should count as empty");
	assert.equal(inputHasText("   \n\t"), false, "whitespace-only text should count as empty");
	assert.equal(inputHasText(undefined), false, "missing text should count as empty");

	assertAction({ editorHasText: true, slotHasContent: false, confirmArmed: false, key: "primary" }, "stash", "full editor and empty slot should stash");
	assertAction({ editorHasText: false, slotHasContent: true, confirmArmed: false, key: "primary" }, "restore", "empty editor and occupied slot should restore");
	assertAction({ editorHasText: true, slotHasContent: true, confirmArmed: false, key: "primary" }, "arm-confirm", "full editor and occupied slot should ask for confirmation first");
	assertAction({ editorHasText: true, slotHasContent: true, confirmArmed: true, key: "primary" }, "overwrite", "confirmed second press should overwrite the current editor");
	assertAction({ editorHasText: false, slotHasContent: false, confirmArmed: false, key: "primary" }, "noop", "empty editor and empty slot should do nothing");
	assertAction({ editorHasText: true, slotHasContent: true, confirmArmed: false, key: "secondary" }, "discard", "secondary key should discard an occupied slot");
	assertAction({ editorHasText: false, slotHasContent: false, confirmArmed: false, key: "secondary" }, "noop", "secondary key should do nothing when the slot is empty");
	assertAction({ editorHasText: true, slotHasContent: false, confirmArmed: true, key: "secondary" }, "noop", "secondary key should ignore an empty slot even if confirm is armed");

	assert.equal(isInputStashConfirmArmed(0, INPUT_STASH_CONFIRM_WINDOW_MS - 1), true, "confirm window should stay armed before it expires");
	assert.equal(isInputStashConfirmArmed(0, INPUT_STASH_CONFIRM_WINDOW_MS), false, "confirm window should expire at the timeout");
	assert.equal(isInputStashConfirmArmed(undefined, 0), false, "missing arm timestamp should not be armed");
}

{
	assert.equal(resolveInputStashChrome({ occupied: false, hasModeLabel: false, hasScrollIndicator: false }), "hidden", "empty slot should hide the stash mark");
	assert.equal(resolveInputStashChrome({ occupied: true, hasModeLabel: false, hasScrollIndicator: false }), "full", "occupied slot should use the full stash mark");
	assert.equal(resolveInputStashChrome({ occupied: true, hasModeLabel: true, hasScrollIndicator: false }), "short", "Bash label should shrink the stash mark");
	assert.equal(resolveInputStashChrome({ occupied: true, hasModeLabel: false, hasScrollIndicator: true }), "short", "scroll indicator should shrink the stash mark");
}

{
	const agentDir = await mkdtemp(join(tmpdir(), "pi-glance-input-stash-"));
	const sessionA = join(agentDir, "a.jsonl");
	const sessionB = join(agentDir, "b.jsonl");
	const path = getInputStashPath(agentDir);
	try {
		const store = createInputStashStore({ getAgentDir: () => agentDir });
		store.set(sessionA, "draft A");
		assert.equal(store.get(sessionA), "draft A", "store should persist the current draft for a session");
		store.set(sessionA, "draft A2");
		assert.equal(JSON.parse(await readFile(path, "utf8"))[sessionA], "draft A2", "store should overwrite the same session key");
		store.set(sessionB, "draft B");
		assert.equal(store.get(sessionB), "draft B", "store should keep other session drafts");
		store.set(undefined, "ephemeral");
		assert.equal(store.get(undefined), "ephemeral", "ephemeral drafts should stay in memory");
		assert.equal(JSON.parse(await readFile(path, "utf8")).undefined, undefined, "ephemeral drafts should not be written to disk");
		assert.equal(Object.keys(JSON.parse(await readFile(path, "utf8"))).includes(""), false, "ephemeral drafts should not use an empty disk key");
		store.clear(sessionA);
		assert.equal(store.get(sessionA), undefined, "clearing a session should drop that key");
		assert.equal(JSON.parse(await readFile(path, "utf8"))[sessionB], "draft B", "clearing one session should keep the others");
		store.clear(sessionB);
		await assert.rejects(readFile(path, "utf8"), /ENOENT/, "clearing the last session should delete the stash file");
		store.set(sessionA, "   ");
		assert.equal(store.has(sessionA), false, "whitespace should not occupy the slot");
		await assert.rejects(readFile(path, "utf8"), /ENOENT/, "whitespace should not create a stash file");

		await writeFile(path, "{", "utf8");
		store.refresh();
		assert.equal(store.get(sessionA), undefined, "unreadable stash files should behave like an empty slot");
	} finally {
		await rm(agentDir, { recursive: true, force: true });
	}
}

{
	const sessionFile = "/tmp/session.jsonl";
	const store = createInputStashStore({ persist: false });
	const test = createRuntimeTestContext({ sessionFile, editorText: "keep writing" });
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: defaultConfig(),
		git: createGitHarness(),
		createInputStashStore: () => store,
	});

	harness.runtime.events.sessionStart({}, test.ctx);
	harness.runtime.shortcuts.stashOrRestore(test.ctx);
	assert.equal(test.getEditorText(), "", "stash should clear the editor");
	assert.equal(store.get(sessionFile), "keep writing", "stash should keep the current draft in the slot");

	harness.runtime.shortcuts.stashOrRestore(test.ctx);
	assert.equal(test.getEditorText(), "keep writing", "empty editor should restore the slot");
	assert.equal(store.has(sessionFile), false, "restore should clear the slot");

	store.set(sessionFile, "stashed");
	test.setEditorText("current");
	harness.runtime.shortcuts.stashOrRestore(test.ctx);
	assert.equal(test.getEditorText(), "current", "first conflict press should leave the current editor alone");
	assert.equal(store.get(sessionFile), "stashed", "first conflict press should keep the slot");
	assert.equal(
		test.notifications.some((notification) => notification.message === INPUT_STASH_CONFIRM_NOTIFY && notification.type === "info"),
		true,
		"first conflict press should notify before overwriting",
	);

	harness.runtime.shortcuts.stashOrRestore(test.ctx);
	assert.equal(test.getEditorText(), "stashed", "confirmed second press should replace the current editor");
	assert.equal(store.has(sessionFile), false, "overwrite should clear the slot");

	store.set(sessionFile, "throw away");
	test.setEditorText("keep current");
	const notificationsBeforeDiscard = test.notifications.length;
	harness.runtime.shortcuts.discard(test.ctx);
	assert.equal(test.getEditorText(), "keep current", "discard should not change the editor");
	assert.equal(store.has(sessionFile), false, "discard should clear the slot");
	assert.equal(
		test.notifications.slice(notificationsBeforeDiscard).some((notification) => notification.message === INPUT_STASH_DISCARD_NOTIFY && notification.type === "info"),
		true,
		"discard should notify once",
	);

	test.setEditorText("   ");
	harness.runtime.shortcuts.stashOrRestore(test.ctx);
	assert.equal(test.getEditorText(), "   ", "whitespace-only editor text should not stash");
	assert.equal(store.has(sessionFile), false, "whitespace-only editor text should leave the slot empty");
}

{
	let nowMs = 0;
	const sessionFile = "/tmp/session.jsonl";
	const store = createInputStashStore({ persist: false });
	store.set(sessionFile, "stashed");
	const test = createRuntimeTestContext({ sessionFile, editorText: "current" });
	const harness = createRuntimeHarness({
		loadConfigSyncConfig: defaultConfig(),
		git: createGitHarness(),
		nowMs: () => nowMs,
		createInputStashStore: () => store,
	});
	harness.runtime.events.sessionStart({}, test.ctx);
	harness.runtime.shortcuts.stashOrRestore(test.ctx);
	nowMs = INPUT_STASH_CONFIRM_WINDOW_MS;
	harness.runtime.shortcuts.stashOrRestore(test.ctx);
	assert.equal(test.getEditorText(), "current", "an expired confirm window should not overwrite");
	assert.equal(store.get(sessionFile), "stashed", "an expired confirm window should keep the slot");
}

{
	const sessionFile = "/tmp/session.jsonl";
	const store = createInputStashStore({ persist: false });
	store.set(sessionFile, "restored draft");
	const empty = createRuntimeTestContext({ sessionFile, editorText: "  \n" });
	const emptyHarness = createRuntimeHarness({
		loadConfigSyncConfig: defaultConfig(),
		git: createGitHarness(),
		createInputStashStore: () => store,
	});
	emptyHarness.runtime.events.sessionStart({}, empty.ctx);
	assert.equal(empty.getEditorText(), "restored draft", "empty editor on session start should restore the slot");
	assert.equal(store.has(sessionFile), false, "session-start restore should clear the slot");

	store.set(sessionFile, "leave me");
	const occupied = createRuntimeTestContext({ sessionFile, editorText: "already typing" });
	const occupiedHarness = createRuntimeHarness({
		loadConfigSyncConfig: defaultConfig(),
		git: createGitHarness(),
		createInputStashStore: () => store,
	});
	occupiedHarness.runtime.events.sessionStart({}, occupied.ctx);
	assert.equal(occupied.getEditorText(), "already typing", "non-empty editor on session start should keep the current draft");
	assert.equal(store.get(sessionFile), "leave me", "non-empty editor on session start should leave the slot");
}

{
	const config = defaultConfig();
	config.editor.topMarginRows = 0;
	config.editor.minContentRows = 2;
	onlySegments(config, ["model"]);
	const state = richInputSurfaceState();
	const styles = resolveBuiltInGlanceStyles(config.theme.light);

	const occupied = stripAnsi(
		renderInputSurfaceFrame({
			state,
			config,
			width: 80,
			styles,
			body: { kind: "editor", lines: [""] },
			chrome: { stashOccupied: true },
		})[0] ?? "",
	);
	assert.ok(occupied.includes(INPUT_STASH_MARK_FULL), "occupied slot should show the short stash mark on the top border");
	assert.equal(occupied.includes("leave me"), false, "stash chrome should not preview the stored draft");

	const bash = stripAnsi(
		renderInputSurfaceFrame({
			state,
			config,
			width: 80,
			styles,
			body: { kind: "editor", lines: [""] },
			chrome: { stashOccupied: true, modeLabel: "Bash" },
		})[0] ?? "",
	);
	assert.ok(bash.includes(`Bash · ${INPUT_STASH_MARK_SHORT}`), "Bash label should keep the left slot and shrink the stash mark");
	assert.equal(bash.includes(INPUT_STASH_MARK_FULL), false, "Bash label should not keep the full stash word");

	const scrolled = stripAnsi(
		renderInputSurfaceFrame({
			state,
			config,
			width: 80,
			styles,
			body: { kind: "editor", lines: [""] },
			chrome: { stashOccupied: true, topScrollIndicator: "─── ↑ 7 more " },
		})[0] ?? "",
	);
	assert.ok(scrolled.includes(`─ ${INPUT_STASH_MARK_SHORT} `) && scrolled.includes("↑ 7 more"), "scroll indicator should keep the left slot and shrink the stash mark");
	assert.equal(scrolled.includes(INPUT_STASH_MARK_FULL), false, "scroll indicator should not keep the full stash word");

	const editor = new GlanceEditor(
		{ terminal: { rows: 40 }, requestRender: () => undefined } as unknown as TUI,
		{
			borderColor: (text: string) => text,
			selectList: {
				selectedPrefix: (text: string) => text,
				selectedText: (text: string) => text,
				description: (text: string) => text,
				scrollInfo: (text: string) => text,
				noMatch: (text: string) => text,
			},
		} as unknown as EditorTheme,
		{ matches: () => false } as unknown as KeybindingsManager,
		() => state,
		() => config,
		undefined,
		{ getStashOccupied: () => true },
	);
	editor.focused = true;
	editor.setText("draft");
	const liveTop = stripAnsi(editor.render(80).find((line) => line.includes("╭")) ?? "");
	assert.ok(liveTop.includes(INPUT_STASH_MARK_FULL), "live editor should show the stash mark from the occupied-slot fact");
}

console.log("✓ input stash checks passed");
