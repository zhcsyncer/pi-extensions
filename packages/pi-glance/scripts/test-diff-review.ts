import { strict as assert } from "node:assert";
import type { SpawnSyncReturns } from "node:child_process";
import type { ExtensionCommandContext, Theme } from "@earendil-works/pi-coding-agent";
import { KeybindingsManager, TUI_KEYBINDINGS, type Component } from "@earendil-works/pi-tui";
import {
	buildRevdiffArguments, classifyRevdiffResult, createDiffCommandHandler, reviewDiffWithRevdiff,
	type DiffReviewAdapters, type RevdiffProcessResult,
} from "../diff-review.js";
import type { DiffTarget } from "../diff-target.js";
import { defaultConfig } from "../config.js";
import { createDiffFixture } from "./diff-fixture.js";
import { createGitHarness, createRuntimeHarness, createRuntimeTestContext } from "./runtime-harness.js";

const worktree: DiffTarget = { revisions: [], includeUntracked: true, description: "Working tree" };
assert.deepEqual(buildRevdiffArguments("/tmp/review.md", worktree, "/tmp/config"), ["--output=/tmp/review.md", "--description=Working tree", "--config=/tmp/config"]);
const outcomes: Array<{ process: RevdiffProcessResult; annotations: string; kind: string }> = [
	{ process: { status: 0, signal: null }, annotations: "", kind: "clean" },
	{ process: { status: 10, signal: null }, annotations: "## src/a.ts:1 (+)\nFix this", kind: "annotations" },
	{ process: { status: 130, signal: null }, annotations: "", kind: "cancelled" },
	{ process: { status: null, signal: "SIGINT" }, annotations: "", kind: "cancelled" },
	{ process: { status: 2, signal: null }, annotations: "", kind: "error" },
	{ process: { status: 10, signal: null }, annotations: "", kind: "error" },
	{ process: { status: null, signal: null, error: new Error("missing loader") }, annotations: "", kind: "error" },
];
for (const outcome of outcomes) assert.equal(classifyRevdiffResult(outcome.process, outcome.annotations).kind, outcome.kind);

function createContext(cwd: string, mode: "tui" | "rpc" = "tui") {
	const test = {
		calls: [] as string[], notifications: [] as Array<{ message: string; type?: string }>,
		editorText: "original draft", idle: true,
		selections: [] as Array<string | undefined>, pickerInputs: [] as string[][],
		selectTitles: [] as string[], pickerCount: 0,
	};
	const ctx = {
		mode, hasUI: true, cwd: "/fallback", isIdle: () => test.idle,
		sessionManager: { getCwd: () => cwd },
		ui: {
			select: async (title: string) => { test.selectTitles.push(title); return test.selections.shift(); },
			custom: async <T>(factory: (tui: unknown, theme: Theme, keybindings: KeybindingsManager, done: (value: T) => void) => Component): Promise<T> => {
				let result: T | undefined;
				let finished = false;
				const tui = {
					stop: () => test.calls.push("stop"), start: () => test.calls.push("start"),
					requestRender: (force?: boolean) => { if (force) test.calls.push("render:true"); },
				};
				const component = factory(tui, { fg: (_: string, text: string) => text, bold: (text: string) => text } as Theme, new KeybindingsManager(TUI_KEYBINDINGS), (value) => { result = value; finished = true; });
				if (!finished) {
					test.pickerCount++;
					const input = test.pickerInputs.shift();
					assert.ok(input, "interactive revision picker requires queued keyboard input");
					for (const data of input) component.handleInput?.(data);
				}
				assert.ok(finished, "custom UI must finish via terminal exit, selection or cancellation");
				return result as T;
			},
			getEditorText: () => test.editorText,
			setEditorText: (text: string) => { test.editorText = text; },
			notify: (message: string, type?: string) => test.notifications.push({ message, type }),
		},
	} as unknown as ExtensionCommandContext;
	return { test, ctx };
}

function processAdapters(status = 0, annotations = "") {
	const calls: string[] = [];
	const launches: Array<{ args: readonly string[]; cwd?: string; env?: NodeJS.ProcessEnv }> = [];
	const adapters: DiffReviewAdapters = {
		resolveBinary: () => "/fake/revdiff",
		makeTempDirectory: async () => "/fake/review-dir",
		readConfig: async () => "",
		writeConfig: async () => {},
		validateConfig: async () => {},
		readAnnotations: async (path) => { calls.push(`read:${path}`); return annotations; },
		removeTempDirectory: async (path) => { calls.push(`remove:${path}`); },
		writeTerminal: () => calls.push("clear"),
		spawn: ((_binary: string, args: readonly string[], options: { cwd?: string; env?: NodeJS.ProcessEnv }) => {
			launches.push({ args, cwd: options.cwd, env: options.env });
			return { status, signal: null } as SpawnSyncReturns<Buffer>;
		}) as never,
	};
	return { adapters, launches, calls };
}

