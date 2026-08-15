import { execFile } from "node:child_process";
import type { GitConfig, GitSnapshot, GitStatus, GitWorktreeSnapshot } from "./types.js";

const GIT_STATUS_ARGS = ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--show-stash", "-z"] as const;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const NO_REPO_RETRY_MS = 30_000;
const MAX_FAILURE_RETRY_MS = 120_000;

interface GitCounts {
	staged: number;
	unstaged: number;
	untracked: number;
	conflicts: number;
}

interface BranchInfo {
	branch: string | null;
	detached: boolean;
	sha: string | null;
	upstream: string | null;
	ahead: number;
	behind: number;
}

export interface GitNumstat {
	additions: number | null;
	deletions: number | null;
}

interface GitCommandResult {
	ok: boolean;
	stdout: string;
}

function emptyWorktree(): GitWorktreeSnapshot {
	return {
		staged: [],
		unstaged: [],
		untracked: [],
		conflicts: [],
		files: 0,
		additions: null,
		deletions: null,
	};
}

export function emptyGitSnapshot(status: GitStatus = "unknown", now = Date.now()): GitSnapshot {
	return {
		repo: false,
		branch: null,
		detached: false,
		sha: null,
		upstream: null,
		ahead: 0,
		behind: 0,
		staged: 0,
		unstaged: 0,
		untracked: 0,
		conflicts: 0,
		dirty: false,
		status,
		worktree: emptyWorktree(),
		updatedAt: now,
	};
}

function shortSha(oid: string | null): string | null {
	if (!oid || oid === "(initial)") return null;
	return oid.slice(0, 7);
}

function isChangedStatus(status: string | undefined): boolean {
	return !!status && status !== ".";
}

function emptyBranchInfo(): BranchInfo {
	return {
		branch: null,
		detached: false,
		sha: null,
		upstream: null,
		ahead: 0,
		behind: 0,
	};
}

function parseBranchHeader(line: string, info: BranchInfo): void {
	if (line.startsWith("# branch.oid ")) {
		info.sha = shortSha(line.slice("# branch.oid ".length).trim());
		return;
	}
	if (line.startsWith("# branch.head ")) {
		const head = line.slice("# branch.head ".length).trim();
		info.detached = head === "(detached)";
		info.branch = info.detached ? null : head;
		return;
	}
	if (line.startsWith("# branch.upstream ")) {
		info.upstream = line.slice("# branch.upstream ".length).trim() || null;
		return;
	}
	if (line.startsWith("# branch.ab ")) {
		const match = line.match(/\+([0-9]+)\s+-([0-9]+)/);
		if (!match) return;
		info.ahead = Number.parseInt(match[1]!, 10);
		info.behind = Number.parseInt(match[2]!, 10);
	}
}

function textAfterFields(record: string, fieldCount: number): string | undefined {
	let offset = 0;
	for (let field = 0; field < fieldCount; field++) {
		const separator = record.indexOf(" ", offset);
		if (separator < 0) return undefined;
		offset = separator + 1;
	}
	return record.slice(offset);
}

function addPath(paths: Set<string>, path: string | undefined): void {
	if (path) paths.add(path);
}

function snapshotStatus(counts: GitCounts): GitStatus {
	if (counts.conflicts > 0) return "conflict";
	if (counts.staged > 0 || counts.unstaged > 0 || counts.untracked > 0) return "dirty";
	return "clean";
}

function splitStatusRecords(output: string): string[] {
	return output.includes("\0") ? output.split("\0") : output.split(/\r?\n/);
}

