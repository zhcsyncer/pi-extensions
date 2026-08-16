import { execFile } from "node:child_process";
import { statSync } from "node:fs";
import { isAbsolute, resolve } from "node:path";
import type { GitConfig, GitSnapshot, GitStatus, GitWorktreeSnapshot } from "./types.js";

const GIT_STATUS_ARGS = ["--no-optional-locks", "status", "--porcelain=v2", "--branch", "--show-stash", "-z"] as const;
const GIT_MAX_BUFFER = 2 * 1024 * 1024;
const DEFAULT_POLL_INTERVAL_MS = 15_000;
const MIN_POLL_INTERVAL_MS = 1_000;
const NO_REPO_RETRY_MS = 30_000;
const MAX_FAILURE_RETRY_MS = 120_000;
const GIT_BASE_REF = "origin/main";
const GIT_BASE_FETCH_REMOTE = "origin";
const GIT_BASE_FETCH_BRANCH = "main";
const GIT_BASE_FETCH_STALE_MS = 12 * 60 * 1000;
const GIT_BASE_FETCH_DEDUPE_MS = 30_000;
const GIT_BASE_FETCH_TIMEOUT_MS = 10_000;

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

type GitExec = (cwd: string, args: readonly string[], timeout: number, input?: string) => Promise<GitCommandResult>;

export type GitBaseRefFetchReason = "session" | "focus" | "stale";

interface BaseBehindCacheEntry {
	headSha: string | null;
	baseSha: string | null;
	behind: number;
}

interface BaseRefFetchState {
	lastFetchedAt: number;
	lastAttemptAt: number;
	inFlight?: Promise<void>;
}

const baseBehindCache = new Map<string, BaseBehindCacheEntry>();
const baseRefFetchStates = new Map<string, BaseRefFetchState>();

