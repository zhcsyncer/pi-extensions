import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionCommandContext } from "@earendil-works/pi-coding-agent";

const EXIT_CODE_ANNOTATIONS = 10;

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

export function buildRevdiffArguments(annotationsPath: string): string[] {
	return [`--output=${annotationsPath}`];
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

export async function reviewWorkingTreeWithRevdiff(
	ctx: ExtensionCommandContext,
	cwd: string,
	adapters: DiffReviewAdapters = {},
): Promise<DiffReviewResult> {
	if (ctx.mode !== "tui") return { kind: "unsupported", message: "Working tree review requires Pi TUI mode" };
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
	const spawn = adapters.spawn ?? spawnSync;
	let processOutcome: RevdiffProcessResult;
	try {
		try {
			processOutcome = await ctx.ui.custom<RevdiffProcessResult>((tui, _theme, _keybindings, done) => {
				let outcome: RevdiffProcessResult;
				tui.stop();
				try {
					(adapters.writeTerminal ?? ((text) => process.stdout.write(text)))("\x1b[2J\x1b[H");
					outcome = processResult(spawn(binary, buildRevdiffArguments(annotationsPath), {
						cwd,
						env: { ...process.env, REVDIFF_EXIT_CODE_ON_ANNOTATIONS: "true" },
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
		return classifyRevdiffResult(processOutcome, annotations);
	} finally {
		await (adapters.removeTempDirectory ?? ((path) => rm(path, { recursive: true, force: true })))(directory).catch(() => undefined);
	}
}

export async function handleDiffCommand(
	ctx: ExtensionCommandContext,
	adapters: DiffReviewAdapters = {},
): Promise<DiffReviewResult> {
	const cwd = ctx.sessionManager.getCwd() || ctx.cwd;
	const result = await reviewWorkingTreeWithRevdiff(ctx, cwd, adapters);
	switch (result.kind) {
		case "annotations":
			ctx.ui.setEditorText(result.annotations);
			ctx.ui.notify("Review annotations loaded into the editor. Confirm or edit before sending.", "info");
			break;
		case "clean":
			ctx.ui.notify("revdiff review finished without annotations", "info");
			break;
		case "cancelled":
			ctx.ui.notify(result.message, "info");
			break;
		case "missing":
		case "unsupported":
		case "error":
			ctx.ui.notify(result.message, "error");
			break;
	}
	return result;
}
