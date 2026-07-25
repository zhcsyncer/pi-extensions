import { spawnSync, type SpawnSyncReturns } from "node:child_process";
import { accessSync, constants, existsSync } from "node:fs";
import { chmod, readFile } from "node:fs/promises";
import path from "node:path";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { PlanPaths, RevdiffReviewResult } from "./types.ts";

const EXIT_CODE_ANNOTATIONS = 10;

export interface RevdiffRequest {
	paths: PlanPaths;
	hasPrevious: boolean;
	cwd: string;
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
	for (const directory of (env.PATH ?? "").split(path.delimiter)) {
		if (!directory) continue;
		const candidate = path.join(directory, process.platform === "win32" ? "revdiff.exe" : "revdiff");
		if (isExecutable(candidate)) return candidate;
	}
	return undefined;
}

export function buildRevdiffArguments(request: RevdiffRequest): string[] {
	const reviewArguments = request.hasPrevious
		? ["--compare-old", request.paths.previous, "--compare-new", request.paths.plan, "--word-diff"]
		: ["--only", request.paths.plan];
	return [...reviewArguments, `--output=${request.paths.annotations}`];
}

interface ProcessResult {
	status: number | null;
	signal: NodeJS.Signals | null;
	error?: Error;
}

export function classifyRevdiffResult(result: ProcessResult, annotations: string): RevdiffReviewResult {
	const output = annotations.trim();
	if (result.error) return { kind: "error", message: `Failed to launch revdiff: ${result.error.message}` };
	if (result.signal || result.status === 130) {
		return { kind: "cancelled", message: `revdiff was interrupted${result.signal ? ` (${result.signal})` : ""}` };
	}
	if (result.status !== 0 && result.status !== EXIT_CODE_ANNOTATIONS) {
		return { kind: "error", message: `revdiff exited with code ${result.status ?? "unknown"}` };
	}
	if (output) return { kind: "changes_requested", annotations: output };
	if (result.status === EXIT_CODE_ANNOTATIONS) {
		return { kind: "error", message: "revdiff reported annotations but produced no annotation output" };
	}
	return { kind: "clean" };
}

function processResult(result: SpawnSyncReturns<Buffer>): ProcessResult {
	return {
		status: result.status,
		signal: result.signal,
		error: result.error,
	};
}

export async function reviewPlanWithRevdiff(
	ctx: ExtensionContext,
	request: RevdiffRequest,
): Promise<RevdiffReviewResult> {
	if (ctx.mode !== "tui") return { kind: "error", message: "Plan review requires Pi TUI mode" };
	const binary = resolveRevdiffBinary();
	if (!binary) {
		return {
			kind: "error",
			message: "revdiff was not found. Install it with `brew install umputun/apps/revdiff` or set REVDIFF_BIN.",
		};
	}

	let result: ProcessResult | undefined;
	try {
		result = await ctx.ui.custom<ProcessResult>((tui, _theme, _keybindings, done) => {
			tui.stop();
			process.stdout.write("\x1b[2J\x1b[H");
			let spawned: SpawnSyncReturns<Buffer>;
			try {
				spawned = spawnSync(binary, buildRevdiffArguments(request), {
					cwd: request.cwd,
					env: { ...process.env, REVDIFF_EXIT_CODE_ON_ANNOTATIONS: "true" },
					stdio: "inherit",
				});
			} finally {
				tui.start();
				tui.requestRender(true);
			}
			const outcome = processResult(spawned!);
			done(outcome);
			return { render: () => [], invalidate() {} };
		});
	} catch (error) {
		return { kind: "error", message: `Failed to hand the terminal to revdiff: ${error instanceof Error ? error.message : String(error)}` };
	}

	let annotations = "";
	try {
		annotations = await readFile(request.paths.annotations, "utf8");
		await chmod(request.paths.annotations, 0o600);
	} catch (error) {
		if (!(typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT")) throw error;
	}
	return classifyRevdiffResult(result, annotations);
}
