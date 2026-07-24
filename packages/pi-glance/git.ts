import { execFile } from "node:child_process";
import type { GitConfig, GitSnapshot, GitStatus } from "./types.js";

const GIT_ARGS = ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--show-stash"] as const;
const GIT_MAX_BUFFER = 512 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 5000;
const MIN_POLL_INTERVAL_MS = 1000;
const NO_REPO_RETRY_MS = 30_000;

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

function addStatusPair(pair: string, counts: GitCounts): void {
	if (isChangedStatus(pair[0])) counts.staged++;
	if (isChangedStatus(pair[1])) counts.unstaged++;
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

function parseStatusRecord(line: string, counts: GitCounts): void {
	if (line.startsWith("1 ") || line.startsWith("2 ")) {
		addStatusPair(line.slice(2, 4), counts);
		return;
	}
	if (line.startsWith("? ")) {
		counts.untracked++;
		return;
	}
	if (line.startsWith("u ")) {
		counts.conflicts++;
	}
}

function snapshotStatus(counts: GitCounts): GitStatus {
	if (counts.conflicts > 0) return "conflict";
	if (counts.staged > 0 || counts.unstaged > 0 || counts.untracked > 0) return "dirty";
	return "clean";
}

export function parseGitStatus(output: string, now = Date.now()): GitSnapshot {
	const branch = emptyBranchInfo();
	const counts: GitCounts = { staged: 0, unstaged: 0, untracked: 0, conflicts: 0 };

	for (const line of output.split(/\r?\n/)) {
		if (!line) continue;
		if (line.startsWith("# ")) parseBranchHeader(line, branch);
		else parseStatusRecord(line, counts);
	}

	const status = snapshotStatus(counts);
	return {
		repo: true,
		branch: branch.branch,
		detached: branch.detached,
		sha: branch.sha,
		upstream: branch.upstream,
		ahead: branch.ahead,
		behind: branch.behind,
		staged: counts.staged,
		unstaged: counts.unstaged,
		untracked: counts.untracked,
		conflicts: counts.conflicts,
		dirty: status !== "clean",
		status,
		updatedAt: now,
	};
}

export function collectGitSnapshot(cwd: string, config: GitConfig): Promise<GitSnapshot> {
	return new Promise((resolve) => {
		execFile("git", [...GIT_ARGS], { cwd, timeout: config.timeoutMs, maxBuffer: GIT_MAX_BUFFER }, (error, stdout) => {
			resolve(error ? emptyGitSnapshot("unknown") : parseGitStatus(stdout));
		});
	});
}

export function nextGitRefreshDelay(snapshot: GitSnapshot, config: GitConfig): number {
	if (!snapshot.repo) return NO_REPO_RETRY_MS;
	return Math.max(MIN_POLL_INTERVAL_MS, config.pollIntervalMs || DEFAULT_POLL_INTERVAL_MS);
}

interface GitRefresherOptions {
	collect?: (cwd: string, config: GitConfig) => Promise<GitSnapshot>;
	setTimer?: (callback: () => void, delay: number) => NodeJS.Timeout;
}

export class GitRefresher {
	private timer: NodeJS.Timeout | undefined;
	private inFlight = false;
	private pending = false;
	private disposed = false;
	private readonly collect: (cwd: string, config: GitConfig) => Promise<GitSnapshot>;
	private readonly setTimer: (callback: () => void, delay: number) => NodeJS.Timeout;

	constructor(
		private readonly getConfig: () => GitConfig,
		private readonly getCwd: () => string | undefined,
		private readonly onSnapshot: (cwd: string, snapshot: GitSnapshot) => void,
		options: GitRefresherOptions = {},
	) {
		this.collect = options.collect ?? collectGitSnapshot;
		this.setTimer = options.setTimer ?? setTimeout;
	}

	dispose(): void {
		this.disposed = true;
		this.clearTimer();
	}

	schedule(immediate = false): void {
		if (this.disposed) return;
		if (this.inFlight) {
			this.pending = true;
			this.clearTimer();
			return;
		}
		this.scheduleAfter(immediate ? 0 : this.getConfig().refreshDebounceMs);
	}

	private clearTimer(): void {
		if (this.timer) clearTimeout(this.timer);
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
			if (!this.disposed) this.onSnapshot(cwd, snapshot);
		} finally {
			this.inFlight = false;
			if (this.disposed) return;
			if (this.pending) {
				this.pending = false;
				this.scheduleAfter(0);
			} else if (snapshot) {
				this.scheduleAfter(nextGitRefreshDelay(snapshot, this.getConfig()));
			}
		}
	}
}
