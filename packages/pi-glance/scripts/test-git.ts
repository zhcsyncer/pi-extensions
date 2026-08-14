import { strict as assert } from "node:assert";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGitSnapshot, nextGitRefreshDelay, parseGitNumstat, parseGitStatus } from "../git.js";
import type { GitConfig, GitSnapshot } from "../types.js";

type ExpectedSnapshot = Partial<Omit<GitSnapshot, "updatedAt">>;

const NOW = 1_700_000_000_000;

interface Fixture {
	name: string;
	input: string;
	expected: ExpectedSnapshot;
}

const fixtures: Fixture[] = [
	{
		name: "clean branch",
		input: `# branch.oid 1234567890abcdef1234567890abcdef12345678
# branch.head main
`,
		expected: {
			repo: true,
			branch: "main",
			detached: false,
			sha: "1234567",
			status: "clean",
			dirty: false,
		},
	},
	{
		name: "untracked dirty",
		input: `# branch.oid 1234567890abcdef1234567890abcdef12345678
# branch.head main
? scratch.txt
`,
		expected: {
			branch: "main",
			status: "dirty",
			dirty: true,
			untracked: 1,
			staged: 0,
			unstaged: 0,
		},
	},
	{
		name: "staged change",
		input: `# branch.oid 1234567890abcdef1234567890abcdef12345678
# branch.head main
1 A. N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb file.txt
`,
		expected: {
			status: "dirty",
			dirty: true,
			staged: 1,
			unstaged: 0,
			untracked: 0,
		},
	},
	{
		name: "unstaged change",
		input: `# branch.oid 1234567890abcdef1234567890abcdef12345678
# branch.head main
1 .M N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb file.txt
`,
		expected: {
			status: "dirty",
			dirty: true,
			staged: 0,
			unstaged: 1,
			untracked: 0,
		},
	},
	{
		name: "renamed staged and unstaged",
		input: `# branch.oid 1234567890abcdef1234567890abcdef12345678
# branch.head main
2 RM N... 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb R100 new.txt	old.txt
`,
		expected: {
			status: "dirty",
			dirty: true,
			staged: 1,
			unstaged: 1,
		},
	},
	{
		name: "conflict",
		input: `# branch.oid 1234567890abcdef1234567890abcdef12345678
# branch.head main
u UU N... 100644 100644 100644 100644 aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb cccccccccccccccccccccccccccccccccccccccc conflict.txt
`,
		expected: {
			status: "conflict",
			dirty: true,
			conflicts: 1,
			staged: 0,
			unstaged: 0,
		},
	},
	{
		name: "ahead",
		input: `# branch.oid 1234567890abcdef1234567890abcdef12345678
# branch.head main
# branch.upstream origin/main
# branch.ab +2 -0
`,
		expected: {
			branch: "main",
			upstream: "origin/main",
			ahead: 2,
			behind: 0,
			status: "clean",
			dirty: false,
		},
	},
	{
		name: "behind",
		input: `# branch.oid 1234567890abcdef1234567890abcdef12345678
# branch.head main
# branch.upstream origin/main
# branch.ab +0 -3
`,
		expected: {
			upstream: "origin/main",
			ahead: 0,
			behind: 3,
			status: "clean",
			dirty: false,
		},
	},
	{
		name: "ahead and behind",
		input: `# branch.oid 1234567890abcdef1234567890abcdef12345678
# branch.head feature
# branch.upstream origin/feature
# branch.ab +4 -5
`,
		expected: {
			branch: "feature",
			upstream: "origin/feature",
			ahead: 4,
			behind: 5,
			status: "clean",
		},
	},
	{
		name: "detached head",
		input: `# branch.oid abcdef1234567890abcdef1234567890abcdef12
# branch.head (detached)
`,
		expected: {
			branch: null,
			detached: true,
			sha: "abcdef1",
			status: "clean",
		},
	},
	{
		name: "initial unborn branch",
		input: `# branch.oid (initial)
# branch.head main
`,
		expected: {
			branch: "main",
			detached: false,
			sha: null,
			status: "clean",
			dirty: false,
		},
	},
	{
		name: "stash header ignored",
		input: `# branch.oid 1234567890abcdef1234567890abcdef12345678
# branch.head main
# stash 2
`,
		expected: {
			branch: "main",
			status: "clean",
			dirty: false,
		},
	},
];

