import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { collectGitSnapshot, nextGitRefreshDelay, parseGitStatus } from "../git.js";
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
	timeoutMs: 1000,
	refreshDebounceMs: 1500,
	pollIntervalMs: 5000,
};

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
	assert.equal(nextGitRefreshDelay(repoSnapshot, testConfig), 5000, "repo poll delay");
	assert.equal(nextGitRefreshDelay(repoSnapshot, { ...testConfig, pollIntervalMs: 10 }), 1000, "repo min poll delay");
	assert.equal(nextGitRefreshDelay(nonRepoSnapshot, testConfig), 30_000, "non-git retry delay");
}

for (const fixture of fixtures) {
	assertFixture(fixture);
}
assertRefreshDelays();
await assertNonGitSnapshot();

console.log(`✓ ${fixtures.length} git parser fixtures passed`);
console.log("✓ git failure and refresh-delay checks passed");