export function parseGitStatus(output: string, now = Date.now(), numstat?: GitNumstat): GitSnapshot {
	const branch = emptyBranchInfo();
	const stagedPaths = new Set<string>();
	const unstagedPaths = new Set<string>();
	const untrackedPaths = new Set<string>();
	const conflictPaths = new Set<string>();
	const records = splitStatusRecords(output);

	for (let index = 0; index < records.length; index++) {
		const record = records[index]!;
		if (!record) continue;
		if (record.startsWith("# ")) {
			parseBranchHeader(record, branch);
			continue;
		}
		if (record.startsWith("1 ")) {
			const pair = record.slice(2, 4);
			const path = textAfterFields(record, 8);
			if (isChangedStatus(pair[0])) addPath(stagedPaths, path);
			if (isChangedStatus(pair[1])) addPath(unstagedPaths, path);
			continue;
		}
		if (record.startsWith("2 ")) {
			const pair = record.slice(2, 4);
			const rawPath = textAfterFields(record, 9);
			const path = output.includes("\0") ? rawPath : rawPath?.split("\t", 1)[0];
			if (isChangedStatus(pair[0])) addPath(stagedPaths, path);
			if (isChangedStatus(pair[1])) addPath(unstagedPaths, path);
			// In -z mode the rename/copy source path is a separate record. It is
			// intentionally consumed but not counted: the current destination path
			// is the one unique working-tree entry visible to the user.
			if (output.includes("\0")) index++;
			continue;
		}
		if (record.startsWith("u ")) {
			addPath(conflictPaths, textAfterFields(record, 10));
			continue;
		}
		if (record.startsWith("? ")) addPath(untrackedPaths, record.slice(2));
	}

	const counts: GitCounts = {
		staged: stagedPaths.size,
		unstaged: unstagedPaths.size,
		untracked: untrackedPaths.size,
		conflicts: conflictPaths.size,
	};
	const uniquePaths = new Set([...stagedPaths, ...unstagedPaths, ...untrackedPaths, ...conflictPaths]);
	const status = snapshotStatus(counts);
	const cleanStats = status === "clean" ? { additions: 0, deletions: 0 } : { additions: null, deletions: null };
	return {
		repo: true,
		branch: branch.branch,
		detached: branch.detached,
		sha: branch.sha,
		upstream: branch.upstream,
		ahead: branch.ahead,
		behind: branch.behind,
		...counts,
		dirty: status !== "clean",
		status,
		worktree: {
			staged: [...stagedPaths],
			unstaged: [...unstagedPaths],
			untracked: [...untrackedPaths],
			conflicts: [...conflictPaths],
			files: uniquePaths.size,
			additions: numstat?.additions ?? cleanStats.additions,
			deletions: numstat?.deletions ?? cleanStats.deletions,
		},
		updatedAt: now,
	};
}

/** Parse `git diff --numstat -z`; binary records make the aggregate unknown. */
export function parseGitNumstat(output: string): GitNumstat {
	let additions = 0;
	let deletions = 0;
	let records = 0;
	for (const record of output.split("\0")) {
		const match = record.match(/^(-|[0-9]+)\t(-|[0-9]+)\t/);
		if (!match) continue;
		records++;
		if (match[1] === "-" || match[2] === "-") return { additions: null, deletions: null };
		additions += Number.parseInt(match[1]!, 10);
		deletions += Number.parseInt(match[2]!, 10);
	}
	return records === 0 ? { additions: 0, deletions: 0 } : { additions, deletions };
}

function execGit(cwd: string, args: readonly string[], timeout: number, input?: string): Promise<GitCommandResult> {
	return new Promise((resolve) => {
		const child = execFile(
			"git",
			[...args],
			{ cwd, timeout, maxBuffer: GIT_MAX_BUFFER, encoding: "utf8" },
			(error, stdout) => resolve({ ok: !error, stdout }),
		);
		if (input !== undefined) child.stdin?.end(input);
	});
}

async function collectTrackedNumstat(cwd: string, config: GitConfig, snapshot: GitSnapshot): Promise<GitNumstat | undefined> {
	if (snapshot.worktree.staged.length === 0 && snapshot.worktree.unstaged.length === 0 && snapshot.worktree.conflicts.length === 0) {
		return { additions: 0, deletions: 0 };
	}

	let base = "HEAD";
	if (!snapshot.sha) {
		const emptyTree = await execGit(cwd, ["--no-optional-locks", "hash-object", "-t", "tree", "--stdin"], config.timeoutMs, "");
		if (!emptyTree.ok || !emptyTree.stdout.trim()) return undefined;
		base = emptyTree.stdout.trim();
	}
	const result = await execGit(
		cwd,
		["--no-optional-locks", "diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", base, "--"],
		config.timeoutMs,
	);
	return result.ok ? parseGitNumstat(result.stdout) : undefined;
}

