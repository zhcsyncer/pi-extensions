import { strict as assert } from "node:assert";
import { visibleWidth } from "@earendil-works/pi-tui";
import { GlanceEditor } from "../editor.js";
import { createDiffCommandHandler } from "../diff-review.js";
import { defaultConfig } from "../config.js";
import { createDiffFixture } from "./diff-fixture.js";
import { createGitHarness, createRuntimeHarness, createRuntimeTestContext, runtimeGitSnapshot } from "./runtime-harness.js";
import { stripAnsi } from "./surface-test-harness.js";

const fixture = await createDiffFixture();
try {
	await fixture.commit("Initial");
	const git = createGitHarness();
	const test = createRuntimeTestContext({ cwd: fixture.cwd, editorText: "unfinished draft" });
	test.ctx.isIdle = () => true;
	const config = defaultConfig();
	const calls: string[] = [];
	let lookups = 0;
	let throwFromAdapter = false;
	const handler = createDiffCommandHandler({ resolveBinary: () => { lookups++; return undefined; } });
	let lastReview: Promise<unknown> | undefined;
	const harness = createRuntimeHarness({ git, loadConfigSyncConfig: config, reviewDiff: (args, ctx) => {
		calls.push(args);
		lastReview = throwFromAdapter ? Promise.reject(new Error("click review failure")) : handler(args, ctx);
		return lastReview;
	} });
	function install() {
		harness.runtime.events.sessionStart({}, test.ctx);
		git.options!.onSnapshot(fixture.cwd, runtimeGitSnapshot());
		const factory = test.editorFactories.at(-1)!;
		const tui = { mode: "fullscreen", terminal: { rows: 40, columns: 120 }, requestRender() {} };
		const editor = factory(tui, {
			borderColor: (s: string) => s,
			selectList: { selectedPrefix: (s: string) => s, selectedText: (s: string) => s, description: (s: string) => s, scrollInfo: (s: string) => s, noMatch: (s: string) => s },
		}, { matches: () => false });
		assert.ok(editor instanceof GlanceEditor);
		editor.focused = true;
		return editor;
	}
	function click(editor: GlanceEditor) {
		const lines = editor.render(120);
		const row = lines.findIndex((line) => stripAnsi(line).includes(" ›"));
		assert.ok(row >= 0, "runtime-installed fullscreen editor should expose a worktree link");
		const plain = stripAnsi(lines[row]!);
		const x = visibleWidth(plain.slice(0, plain.indexOf("Δ")));
		editor.handleMouse({ type: "click", button: "left", x, y: row, screenX: x, screenY: row + 5, width: 120, height: lines.length, ctrl: false, alt: false, shift: false });
	}
	const settle = async () => { await lastReview?.catch(() => undefined); await Promise.resolve(); };
	const editor = install();
	click(editor);
	await settle();
	assert.deepEqual(calls, ["worktree"], "click should directly invoke worktree review, not a slash menu or a model message");
	assert.equal(lookups, 1);
	assert.equal(test.getEditorText(), "unfinished draft");

	// Keep the slash menu open while clicking the editor: both paths must share one handler's gate.
	let release!: (value: string | undefined) => void;
	let entered!: () => void;
	const ready = new Promise<void>((resolve) => { entered = resolve; });
	test.ctx.ui.select = async () => { entered(); return new Promise((resolve) => { release = resolve; }); };
	const slash = harness.runtime.commands.openDiff("", test.ctx);
	await ready;
	click(editor);
	await settle();
	assert.equal(lookups, 1, "a click while slash review is selecting must not launch a second review");
	assert.ok(test.notifications.some((notice) => /already open/.test(notice.message)));
	release(undefined);
	await slash;
	test.ctx.isIdle = () => false;
	click(editor);
	await settle();
	assert.equal(lookups, 1, "click must respect the agent busy guard");
	test.ctx.isIdle = () => true;

	throwFromAdapter = true;
	const schedules = git.schedules.length;
	click(editor);
	await settle();
	assert.ok(test.notifications.some((notice) => /click review failure/.test(notice.message)), "callback rejection should notify rather than become an unhandled rejection");
	assert.equal(git.schedules.length, schedules + 1, "click errors should still refresh Git");
	throwFromAdapter = false;

	const before = calls.length;
	const next = install();
	click(editor);
	await settle();
	assert.equal(calls.length, before, "old editor callback must not act in a new UI generation");
	click(next);
	await settle();
	assert.equal(calls.length, before + 1);
	const gitSegment = config.segments.find((segment) => segment.id === "git")!;
	gitSegment.enabled = false;
	assert.equal(next.render(120).some((line) => stripAnsi(line).includes(" ›")), false, "disabled Git must remove the clickable summary");
	await harness.runtime.commands.openDiff("worktree", test.ctx);
	assert.equal(calls.length, before + 1, "disabled Git also blocks the common review entrypoint");
	assert.equal(test.getEditorText(), "unfinished draft");
} finally {
	await fixture.cleanup();
}
console.log("✓ worktree click runtime sharing, busy/reentry/generation guards, errors and draft preservation passed");
