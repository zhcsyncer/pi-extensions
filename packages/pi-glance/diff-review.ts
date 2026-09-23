import { execFile, spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { pickDiffRevision } from "./diff-picker.js";
import {
	assertDiffWorktree, branchDiffTarget, compareDiffTarget, listDiffRevisions, parseDiffCommand,
	prepareBranchDiff, resolveDiffRevision, workingTreeDiffTarget, type DiffTarget,
} from "./diff-target.js";

const EXIT_CODE_ANNOTATIONS = 10;

export type DiffReviewContext = Pick<ExtensionContext, "mode" | "ui" | "isIdle" | "cwd" | "sessionManager">;

export type DiffReviewResult =
	| { kind: "clean" }
	| { kind: "annotations"; annotations: string }
	| { kind: "cancelled"; message: string }
	| { kind: "missing"; message: string }
	| { kind: "unsupported"; message: string }
	| { kind: "error"; message: string };

export interface RevdiffProcessResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
}

export interface DiffReviewAdapters {
	resolveBinary?: () => string | undefined;
	spawn?: typeof spawnSync;
	makeTempDirectory?: () => Promise<string>;
	readAnnotations?: (path: string) => Promise<string>;
	readConfig?: (path: string) => Promise<string>;
	writeConfig?: (path: string, content: string) => Promise<void>;
	validateConfig?: typeof validateRevdiffConfig;
	removeTempDirectory?: (path: string) => Promise<void>;
	writeTerminal?: (text: string) => void;
}

function isExecutable(file: string): boolean {
	if (!existsSync(file)) return false;
	if (process.platform === "win32") return true;
	try {
		accessSync(file, constants.X_OK);
		return true;
	} catch {
		return false;
	}
}