export async function collectGitSnapshot(cwd: string, config: GitConfig): Promise<GitSnapshot> {
	const statusResult = await execGit(cwd, GIT_STATUS_ARGS, config.timeoutMs);
	if (!statusResult.ok) return emptyGitSnapshot("unknown");
	const snapshot = parseGitStatus(statusResult.stdout);
	const numstat = await collectTrackedNumstat(cwd, config, snapshot);
	if (!numstat) return snapshot;
	return {
		...snapshot,
		worktree: { ...snapshot.worktree, additions: numstat.additions, deletions: numstat.deletions },
	};
}

export function nextGitRefreshDelay(snapshot: GitSnapshot, config: GitConfig, consecutiveFailures = 0): number {
	if (!snapshot.repo) {
		const exponent = Math.max(0, Math.min(2, consecutiveFailures - 1));
		return Math.min(MAX_FAILURE_RETRY_MS, NO_REPO_RETRY_MS * (2 ** exponent));
	}
	return Math.max(MIN_POLL_INTERVAL_MS, config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
}

interface GitRefresherOptions {
	collect?: (cwd: string, config: GitConfig) => Promise<GitSnapshot>;
	setTimer?: (callback: () => void, delay: number) => NodeJS.Timeout;
	clearTimer?: (timer: NodeJS.Timeout) => void;
}

export class GitRefresher {
	private timer: NodeJS.Timeout | undefined;
	private inFlight = false;
	private pending = false;
	private pendingImmediate = false;
	private disposed = false;
	private consecutiveFailures = 0;
	private readonly collect: (cwd: string, config: GitConfig) => Promise<GitSnapshot>;
	private readonly setTimer: (callback: () => void, delay: number) => NodeJS.Timeout;
	private readonly clearScheduledTimer: (timer: NodeJS.Timeout) => void;

	constructor(
		private readonly getConfig: () => GitConfig,
		private readonly getCwd: () => string | undefined,
		private readonly onSnapshot: (cwd: string, snapshot: GitSnapshot) => void,
		options: GitRefresherOptions = {},
	) {
		this.collect = options.collect ?? collectGitSnapshot;
		this.setTimer = options.setTimer ?? setTimeout;
		this.clearScheduledTimer = options.clearTimer ?? clearTimeout;
	}

	dispose(): void {
		this.disposed = true;
		this.pending = false;
		this.pendingImmediate = false;
		this.clearTimer();
	}

	schedule(immediate = false): void {
		if (this.disposed) return;
		if (this.inFlight) {
			this.pending = true;
			this.pendingImmediate ||= immediate;
			this.clearTimer();
			return;
		}
		this.scheduleAfter(immediate ? 0 : this.getConfig().refreshDebounceMs);
	}

	private clearTimer(): void {
		if (this.timer) this.clearScheduledTimer(this.timer);
		this.timer = undefined;
	}

	private scheduleAfter(delay: number): void {
		this.clearTimer();
		this.timer = this.setTimer(() => {
			this.timer = undefined;
			void this.refresh();
		}, delay);
		this.timer.unref?.();
	}

	private async refresh(): Promise<void> {
		if (this.disposed) return;
		if (this.inFlight) {
			this.pending = true;
			return;
		}

		const cwd = this.getCwd();
		if (!cwd) return;

		this.inFlight = true;
		let snapshot: GitSnapshot | undefined;
		try {
			snapshot = await this.collect(cwd, this.getConfig());
		} catch {
			snapshot = emptyGitSnapshot("unknown");
		}
		try {
			this.consecutiveFailures = snapshot.repo ? 0 : this.consecutiveFailures + 1;
			if (!this.disposed) this.onSnapshot(cwd, snapshot);
		} finally {
			this.inFlight = false;
			if (this.disposed) return;
			if (this.pending) {
				const pendingDelay = this.pendingImmediate ? 0 : this.getConfig().refreshDebounceMs;
				this.pending = false;
				this.pendingImmediate = false;
				this.scheduleAfter(pendingDelay);
			} else {
				this.scheduleAfter(nextGitRefreshDelay(snapshot, this.getConfig(), this.consecutiveFailures));
			}
		}
	}
}
