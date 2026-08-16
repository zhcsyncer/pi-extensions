import { strict as assert } from "node:assert";
import { emptyGitSnapshot, GitRefresher, parseGitStatus } from "../git.js";
import type { GitConfig, GitSnapshot } from "../types.js";

const config: GitConfig = {
	showDirty: true,
	showAheadBehind: true,
	showBaseBehind: true,
	shaMode: "off",
	worktreeSummary: "status",
	timeoutMs: 1000,
	refreshDebounceMs: 250,
	pollIntervalMs: 15000,
};

interface ScheduledTimer {
	delay: number;
	callback: () => void;
	unrefCalled: boolean;
	cancelled: boolean;
	handle: NodeJS.Timeout;
}

function createScheduler() {
	const timers: ScheduledTimer[] = [];
	const setTimer = (callback: () => void, delay: number): NodeJS.Timeout => {
		const handle = {
			unref: () => {
				timer.unrefCalled = true;
				return handle;
			},
		} as NodeJS.Timeout;
		const timer: ScheduledTimer = { callback, delay, unrefCalled: false, cancelled: false, handle };
		timers.push(timer);
		return handle;
	};
	return {
		timers,
		setTimer,
		clearTimer(timer: NodeJS.Timeout): void {
			const scheduled = timers.find((candidate) => candidate.handle === timer);
			if (scheduled) scheduled.cancelled = true;
		},
		async fire(index: number): Promise<void> {
			const timer = timers[index];
			assert.ok(timer, `timer ${index} exists`);
			if (timer.cancelled) return;
			timer.callback();
			await Promise.resolve();
			await Promise.resolve();
		},
	};
}

function repoSnapshot(branch: string): GitSnapshot {
	return parseGitStatus(`# branch.oid 1234567890abcdef1234567890abcdef12345678\n# branch.head ${branch}\n`, 1000);
}

async function assertDebouncedSchedule(): Promise<void> {
	const scheduler = createScheduler();
	const refresher = new GitRefresher(() => config, () => "/repo", () => {}, { setTimer: scheduler.setTimer });
	refresher.schedule(false);
	refresher.schedule(true);
	assert.equal(scheduler.timers.length, 2, "reschedule creates replacement timer");
	assert.equal(scheduler.timers[0]!.delay, 250, "first timer uses the configured trailing debounce delay");
	assert.equal(scheduler.timers[1]!.delay, 0, "second timer uses immediate delay");
	assert.equal(scheduler.timers[0]!.unrefCalled, true, "first timer unref called");
	assert.equal(scheduler.timers[1]!.unrefCalled, true, "second timer unref called");
	refresher.dispose();
}

async function assertTrailingDebounceUsesLatestTimer(): Promise<void> {
	const scheduler = createScheduler();
	let collects = 0;
	const refresher = new GitRefresher(
		() => config,
		() => "/repo",
		() => {},
		{
			collect: async () => {
				collects++;
				return repoSnapshot("main");
			},
			setTimer: scheduler.setTimer,
			clearTimer: scheduler.clearTimer,
		},
	);
	refresher.schedule(false);
	refresher.schedule(false);
	assert.equal(scheduler.timers[0]?.cancelled, true, "trailing debounce should cancel the earlier timer");
	await scheduler.fire(0);
	assert.equal(collects, 0, "cancelled debounce timer should not collect");
	await scheduler.fire(1);
	assert.equal(collects, 1, "latest trailing debounce timer should collect exactly once");
	refresher.dispose();
}

async function assertRepoPollAfterSnapshot(): Promise<void> {
	const scheduler = createScheduler();
	const seen: Array<{ cwd: string; snapshot: GitSnapshot }> = [];
	const refresher = new GitRefresher(
		() => config,
		() => "/repo",
		(cwd, snapshot) => seen.push({ cwd, snapshot }),
		{ collect: async () => repoSnapshot("main"), setTimer: scheduler.setTimer },
	);
	refresher.schedule(true);
	await scheduler.fire(0);
	assert.equal(seen.length, 1, "snapshot delivered");
	assert.equal(seen[0]!.cwd, "/repo", "snapshot cwd");
	assert.equal(seen[0]!.snapshot.branch, "main", "snapshot branch");
	assert.equal(scheduler.timers[1]!.delay, 15000, "repo schedules the fallback poll delay");
	refresher.dispose();
}

async function assertNonRepoRetryAfterUnknown(): Promise<void> {
	const scheduler = createScheduler();
	const seen: GitSnapshot[] = [];
	const refresher = new GitRefresher(
		() => config,
		() => "/not-repo",
		(_cwd, snapshot) => seen.push(snapshot),
		{ collect: async () => emptyGitSnapshot("unknown", 2000), setTimer: scheduler.setTimer },
	);
	refresher.schedule(true);
	await scheduler.fire(0);
	assert.equal(seen.length, 1, "non-repo snapshot delivered");
	assert.equal(seen[0]!.repo, false, "non-repo repo=false");
	assert.equal(scheduler.timers[1]!.delay, 30_000, "non-repo schedules slow retry");
	refresher.dispose();
}