export function resolveRevdiffBinary(env: NodeJS.ProcessEnv = process.env): string | undefined {
	const configured = env.REVDIFF_BIN?.trim();
	if (configured) return isExecutable(configured) ? configured : undefined;
	for (const directory of (env.PATH ?? "").split(process.platform === "win32" ? ";" : ":")) {
		if (!directory) continue;
		const candidate = join(directory, process.platform === "win32" ? "revdiff.exe" : "revdiff");
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

export function buildRevdiffArguments(annotationsPath: string, target: DiffTarget, configPath: string): string[] {
	return [`--output=${annotationsPath}`, `--description=${target.description}`, `--config=${configPath}`, ...target.revisions];
}

export function revdiffConfigPath(cwd: string, env: NodeJS.ProcessEnv = process.env, home = homedir()): string {
	return env.REVDIFF_CONFIG ? resolve(cwd, env.REVDIFF_CONFIG) : join(home, ".config", "revdiff", "config");
}

export function buildScopedRevdiffConfig(source: string, includeUntracked: boolean): string {
	// v1.13.0 INI booleans override child env; --staged=false is not accepted.
	// Native duplicate sections use the last value, so retain preferences and override only scope.
	return `${source}\n[Application Options]\nstaged = false\nuntracked = ${includeUntracked}\nexit-code-on-annotations = true\n`;
}

const execute = promisify(execFile);

export async function validateRevdiffConfig(binary: string, configPath: string, cwd: string, env: NodeJS.ProcessEnv): Promise<void> {
	// --dump-config exits before theme installation, hooks, Git or TTY setup in v1.13.0.
	// Use a real file: native parsing reads it twice. Invalid INI only warns and may exit 0.
	const { stdout, stderr } = await execute(binary, [`--config=${configPath}`, "--dump-config"], {
		cwd, env, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
	});
	if (stderr.trim()) throw new Error(`revdiff configuration warning: ${stderr.trim()}`);
	// Check the native canonical dump, not arbitrary source INI. Commented entries are built-in defaults.
	for (const [key, value] of Object.entries({ staged: "false", untracked: env.REVDIFF_UNTRACKED, "exit-code-on-annotations": "true" })) {
		if (!new RegExp(`^(?:; )?${key} = ${value}\\r?$`, "m").test(stdout)) {
			throw new Error(`revdiff did not confirm the required scope setting: ${key} = ${value}`);
		}
	}
}

export function classifyRevdiffResult(result: RevdiffProcessResult, annotations: string): DiffReviewResult {
	const output = annotations.trim();
	if (result.error) return { kind: "error", message: `Failed to launch revdiff: ${result.error.message}` };
	if (result.signal || result.status === 130) {
		return { kind: "cancelled", message: `revdiff was interrupted${result.signal ? ` (${result.signal})` : ""}` };
	}
	if (result.status !== 0 && result.status !== EXIT_CODE_ANNOTATIONS) {
		return { kind: "error", message: `revdiff exited with code ${result.status ?? "unknown"}` };
	}
	if (output) return { kind: "annotations", annotations: output };
	if (result.status === EXIT_CODE_ANNOTATIONS) {
		return { kind: "error", message: "revdiff reported annotations but produced no annotation output" };
	}
	return { kind: "clean" };
}

function processResult(result: SpawnSyncReturns<Buffer>): RevdiffProcessResult {
	return { status: result.status, signal: result.signal, ...(result.error ? { error: result.error } : {}) };
}

function isMissingFileError(error: unknown): boolean {
	return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

export async function reviewDiffWithRevdiff(
	ctx: DiffReviewContext,
	cwd: string,
	target: DiffTarget,
	adapters: DiffReviewAdapters = {},
): Promise<DiffReviewResult> {
	if (ctx.mode !== "tui") return { kind: "unsupported", message: "Diff review requires Pi TUI mode" };
	const binary = (adapters.resolveBinary ?? resolveRevdiffBinary)();
	if (!binary) {
		return {
			kind: "missing",
			message: "revdiff was not found. Install it with `brew install umputun/apps/revdiff` or set REVDIFF_BIN.",
		};
	}

	let directory: string;
	try {
		directory = await (adapters.makeTempDirectory ?? (() => mkdtemp(join(tmpdir(), "pi-glance-revdiff-"))))();
	} catch (error) {
		return { kind: "error", message: `Failed to create revdiff temporary directory: ${error instanceof Error ? error.message : String(error)}` };
	}
	const annotationsPath = join(directory, "annotations.md");
	const configPath = join(directory, "config");
	const sourcePath = revdiffConfigPath(cwd);
	const env: NodeJS.ProcessEnv = {
		...process.env,
		REVDIFF_STAGED: "false",
		REVDIFF_UNTRACKED: String(target.includeUntracked),
		REVDIFF_EXIT_CODE_ON_ANNOTATIONS: "true",
	};
	const spawn = adapters.spawn ?? spawnSync;
	let processOutcome: RevdiffProcessResult;
	try {
		try {
			let source = "";
			try {
				source = await (adapters.readConfig ?? ((path) => readFile(path, "utf8")))(sourcePath);
			} catch (error) {
				if (env.REVDIFF_CONFIG || !isMissingFileError(error)) throw error;
			}
			await (adapters.writeConfig ?? ((path, content) => writeFile(path, content, { mode: 0o600 })))(configPath, buildScopedRevdiffConfig(source, target.includeUntracked));
			await (adapters.validateConfig ?? validateRevdiffConfig)(binary, configPath, cwd, env);
		} catch (error) {
			return { kind: "error", message: `Cannot prepare a safe revdiff scope from ${sourcePath}. Check the native config: ${error instanceof Error ? error.message : String(error)}` };
		}
		if (!ctx.isIdle()) return { kind: "unsupported", message: "The agent is now busy; open /diff again once it finishes." };
		try {
			processOutcome = await ctx.ui.custom<RevdiffProcessResult>((tui, _theme, _keybindings, done) => {
				let outcome: RevdiffProcessResult;
				tui.stop();
				try {
					(adapters.writeTerminal ?? ((text) => process.stdout.write(text)))("\x1b[2J\x1b[H");
					outcome = processResult(spawn(binary, buildRevdiffArguments(annotationsPath, target, configPath), {
						cwd,
						env,
						stdio: "inherit",
					}));
				} catch (error) {
					outcome = { status: null, signal: null, error: error instanceof Error ? error : new Error(String(error)) };
				} finally {
					tui.start();
					tui.requestRender(true);
				}
				done(outcome);
				return { render: () => [], invalidate() {} };
			});
		} catch (error) {
			return { kind: "error", message: `Failed to hand the terminal to revdiff: ${error instanceof Error ? error.message : String(error)}` };
		}

		let annotations = "";
		try {
			annotations = await (adapters.readAnnotations ?? ((path) => readFile(path, "utf8")))(annotationsPath);
		} catch (error) {
			if (!isMissingFileError(error)) {
				return { kind: "error", message: `Failed to read revdiff annotations: ${error instanceof Error ? error.message : String(error)}` };
			}
		}
		const result = classifyRevdiffResult(processOutcome, annotations);
		if (result.kind === "error" && target.unborn) {
			result.message += ". This worktree has no HEAD commit; your revdiff version may not support unborn repositories.";
		}
		return result;
	} finally {
		await (adapters.removeTempDirectory ?? ((path) => rm(path, { recursive: true, force: true })))(directory).catch(() => undefined);
	}
}

async function selectDiffTarget(args: string, ctx: DiffReviewContext, cwd: string): Promise<DiffTarget | undefined> {
	let command = parseDiffCommand(args);
	await assertDiffWorktree(cwd);
	if (command.mode === "menu") {
		const mode = await ctx.ui.select("Review Git changes", ["Working tree", "Branch vs main", "Compare revisions"]);
		if (mode === undefined) return undefined;
		command = mode === "Working tree" ? { mode: "worktree" } : mode === "Branch vs main" ? { mode: "branch" } : { mode: "compare" };
	}
	if (command.mode === "worktree") return workingTreeDiffTarget(cwd);
	if (command.mode === "branch") {
		// Freeze both endpoints before the scope dialog; later HEAD changes must not move a committed review.
		const branch = await prepareBranchDiff(cwd, command.base);
		const scope = await ctx.ui.select(`Branch changes since merge base with ${branch.base.label}`, ["Committed only", "Include working tree"]);
		return scope === undefined ? undefined : branchDiffTarget(branch, scope === "Include working tree");
	}
	const candidates = command.from === undefined || command.to === undefined ? await listDiffRevisions(cwd) : [];
	const fromChoice = command.from === undefined ? await pickDiffRevision(ctx, "Compare revisions — from", candidates) : { ref: command.from, label: command.from };
	if (!fromChoice) return undefined;
	const from = await resolveDiffRevision(cwd, fromChoice.ref, fromChoice.label);
	const toChoice = command.to === undefined ? await pickDiffRevision(ctx, `Compare revisions — ${from.label} → to`, candidates) : { ref: command.to, label: command.to };
	if (!toChoice) return undefined;
	const to = await resolveDiffRevision(cwd, toChoice.ref, toChoice.label);
	return compareDiffTarget(from, to);
}

function reportDiffResult(ctx: DiffReviewContext, result: DiffReviewResult): void {
	switch (result.kind) {
		case "annotations": {
			const draft = ctx.ui.getEditorText();
			ctx.ui.setEditorText(draft ? `${draft}\n\n${result.annotations}` : result.annotations);
			ctx.ui.notify("Review annotations added to the editor. Confirm or edit before sending.", "info");
			break;
		}
		case "clean":
			ctx.ui.notify("revdiff review finished without annotations", "info");
			break;
		case "cancelled":
			if (result.message) ctx.ui.notify(result.message, "info");
			break;
		case "missing":
		case "unsupported":
		case "error":
			ctx.ui.notify(result.message, "error");
			break;
	}
}

export function createDiffCommandHandler(adapters: DiffReviewAdapters = {}): (args: string, ctx: DiffReviewContext) => Promise<DiffReviewResult> {
	let active = false;
	return async (args, ctx) => {
		const decline = (message: string): DiffReviewResult => {
			const result: DiffReviewResult = { kind: "unsupported", message };
			reportDiffResult(ctx, result);
			return result;
		};
		if (ctx.mode !== "tui") return decline("Diff review requires Pi TUI mode.");
		if (active) return decline("A diff review is already open. Finish or cancel it first.");
		if (!ctx.isIdle()) return decline("Wait for the agent to finish before opening /diff.");
		active = true;
		try {
			const cwd = ctx.sessionManager.getCwd() || ctx.cwd;
			const target = await selectDiffTarget(args, ctx, cwd);
			if (!target) return { kind: "cancelled", message: "" };
			if (!ctx.isIdle()) return decline("The agent is now busy; open /diff again once it finishes.");
			const result = await reviewDiffWithRevdiff(ctx, cwd, target, adapters);
			reportDiffResult(ctx, result);
			return result;
		} catch (error) {
			const result: DiffReviewResult = { kind: "error", message: error instanceof Error ? error.message : String(error) };
			reportDiffResult(ctx, result);
			return result;
		} finally {
			active = false;
		}
	};
}
