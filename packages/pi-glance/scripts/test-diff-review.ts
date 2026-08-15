import { strict as assert } from "node:assert";
import type { SpawnSyncReturns } from "node:child_process";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import {
	buildRevdiffArguments,
	classifyRevdiffResult,
	handleDiffCommand,
	reviewWorkingTreeWithRevdiff,
	type DiffReviewAdapters,
	type RevdiffProcessResult,
} from "../diff-review.js";
import { createGitHarness, createRuntimeHarness, createRuntimeTestContext } from "./runtime-harness.js";

assert.deepEqual(buildRevdiffArguments("/tmp/review.md"), ["--output=/tmp/review.md"], "default review should pass only an annotations output path");

const outcomes: Array<{ process: RevdiffProcessResult; annotations: string; kind: string }> = [
	{ process: { status: 0, signal: null }, annotations: "", kind: "clean" },
	{ process: { status: 10, signal: null }, annotations: "## src/a.ts:1 (+)\nFix this", kind: "annotations" },
	{ process: { status: 130, signal: null }, annotations: "", kind: "cancelled" },
	{ process: { status: null, signal: "SIGINT" }, annotations: "", kind: "cancelled" },
	{ process: { status: 2, signal: null }, annotations: "", kind: "error" },
	{ process: { status: 10, signal: null }, annotations: "", kind: "error" },
	{ process: { status: null, signal: null, error: new Error("missing loader") }, annotations: "", kind: "error" },
];
for (const outcome of outcomes) {
	assert.equal(classifyRevdiffResult(outcome.process, outcome.annotations).kind, outcome.kind, `status ${outcome.process.status} should classify as ${outcome.kind}`);
}

interface FakeContextResult {
	ctx: ExtensionCommandContext;
	calls: string[];
	notifications: Array<{ message: string; type?: string }>;
	editorText: string | undefined;
}

function createContext(mode: "tui" | "rpc" = "tui"): FakeContextResult {
	const calls: string[] = [];
	const notifications: Array<{ message: string; type?: string }> = [];
	let editorText: string | undefined;
	const ctx = {
		mode,
		hasUI: true,
		cwd: "/fallback",
		sessionManager: { getCwd: () => "/repo" },
		ui: {
			custom: async <T>(factory: (tui: unknown, theme: unknown, keybindings: unknown, done: (value: T) => void) => unknown): Promise<T> => {
				let result: T | undefined;
				const tui = {
					stop: () => calls.push("stop"),
					start: () => calls.push("start"),
					requestRender: (force?: boolean) => calls.push(`render:${String(force)}`),
				};
				factory(tui, {}, {}, (value) => {
					result = value;
				});
				assert.notEqual(result, undefined, "custom terminal handoff should finish synchronously after revdiff exits");
				return result!;
			},
			setEditorText: (text: string) => {
				editorText = text;
			},
			notify: (message: string, type?: string) => notifications.push({ message, type }),
		},
	} as unknown as ExtensionCommandContext;
	return { ctx, calls, notifications, get editorText() { return editorText; } };
}

function adaptersFor(status: number, annotations: string, record: string[]): DiffReviewAdapters {
	return {
		resolveBinary: () => "/fake/revdiff",
		makeTempDirectory: async () => "/fake/review-dir",
		readAnnotations: async (path) => {
			record.push(`read:${path}`);
			return annotations;
		},
		removeTempDirectory: async (path) => {
			record.push(`remove:${path}`);
		},
		writeTerminal: (text) => record.push(`terminal:${JSON.stringify(text)}`),
		spawn: ((_binary: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
			record.push(`spawn:${args.join("|")}:${options.cwd}:${options.env?.REVDIFF_EXIT_CODE_ON_ANNOTATIONS}`);
			return { status, signal: null, error: undefined } as SpawnSyncReturns<Buffer>;
		}) as never,
	};
}

{
	const test = createContext("rpc");
	const result = await reviewWorkingTreeWithRevdiff(test.ctx, "/repo", { resolveBinary: () => "/fake/revdiff" });
	assert.equal(result.kind, "unsupported", "non-TUI review should safely decline terminal handoff");
	assert.deepEqual(test.calls, [], "non-TUI review should not touch TUI lifecycle methods");
}

{
	const test = createContext();
	const result = await reviewWorkingTreeWithRevdiff(test.ctx, "/repo", { resolveBinary: () => undefined });
	assert.equal(result.kind, "missing", "missing revdiff should be isolated to the command result");
	assert.match(result.kind === "missing" ? result.message : "", /brew install umputun\/apps\/revdiff/, "missing revdiff should provide an actionable install hint");
	assert.deepEqual(test.calls, [], "missing revdiff should not stop the TUI or allocate review resources");
}

{
	const test = createContext();
	const result = await handleDiffCommand(test.ctx, {
		resolveBinary: () => "/fake/revdiff",
		makeTempDirectory: async () => { throw new Error("read-only tmp"); },
	});
	assert.equal(result.kind, "error", "temporary directory failure should become a classified command error");
	assert.match(result.kind === "error" ? result.message : "", /Failed to create revdiff temporary directory/, "temporary directory failure should preserve actionable context");
	assert.equal(test.notifications.at(-1)?.type, "error", "temporary directory failure should notify the user instead of rejecting silently");
	assert.deepEqual(test.calls, [], "temporary directory failure should occur before terminal handoff");
}

{
	const record: string[] = [];
	const test = createContext();
	const annotations = "## src/a.ts:4 (+)\nPlease simplify this branch.";
	const result = await handleDiffCommand(test.ctx, adaptersFor(10, annotations, record));
	assert.deepEqual(test.calls, ["stop", "start", "render:true"], "review should stop, restart, and force-render the TUI in order");
	assert.equal(result.kind, "annotations", "exit code 10 with annotations should request changes");
	assert.equal(test.editorText, annotations, "annotations should be loaded into the editor for user confirmation");
	assert.equal(test.notifications.at(-1)?.type, "info", "annotation handoff should notify without sending to the agent");
	assert.ok(record.includes("spawn:--output=/fake/review-dir/annotations.md:/repo:true"), "revdiff should run default uncommitted review in repository cwd with annotation exit semantics");
	assert.equal(record.at(-1), "remove:/fake/review-dir", "temporary review resources should be removed after annotation handoff");
}

{
	const record: string[] = [];
	const test = createContext();
	const result = await handleDiffCommand(test.ctx, adaptersFor(130, "", record));
	assert.equal(result.kind, "cancelled", "exit 130 should be treated as cancellation rather than failure");
	assert.equal(test.editorText, undefined, "cancelled review should not overwrite the editor");
	assert.equal(test.notifications.at(-1)?.type, "info", "cancelled review should use an informational notification");
	assert.equal(record.at(-1), "remove:/fake/review-dir", "cancelled review should still clean temporary resources");
}

{
	const git = createGitHarness();
	const test = createRuntimeTestContext();
	let reviewCalls = 0;
	const harness = createRuntimeHarness({
		git,
		reviewWorkingTree: async () => {
			reviewCalls++;
			throw new Error("review failed");
		},
	});
	harness.runtime.events.sessionStart({}, test.ctx);
	const baseline = git.schedules.length;
	await assert.rejects(harness.runtime.commands.openDiff("", test.ctx), /review failed/, "runtime should preserve review errors");
	assert.equal(reviewCalls, 1, "runtime /diff command should call the narrow review adapter once");
	assert.deepEqual(git.schedules.slice(baseline), [true], "runtime should immediately recalibrate Git after every review exit, including errors");
}

console.log("✓ revdiff missing, cancellation, annotations, cleanup, and runtime refresh checks passed");