async function assertPendingDebouncedRefreshKeepsTrailingDelay(): Promise<void> {
	const scheduler = createScheduler();
	let resolveFirst!: (snapshot: GitSnapshot) => void;
	const first = new Promise<GitSnapshot>((resolve) => {
		resolveFirst = resolve;
	});
	const refresher = new GitRefresher(
		() => config,
		() => "/repo",
		() => {},
		{ collect: async () => first, setTimer: scheduler.setTimer },
	);
	refresher.schedule(true);
	await scheduler.fire(0);
	refresher.schedule(false);
	refresher.schedule(false);
	resolveFirst(repoSnapshot("main"));
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(scheduler.timers[1]?.delay, 250, "in-flight debounced events should keep one trailing debounce instead of refreshing immediately");
	refresher.dispose();
}

async function assertPendingRefreshUsesLatestCwd(): Promise<void> {
	const scheduler = createScheduler();
	let cwd = "/old";
	let resolveFirst!: (snapshot: GitSnapshot) => void;
	const collectCalls: string[] = [];
	const seen: Array<{ cwd: string; branch: string | null }> = [];
	const first = new Promise<GitSnapshot>((resolve) => {
		resolveFirst = resolve;
	});
	const refresher = new GitRefresher(
		() => config,
		() => cwd,
		(snapshotCwd, snapshot) => seen.push({ cwd: snapshotCwd, branch: snapshot.branch }),
		{
			collect: async (snapshotCwd) => {
				collectCalls.push(snapshotCwd);
				if (collectCalls.length === 1) return first;
				return repoSnapshot("new");
			},
			setTimer: scheduler.setTimer,
		},
	);

	refresher.schedule(true);
	await scheduler.fire(0);
	cwd = "/new";
	refresher.schedule(true);
	assert.equal(collectCalls.length, 1, "second schedule is pending while in-flight");
	resolveFirst(repoSnapshot("old"));
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(scheduler.timers[1]!.delay, 0, "pending refresh scheduled immediately");
	await scheduler.fire(1);

	assert.deepEqual(collectCalls, ["/old", "/new"], "pending refresh uses latest cwd");
	assert.deepEqual(seen, [
		{ cwd: "/old", branch: "old" },
		{ cwd: "/new", branch: "new" },
	]);
	refresher.dispose();
}

async function assertFailuresBackOffSafely(): Promise<void> {
	const scheduler = createScheduler();
	const seen: GitSnapshot[] = [];
	const refresher = new GitRefresher(
		() => config,
		() => "/repo",
		(_cwd, snapshot) => seen.push(snapshot),
		{ collect: async () => { throw new Error("slow or failed git"); }, setTimer: scheduler.setTimer },
	);
	refresher.schedule(true);
	await scheduler.fire(0);
	assert.equal(seen[0]?.repo, false, "collection failure should degrade to an unknown non-repo snapshot");
	assert.equal(scheduler.timers[1]?.delay, 30_000, "first failure should retry slowly");
	await scheduler.fire(1);
	assert.equal(scheduler.timers[2]?.delay, 60_000, "repeated failures should exponentially back off");
	await scheduler.fire(2);
	assert.equal(scheduler.timers[3]?.delay, 120_000, "failure backoff should cap at a safe maximum");
	refresher.dispose();
}

async function assertDisposeStopsDeliveryAndPolling(): Promise<void> {
	const scheduler = createScheduler();
	let resolveSnapshot!: (snapshot: GitSnapshot) => void;
	const promise = new Promise<GitSnapshot>((resolve) => {
		resolveSnapshot = resolve;
	});
	let delivered = 0;
	const refresher = new GitRefresher(
		() => config,
		() => "/repo",
		() => delivered++,
		{ collect: async () => promise, setTimer: scheduler.setTimer },
	);
	refresher.schedule(true);
	await scheduler.fire(0);
	refresher.dispose();
	resolveSnapshot(repoSnapshot("main"));
	await Promise.resolve();
	await Promise.resolve();
	assert.equal(delivered, 0, "disposed refresher does not deliver in-flight snapshot");
	assert.equal(scheduler.timers.length, 1, "disposed refresher does not schedule poll");
}

await assertDebouncedSchedule();
await assertTrailingDebounceUsesLatestTimer();
await assertRepoPollAfterSnapshot();
await assertNonRepoRetryAfterUnknown();
await assertPendingDebouncedRefreshKeepsTrailingDelay();
await assertPendingRefreshUsesLatestCwd();
await assertFailuresBackOffSafely();
await assertDisposeStopsDeliveryAndPolling();

console.log("✓ git refresher stale/unknown/workspace checks passed");