const repo = await createDiffFixture();
try {
	{
		const { test, ctx } = createContext(repo.cwd);
		const process = processAdapters(2);
		const result = await createDiffCommandHandler(process.adapters)("worktree", ctx);
		assert.equal(process.launches.length, 1, "unborn worktree review must be attempted without manufacturing HEAD");
		assert.deepEqual(process.launches[0]!.args.slice(3), []);
		assert.equal(result.kind, "error");
		assert.match(test.notifications.at(-1)!.message, /no HEAD commit.*unborn repositories/, "native revdiff limitations on unborn worktrees must be explained");
		assert.equal(test.editorText, "original draft");
	}
	const root = await repo.commit("Root");
	const main = await repo.commit("Main only", "main.txt");
	await repo.git("switch", "-c", "feature", root);
	const head = await repo.commit("Feature only", "feature.txt");
	{
		const { test, ctx } = createContext(repo.cwd, "rpc");
		const process = processAdapters();
		assert.equal((await createDiffCommandHandler(process.adapters)("worktree", ctx)).kind, "unsupported");
		assert.deepEqual(test.calls, []);
		assert.equal(process.launches.length, 0);
	}
	{
		const { test, ctx } = createContext(repo.cwd);
		test.idle = false;
		const process = processAdapters();
		assert.equal((await createDiffCommandHandler(process.adapters)("", ctx)).kind, "unsupported");
		assert.equal(test.selectTitles.length, 0, "busy requests must not open a selection UI");
		assert.equal(process.launches.length, 0);
	}
	{
		const { test, ctx } = createContext(repo.cwd);
		const result = await reviewDiffWithRevdiff(ctx, repo.cwd, worktree, { resolveBinary: () => undefined });
		assert.equal(result.kind, "missing");
		assert.match(result.kind === "missing" ? result.message : "", /brew install umputun\/apps\/revdiff/);
		assert.deepEqual(test.calls, []);
	}
	{
		const { test, ctx } = createContext(repo.cwd);
		const handler = createDiffCommandHandler({ resolveBinary: () => "/fake/revdiff", makeTempDirectory: async () => { throw new Error("read-only tmp"); } });
		const result = await handler("worktree", ctx);
		assert.equal(result.kind, "error");
		assert.match(test.notifications.at(-1)!.message, /Failed to create revdiff temporary directory/);
		assert.deepEqual(test.calls, []);
	}
	{
		const { test, ctx } = createContext(repo.cwd);
		const annotations = "## src/a.ts:4 (+)\nPlease simplify this branch.";
		const process = processAdapters(10, annotations);
		const result = await createDiffCommandHandler(process.adapters)("worktree", ctx);
		assert.deepEqual(test.calls, ["stop", "start", "render:true"]);
		assert.equal(result.kind, "annotations");
		assert.equal(test.editorText, `original draft\n\n${annotations}`, "annotations should append to the draft, never send to the agent");
		assert.equal(process.launches[0]?.cwd, repo.cwd, "session cwd must take priority over ctx.cwd");
		assert.equal(process.launches[0]?.args.filter((arg) => !arg.startsWith("--")).length, 0);
		assert.equal(process.calls.at(-1), "remove:/fake/review-dir");
	}
	{
		const { test, ctx } = createContext(repo.cwd);
		const process = processAdapters(130);
		assert.equal((await createDiffCommandHandler(process.adapters)("worktree", ctx)).kind, "cancelled");
		assert.equal(test.editorText, "original draft");
		assert.equal(test.notifications.at(-1)?.type, "info");
		assert.equal(process.calls.at(-1), "remove:/fake/review-dir");
	}
	for (const draft of ["", "new draft typed while reading annotations"]) {
		const { test, ctx } = createContext(repo.cwd);
		const process = processAdapters(10, "Review feedback");
		process.adapters.removeTempDirectory = async () => { test.editorText = draft; };
		await createDiffCommandHandler(process.adapters)("worktree", ctx);
		assert.equal(test.editorText, draft ? `${draft}\n\nReview feedback` : "Review feedback", "read the current draft only at annotation handoff, after async cleanup");
	}
	// Every UI cancellation boundary must be side-effect free; repeat after cancellation to prove gate release.
	for (const args of ["", "branch", "compare", "compare main"]) {
		const { test, ctx } = createContext(repo.cwd);
		const process = processAdapters();
		if (args.startsWith("compare")) test.pickerInputs.push(["\x1b"]);
		const handler = createDiffCommandHandler(process.adapters);
		assert.equal((await handler(args, ctx)).kind, "cancelled", args);
		assert.equal(process.launches.length, 0, args);
		assert.equal(test.editorText, "original draft", args);
		assert.equal(test.notifications.length, 0, "picker cancellation must not be an error");
		assert.equal((await handler("worktree", ctx)).kind, "clean", "cancellation must release the gate");
	}
	{
		const { test, ctx } = createContext(repo.cwd);
		test.selections.push("Compare revisions");
		test.pickerInputs.push(["main", "\r"], ["\x1b"]);
		const process = processAdapters();
		assert.equal((await createDiffCommandHandler(process.adapters)("", ctx)).kind, "cancelled");
		assert.equal(test.pickerCount, 2, "empty command menu should lead to both endpoint pickers");
		assert.equal(process.launches.length, 0);
		assert.equal(test.editorText, "original draft");
	}
	{
		const { test, ctx } = createContext(repo.cwd);
		const process = processAdapters();
		test.pickerInputs.push(["feature", "\r"]);
		assert.equal((await createDiffCommandHandler(process.adapters)("compare main", ctx)).kind, "clean");
		assert.equal(test.pickerCount, 1, "only the missing endpoint should be prompted");
		assert.deepEqual(process.launches[0]!.args.slice(3), [main, head]);
	}
	// Scope environment overrides native range preferences but preserves native appearance preferences.
	const savedEnv = { ...globalThis.process.env };
	try {
		globalThis.process.env.REVDIFF_STAGED = "true";
		globalThis.process.env.REVDIFF_UNTRACKED = "false";
		globalThis.process.env.REVDIFF_EXIT_CODE_ON_ANNOTATIONS = "false";
		globalThis.process.env.REVDIFF_WRAP = "true";
		globalThis.process.env.REVDIFF_COMPACT = "true";
		for (const scenario of [
			{ args: "worktree", selection: undefined, revisions: [], untracked: "true" },
			{ args: "branch main", selection: "Committed only", revisions: [root, head], untracked: "false" },
			{ args: "branch", selection: "Include working tree", revisions: [root], untracked: "true" },
			{ args: "compare main feature", selection: undefined, revisions: [main, head], untracked: "false" },
		]) {
			const { test, ctx } = createContext(repo.cwd);
			test.selections.push(scenario.selection);
			const process = processAdapters();
			assert.equal((await createDiffCommandHandler(process.adapters)(scenario.args, ctx)).kind, "clean");
			const launch = process.launches[0]!;
			assert.deepEqual(launch.args.slice(3), scenario.revisions);
			assert.ok(launch.args[1]?.startsWith("--description="));
			assert.equal(launch.env?.REVDIFF_STAGED, "false");
			assert.equal(launch.env?.REVDIFF_UNTRACKED, scenario.untracked);
			assert.equal(launch.env?.REVDIFF_EXIT_CODE_ON_ANNOTATIONS, "true");
			assert.equal(launch.env?.REVDIFF_WRAP, "true");
			assert.equal(launch.env?.REVDIFF_COMPACT, "true");
			assert.equal(test.editorText, "original draft", "clean review must leave the draft alone");
		}
	} finally {
		for (const key of ["REVDIFF_STAGED", "REVDIFF_UNTRACKED", "REVDIFF_EXIT_CODE_ON_ANNOTATIONS", "REVDIFF_WRAP", "REVDIFF_COMPACT"]) {
			if (savedEnv[key] === undefined) delete globalThis.process.env[key];
			else globalThis.process.env[key] = savedEnv[key];
		}
	}
	{
		const { test, ctx } = createContext(repo.cwd);
		const process = processAdapters();
		const handler = createDiffCommandHandler(process.adapters);
		let release!: (value: string | undefined) => void;
		let opened!: () => void;
		const ready = new Promise<void>((resolve) => { opened = resolve; });
		ctx.ui.select = async () => { opened(); return new Promise((resolve) => { release = resolve; }); };
		const first = handler("", ctx);
		await ready;
		assert.equal((await handler("worktree", ctx)).kind, "unsupported", "selection + launch must be guarded as a single operation");
		assert.equal(process.launches.length, 0);
		release(undefined);
		await first;
		assert.equal((await handler("worktree", ctx)).kind, "clean");
		assert.equal(test.editorText, "original draft");
	}
	{
		const { test, ctx } = createContext(repo.cwd);
		const process = processAdapters();
		ctx.ui.select = async () => { test.idle = false; return "Working tree"; };
		assert.equal((await createDiffCommandHandler(process.adapters)("", ctx)).kind, "unsupported", "busy state must be checked again before terminal handoff");
		assert.equal(process.launches.length, 0);
	}
	for (const failure of ["spawn", "read", "handoff"] as const) {
		const { test, ctx } = createContext(repo.cwd);
		const process = processAdapters();
		if (failure === "spawn") process.adapters.spawn = (() => { throw new Error("spawn failed"); }) as never;
		if (failure === "read") process.adapters.readAnnotations = async () => { throw new Error("read denied"); };
		if (failure === "handoff") ctx.ui.custom = async () => { throw new Error("handoff failed"); };
		const handler = createDiffCommandHandler(process.adapters);
		assert.equal((await handler("worktree", ctx)).kind, "error");
		assert.equal(test.editorText, "original draft");
		assert.equal(process.calls.at(-1), "remove:/fake/review-dir");
		if (failure !== "handoff") assert.deepEqual(test.calls, ["stop", "start", "render:true"], "spawn/read failure must still restore TUI");
		assert.equal((await handler("worktree", ctx)).kind, "error", "failure must release gate rather than leave command unsupported");
	}
	{
		const { ctx } = createContext(repo.cwd);
		const process = processAdapters();
		process.adapters.readAnnotations = async () => { throw Object.assign(new Error("missing"), { code: "ENOENT" }); };
		assert.equal((await createDiffCommandHandler(process.adapters)("worktree", ctx)).kind, "clean");
	}
	{
		const { ctx } = createContext(repo.cwd);
		const process = processAdapters();
		const handler = createDiffCommandHandler(process.adapters);
		assert.equal((await handler("compare --help HEAD", ctx)).kind, "error");
		assert.equal((await handler("worktree extra", ctx)).kind, "error");
		assert.equal(process.launches.length, 0, "invalid command/ref must not reach revdiff");
		assert.equal((await handler("worktree", ctx)).kind, "clean", "resolution failures must release the gate");
	}
	{
		const { ctx } = createContext(repo.cwd);
		const process = processAdapters();
		ctx.ui.select = async () => { await repo.commit("Changed during dialog", "later.txt"); return "Committed only"; };
		assert.equal((await createDiffCommandHandler(process.adapters)("branch main", ctx)).kind, "clean");
		assert.deepEqual(process.launches[0]!.args.slice(3), [root, head], "changing HEAD during scope selection must not retarget committed review");
	}
} finally {
	await repo.cleanup();
}

