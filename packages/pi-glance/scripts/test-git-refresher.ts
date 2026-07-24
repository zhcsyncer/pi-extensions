import { strict as assert } from "node:assert";
import { emptyGitSnapshot, GitRefresher, parseGitStatus } from "../git.js";
import type { GitConfig, GitSnapshot } from "../types.js";

const config: GitConfig = {
	showDirty: true,
	showAheadBehind: true,
	shaMode: "off",
	timeoutMs: 1000,
	refreshDebounceMs: 1500,
	pollIntervalMs: 5000,
};

interface ScheduledTimer {
	delay: number;
	callback: () => void;
	unrefCalled: boolean;
}

function createScheduler() {
	const timers: ScheduledTimer[] = [];
	const setTimer = (callback: () => void, delay: number): NodeJS.Timeout => {
		const timer: ScheduledTimer = { callback, delay, unrefCalled: false };
		timers.push(timer);
		return {
			unref: () => {
				timer.unrefCalled = true;
				return undefined as unknown as NodeJS.Timeout;
			},
		} as NodeJS.Timeout;
	};
	return {
		timers,
		setTimer,
		async fire(index: number): Promise<void> {
			const timer = timers[index];
			assert.ok(timer, `timer ${index} exists`);
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
	assert.equal(scheduler.timers[0]!.delay, 1500, "first timer uses debounce delay");
	assert.equal(scheduler.timers[1]!.delay, 0, "second timer uses immediate delay");
	assert.equal(scheduler.timers[0]!.unrefCalled, true, "first timer unref called");
	assert.equal(scheduler.timers[1]!.unrefCalled, true, "second timer unref called");
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
	assert.equal(scheduler.timers[1]!.delay, 5000, "repo schedules poll delay");
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
await assertRepoPollAfterSnapshot();
await assertNonRepoRetryAfterUnknown();
await assertPendingRefreshUsesLatestCwd();
await assertDisposeStopsDeliveryAndPolling();

console.log("✓ git refresher stale/unknown/workspace checks passed");