function assertFixture(fixture: Fixture): void {
	const actual = parseGitStatus(fixture.input, NOW);
	for (const [key, value] of Object.entries(fixture.expected)) {
		assert.deepEqual(actual[key as keyof GitSnapshot], value, `${fixture.name}: ${key}`);
	}
	assert.equal(actual.updatedAt, NOW, `${fixture.name}: updatedAt`);
}

const testConfig: GitConfig = {
	showDirty: true,
	showAheadBehind: true,
	shaMode: "off",
	worktreeSummary: "above-compact",
	timeoutMs: 1000,
	refreshDebounceMs: 250,
	pollIntervalMs: 15000,
};

function assertNulPorcelainPathsAndDeduplication(): void {
	const hash = "a".repeat(40);
	const renamed = "new name\nwith-tab\t.ts";
	const original = "old name.ts";
	const conflicted = "conflict path.ts";
	const untracked = "untracked\npath.txt";
	const output = [
		"# branch.oid 1234567890abcdef1234567890abcdef12345678",
		"# branch.head main",
		`2 RM N... 100644 100644 100644 ${hash} ${hash} R100 ${renamed}`,
		original,
		`u UU N... 100644 100644 100644 100644 ${hash} ${hash} ${hash} ${conflicted}`,
		`? ${untracked}`,
		"",
	].join("\0");
	const snapshot = parseGitStatus(output, NOW, { additions: 12, deletions: 7 });
	assert.deepEqual(snapshot.worktree.staged, [renamed], "rename destination should remain staged with literal special characters");
	assert.deepEqual(snapshot.worktree.unstaged, [renamed], "same rename destination should remain unstaged without double-counting files");
	assert.deepEqual(snapshot.worktree.conflicts, [conflicted], "conflict path should be preserved literally");
	assert.deepEqual(snapshot.worktree.untracked, [untracked], "untracked special path should be preserved literally");
	assert.equal(snapshot.worktree.files, 3, "unique current paths should deduplicate staged and unstaged categories");
	assert.equal(snapshot.worktree.staged.includes(original), false, "rename source should not count as a second current working-tree file");
	assert.equal(snapshot.worktree.additions, 12, "parsed tracked additions should attach to the working-tree snapshot");
	assert.equal(snapshot.worktree.deletions, 7, "parsed tracked deletions should attach to the working-tree snapshot");
}

function assertNumstatParsing(): void {
	assert.deepEqual(parseGitNumstat("3\t2\tplain.ts\0"), { additions: 3, deletions: 2 }, "plain numstat should sum additions/deletions");
	assert.deepEqual(
		parseGitNumstat(["5\t4\t", "old name.ts", "new name.ts", "1\t2\tother.ts", ""].join("\0")),
		{ additions: 6, deletions: 6 },
		"-z rename path records should not be mistaken for extra numstat rows",
	);
	assert.deepEqual(parseGitNumstat("-\t-\tbinary.png\0"), { additions: null, deletions: null }, "binary numstat should make line totals unknown rather than guessing");
	assert.deepEqual(parseGitNumstat(""), { additions: 0, deletions: 0 }, "empty tracked diff should report zero line changes");
}

function runGit(cwd: string, args: string[]): Promise<void> {
	return new Promise((resolve, reject) => {
		execFile("git", args, { cwd }, (error) => error ? reject(error) : resolve());
	});
}

async function initRepository(prefix: string): Promise<string> {
	const dir = await mkdtemp(join(tmpdir(), prefix));
	await runGit(dir, ["init", "--quiet"]);
	await runGit(dir, ["config", "user.name", "Pi Glance Test"]);
	await runGit(dir, ["config", "user.email", "pi-glance@example.invalid"]);
	return dir;
}