{
	const git = createGitHarness();
	const test = createRuntimeTestContext();
	const reviewArgs: string[] = [];
	const harness = createRuntimeHarness({ git, reviewDiff: async (args, ctx) => {
		assert.equal(ctx, test.ctx);
		reviewArgs.push(args);
		throw new Error("review failed");
	} });
	harness.runtime.events.sessionStart({}, test.ctx);
	const baseline = git.schedules.length;
	await assert.rejects(harness.runtime.commands.openDiff("compare main HEAD", test.ctx), /review failed/);
	assert.deepEqual(reviewArgs, ["compare main HEAD"], "runtime must pass through command arguments");
	assert.deepEqual(git.schedules.slice(baseline), [true], "runtime must refresh Git after errors too");
}
{
	const config = defaultConfig();
	config.segments.find((segment) => segment.id === "git")!.enabled = false;
	let called = false;
	const harness = createRuntimeHarness({ loadConfigSyncConfig: config, reviewDiff: async () => { called = true; } });
	const test = createRuntimeTestContext();
	harness.runtime.events.sessionStart({}, test.ctx);
	await harness.runtime.commands.openDiff("worktree", test.ctx);
	assert.equal(called, false, "Git-disabled runtime must block all review modes");
	assert.match(test.notifications.at(-1)!.message, /Git is off/);
}
console.log("✓ diff orchestration, scope, cancellation, annotations, terminal recovery, cleanup and runtime checks passed");
