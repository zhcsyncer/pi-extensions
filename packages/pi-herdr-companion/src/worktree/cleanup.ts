import type { ExecResult } from "@earendil-works/pi-coding-agent";
import type { HerdrClient, HerdrExecutor } from "../herdr-client.ts";
import type { RuntimeSnapshot } from "../runtime.ts";

const GIT_TIMEOUT_MS = 10_000;
const PROTECTED_BRANCHES = new Set(["main", "master"]);

export class GitCommandError extends Error {
	readonly operation: string;
	readonly exitCode: number;
	readonly killed: boolean;

	constructor(args: readonly string[], result: ExecResult) {
		const operation = `git ${args[0] ?? "command"}`;
		const status = result.killed ? "timed out or was cancelled" : `failed with exit code ${result.code}`;
		const detail = firstLine(result.stderr || result.stdout);
		super(detail ? `${operation} ${status}: ${detail}` : `${operation} ${status}`);
		this.name = "GitCommandError";
		this.operation = operation;
		this.exitCode = result.code;
		this.killed = result.killed;
	}
}

export interface CleanupUi {
	confirm(title: string, message: string): Promise<boolean>;
}

export interface CleanupDeps {
	client: Pick<HerdrClient, "getWorkspace" | "removeWorktree">;
	exec: HerdrExecutor;
	runtime: Pick<RuntimeSnapshot, "workspaceId">;
	keepBranch: boolean;
	ui: CleanupUi;
}

export type CleanupResult =
	| { status: "rejected"; message: string }
	| { status: "cancelled" }
	| { status: "removed"; keepBranch: boolean; branch?: string };

function firstLine(text: string): string {
	const line = text.trim().split(/\r?\n/, 1)[0] ?? "";
	return line.length > 200 ? `${line.slice(0, 197)}...` : line;
}

async function runGit(exec: HerdrExecutor, cwd: string, args: string[]): Promise<string> {
	const result = await exec("git", args, { cwd, timeout: GIT_TIMEOUT_MS });
	if (result.code !== 0 || result.killed) throw new GitCommandError(args, result);
	return result.stdout;
}

export async function inspectWorktreeGit(
	exec: HerdrExecutor,
	cwd: string,
): Promise<{ branch?: string; dirty: boolean }> {
	const branch = (await runGit(exec, cwd, ["branch", "--show-current"])).trim();
	const porcelain = await runGit(exec, cwd, ["status", "--porcelain"]);
	return {
		...(branch ? { branch } : {}),
		dirty: porcelain.trim().length > 0,
	};
}

function confirmMessage(branch: string | undefined, keepBranch: boolean): string {
	if (keepBranch) {
		return branch
			? `Remove this worktree and keep local branch ${branch}?`
			: "Remove this worktree? The current checkout has no local branch.";
	}
	return `Remove this worktree and delete local branch ${branch}?`;
}

function assertSafeBranchName(branch: string): void {
	if (!branch || /[\0\n\r]/.test(branch)) {
		throw new Error("Refusing to delete an invalid local branch name.");
	}
}

export async function cleanupCurrentWorktree(deps: CleanupDeps): Promise<CleanupResult> {
	const workspaceId = deps.runtime.workspaceId?.trim();
	if (!workspaceId) {
		return {
			status: "rejected",
			message: "Cannot remove this worktree: the current Herdr workspace is unknown.",
		};
	}

	const workspace = await deps.client.getWorkspace(workspaceId);
	const worktree = workspace.worktree;
	if (!worktree?.isLinkedWorktree) {
		return {
			status: "rejected",
			message: "Refusing to remove the primary checkout. /herdr-worktree cleanup only works in a linked worktree.",
		};
	}

	const cwd = worktree.checkoutPath;
	const git = await inspectWorktreeGit(deps.exec, cwd);
	if (!deps.keepBranch && !git.branch) {
		return {
			status: "rejected",
			message: "HEAD is detached; there is no local branch to delete. Use --keep-branch to remove only the worktree.",
		};
	}
	if (git.branch && PROTECTED_BRANCHES.has(git.branch)) {
		return {
			status: "rejected",
			message: `Refusing to remove a worktree checked out on ${git.branch}.`,
		};
	}
	if (git.dirty) {
		return {
			status: "rejected",
			message: "Refusing to remove a dirty worktree. Commit, stash, or discard changes first.",
		};
	}

	const confirmed = await deps.ui.confirm("Remove worktree", confirmMessage(git.branch, deps.keepBranch));
	if (!confirmed) return { status: "cancelled" };

	if (!deps.keepBranch) {
		const branch = git.branch as string;
		assertSafeBranchName(branch);
		await runGit(deps.exec, cwd, ["checkout", "--detach"]);
		await runGit(deps.exec, cwd, ["branch", "-D", "--", branch]);
	}

	await deps.client.removeWorktree(workspaceId);
	return {
		status: "removed",
		keepBranch: deps.keepBranch,
		...(git.branch ? { branch: git.branch } : {}),
	};
}