async function assertUnbornAndSpecialPathCollection(): Promise<void> {
	const dir = await initRepository("pi-glance-unborn-");
	const tracked = "tracked name\nfile.txt";
	const untracked = "untracked name.txt";
	try {
		await writeFile(join(dir, tracked), "first\nsecond\n", "utf8");
		await runGit(dir, ["add", "--", tracked]);
		await writeFile(join(dir, untracked), "not inspected by diff stats\n", "utf8");
		const snapshot = await collectGitSnapshot(dir, testConfig);
		assert.equal(snapshot.sha, null, "unborn repository should preserve a null HEAD sha");
		assert.deepEqual(snapshot.worktree.staged, [tracked], "unborn staged special path should be preserved");
		assert.deepEqual(snapshot.worktree.untracked, [untracked], "unborn untracked path should count without reading it for numstat");
		assert.equal(snapshot.worktree.files, 2, "unborn tracked and untracked paths should both count");
		assert.equal(snapshot.worktree.additions, 2, "unborn tracked stats should compare the working tree against the empty tree");
		assert.equal(snapshot.worktree.deletions, 0, "unborn empty-tree comparison should not invent deletions");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function assertRenameAndBinaryCollection(): Promise<void> {
	const dir = await initRepository("pi-glance-rename-");
	const original = "old name.txt";
	const renamed = "new\tname.txt";
	try {
		await writeFile(join(dir, original), "before\n", "utf8");
		await writeFile(join(dir, "binary.dat"), Buffer.from([0, 1, 2, 3]));
		await runGit(dir, ["add", "."]);
		await runGit(dir, ["commit", "--quiet", "-m", "baseline"]);
		await runGit(dir, ["mv", "--", original, renamed]);
		await writeFile(join(dir, renamed), "after\nextra\n", "utf8");
		let snapshot = await collectGitSnapshot(dir, testConfig);
		assert.deepEqual(snapshot.worktree.staged, [renamed], "rename destination should be staged once");
		assert.deepEqual(snapshot.worktree.unstaged, [renamed], "post-rename edit should share the same unique destination path");
		assert.equal(snapshot.worktree.files, 1, "rename source and destination should count as one current file");
		assert.equal(snapshot.worktree.staged.includes(original), false, "rename source should not remain in current staged paths");

		await writeFile(join(dir, "binary.dat"), Buffer.from([0, 9, 8, 7, 6]));
		snapshot = await collectGitSnapshot(dir, testConfig);
		assert.equal(snapshot.worktree.files, 2, "binary change should still affect the unique file count");
		assert.equal(snapshot.worktree.additions, null, "binary tracked changes should omit incomplete addition totals");
		assert.equal(snapshot.worktree.deletions, null, "binary tracked changes should omit incomplete deletion totals");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

async function assertNonGitSnapshot(): Promise<void> {
	const dir = await mkdtemp(join(tmpdir(), "pi-glance-git-"));
	try {
		const snapshot = await collectGitSnapshot(dir, testConfig);
		assert.equal(snapshot.repo, false, "non-git: repo");
		assert.equal(snapshot.status, "unknown", "non-git: status");
		assert.equal(snapshot.dirty, false, "non-git: dirty");
	} finally {
		await rm(dir, { recursive: true, force: true });
	}
}

function assertRefreshDelays(): void {
	const repoSnapshot = parseGitStatus("# branch.oid 1234567890abcdef1234567890abcdef12345678\n# branch.head main\n", NOW);
	const nonRepoSnapshot = { ...repoSnapshot, repo: false };
	assert.equal(nextGitRefreshDelay(repoSnapshot, testConfig), 15000, "repo poll delay");
	assert.equal(nextGitRefreshDelay(repoSnapshot, { ...testConfig, pollIntervalMs: 10 }), 1000, "repo min poll delay");
	assert.equal(nextGitRefreshDelay(nonRepoSnapshot, testConfig, 1), 30_000, "first non-git/failure retry delay");
	assert.equal(nextGitRefreshDelay(nonRepoSnapshot, testConfig, 2), 60_000, "repeated failures should back off");
	assert.equal(nextGitRefreshDelay(nonRepoSnapshot, testConfig, 3), 120_000, "failure backoff should cap safely");
}

for (const fixture of fixtures) {
	assertFixture(fixture);
}
assertNulPorcelainPathsAndDeduplication();
assertNumstatParsing();
assertRefreshDelays();
await assertNonGitSnapshot();
await assertUnbornAndSpecialPathCollection();
await assertRenameAndBinaryCollection();

console.log(`✓ ${fixtures.length} git parser fixtures plus NUL/numstat contracts passed`);
console.log("✓ git failure, unborn, rename, binary, and refresh-delay checks passed");