export interface CollectGitSnapshotOptions {
	exec?: GitExec;
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
		baseBehind: 0,
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
		baseBehind: 0,
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

async function collectTrackedNumstat(cwd: string, config: GitConfig, snapshot: GitSnapshot, exec: GitExec): Promise<GitNumstat | undefined> {
	if (snapshot.worktree.staged.length === 0 && snapshot.worktree.unstaged.length === 0 && snapshot.worktree.conflicts.length === 0) {
		return { additions: 0, deletions: 0 };
	}

	let base = "HEAD";
	if (!snapshot.sha) {
		const emptyTree = await exec(cwd, ["--no-optional-locks", "hash-object", "-t", "tree", "--stdin"], config.timeoutMs, "");
		if (!emptyTree.ok || !emptyTree.stdout.trim()) return undefined;
		base = emptyTree.stdout.trim();
	}
	const result = await exec(
		cwd,
		["--no-optional-locks", "diff", "--numstat", "-z", "--no-ext-diff", "--no-textconv", base, "--"],
		config.timeoutMs,
	);
	return result.ok ? parseGitNumstat(result.stdout) : undefined;
}

export function parseGitLeftRightCount(output: string): { left: number; right: number } | undefined {
	const match = output.trim().match(/^([0-9]+)\s+([0-9]+)$/);
	if (!match) return undefined;
	return { left: Number.parseInt(match[1]!, 10), right: Number.parseInt(match[2]!, 10) };
}

function gitCacheKey(commonDir: string | undefined, cwd: string): string {
	return commonDir ?? resolve(cwd);
}

async function resolveGitCommonDir(cwd: string, exec: GitExec, timeout: number): Promise<string | undefined> {
	const result = await exec(cwd, ["--no-optional-locks", "rev-parse", "--git-common-dir"], timeout);
	if (!result.ok) return undefined;
	const raw = result.stdout.trim();
	if (!raw) return undefined;
	return isAbsolute(raw) ? raw : resolve(cwd, raw);
}

async function resolveGitCommit(cwd: string, exec: GitExec, timeout: number, ref: string): Promise<string | undefined> {
	const result = await exec(cwd, ["--no-optional-locks", "rev-parse", "--verify", "--quiet", `${ref}^{commit}`], timeout);
	const sha = result.stdout.trim().toLowerCase();
	if (!result.ok || !/^[0-9a-f]{40}$/.test(sha)) return undefined;
	return sha;
}

async function gitBaseRefAgeMs(cwd: string, exec: GitExec, timeout: number, now: number): Promise<number | undefined> {
	const pathResult = await exec(cwd, ["--no-optional-locks", "rev-parse", "--git-path", `refs/remotes/${GIT_BASE_REF}`], timeout);
	if (!pathResult.ok) return undefined;
	const raw = pathResult.stdout.trim();
	if (!raw) return undefined;
	const refPath = isAbsolute(raw) ? raw : resolve(cwd, raw);
	try {
		return Math.max(0, now - statSync(refPath).mtimeMs);
	} catch {
		return undefined;
	}
}

function baseRefFetchState(commonDir: string): BaseRefFetchState {
	const existing = baseRefFetchStates.get(commonDir);
	if (existing) return existing;
	const created: BaseRefFetchState = { lastFetchedAt: 0, lastAttemptAt: 0 };
	baseRefFetchStates.set(commonDir, created);
	return created;
}

export function resetGitBaseCaches(): void {
	baseBehindCache.clear();
	baseRefFetchStates.clear();
}

async function collectBaseBehind(cwd: string, config: GitConfig, snapshot: GitSnapshot, exec: GitExec): Promise<number> {
	if (!snapshot.repo || !config.showBaseBehind) return 0;
	const [commonDir, headSha, baseSha] = await Promise.all([
		resolveGitCommonDir(cwd, exec, config.timeoutMs),
		resolveGitCommit(cwd, exec, config.timeoutMs, "HEAD"),
		resolveGitCommit(cwd, exec, config.timeoutMs, GIT_BASE_REF),
	]);
	if (!baseSha) return 0;
	const cacheKey = gitCacheKey(commonDir, cwd);
	const cached = baseBehindCache.get(cacheKey);
	if (cached && cached.headSha === (headSha ?? null) && cached.baseSha === baseSha) return cached.behind;
	if (!headSha) {
		baseBehindCache.set(cacheKey, { headSha: null, baseSha, behind: 0 });
		return 0;
	}
	const counted = await exec(cwd, ["--no-optional-locks", "rev-list", "--left-right", "--count", `${GIT_BASE_REF}...HEAD`], config.timeoutMs);
	const parsed = counted.ok ? parseGitLeftRightCount(counted.stdout) : undefined;
	const behind = parsed?.left ?? 0;
	baseBehindCache.set(cacheKey, { headSha, baseSha, behind });
	return behind;
}

export interface GitBaseRefFetchOptions {
	exec?: GitExec;
	nowMs?: () => number;
	timeoutMs?: number;
	staleMs?: number;
}

function shouldSkipBaseRefFetch(state: BaseRefFetchState, now: number, reason: GitBaseRefFetchReason, staleMs: number): boolean {
	if (state.inFlight) return true;
	if (state.lastAttemptAt > 0 && now - state.lastAttemptAt < GIT_BASE_FETCH_DEDUPE_MS) return true;
	if (reason !== "stale") return false;
	if (state.lastFetchedAt > 0 && now - state.lastFetchedAt < staleMs) return true;
	return false;
}

export async function maybeFetchGitBaseRef(
	cwd: string,
	reason: GitBaseRefFetchReason,
	options: GitBaseRefFetchOptions = {},
): Promise<boolean> {
	const exec = options.exec ?? execGit;
	const nowMs = options.nowMs ?? Date.now;
	const timeoutMs = options.timeoutMs ?? GIT_BASE_FETCH_TIMEOUT_MS;
	const staleMs = options.staleMs ?? GIT_BASE_FETCH_STALE_MS;
	const now = nowMs();
	const commonDir = await resolveGitCommonDir(cwd, exec, timeoutMs);
	if (!commonDir) return false;
	const state = baseRefFetchState(commonDir);
	if (shouldSkipBaseRefFetch(state, now, reason, staleMs)) return false;
	state.lastAttemptAt = now;
	let fetched = false;
	const work = (async () => {
		try {
			if (reason === "stale") {
				const refAge = await gitBaseRefAgeMs(cwd, exec, timeoutMs, now);
				if (refAge !== undefined && refAge < staleMs) return;
			}
			const result = await exec(
				cwd,
				["--no-optional-locks", "fetch", "--no-tags", "--quiet", GIT_BASE_FETCH_REMOTE, GIT_BASE_FETCH_BRANCH],
				GIT_BASE_FETCH_TIMEOUT_MS,
			);
			if (!result.ok) return;
			state.lastFetchedAt = nowMs();
			baseBehindCache.delete(commonDir);
			fetched = true;
		} finally {
			state.inFlight = undefined;
		}
	})();
	state.inFlight = work;
	await work;
	return fetched;
}

export async function collectGitSnapshot(cwd: string, config: GitConfig, options: CollectGitSnapshotOptions = {}): Promise<GitSnapshot> {
	const exec = options.exec ?? execGit;
	const statusResult = await exec(cwd, GIT_STATUS_ARGS, config.timeoutMs);
	if (!statusResult.ok) return emptyGitSnapshot("unknown");
	const snapshot = parseGitStatus(statusResult.stdout);
	const [numstat, baseBehind] = await Promise.all([
		collectTrackedNumstat(cwd, config, snapshot, exec),
		collectBaseBehind(cwd, config, snapshot, exec),
	]);
	return {
		...snapshot,
		baseBehind,
		worktree: numstat
			? { ...snapshot.worktree, additions: numstat.additions, deletions: numstat.deletions }
			: snapshot.worktree,
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
