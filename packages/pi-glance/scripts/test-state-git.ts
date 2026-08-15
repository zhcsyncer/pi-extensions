import { strict as assert } from "node:assert";
import { parseGitStatus } from "../git.js";
import { refreshWorkspace, setGitSnapshot } from "../state.js";
import { testState } from "./helpers.js";

function stateFor(cwd: string) {
	return testState({ workspace: { name: cwd.split("/").pop() || cwd, path: cwd } });
}

function inputsFor(cwd: string): { cwd: string } {
	return { cwd };
}

const oldState = stateFor("/old");
const oldSnapshot = parseGitStatus("# branch.oid 1234567890abcdef1234567890abcdef12345678\n# branch.head old\n", 1000);
assert.equal(setGitSnapshot(oldState, "/old", oldSnapshot), true, "old snapshot accepted");
assert.equal(oldState.git.repo, true, "old repo visible");
assert.equal(oldState.git.branch, "old", "old branch visible");
assert.equal(oldState.version, 1, "snapshot touches state");

assert.equal(setGitSnapshot(oldState, "/other", parseGitStatus("# branch.oid 1234567890abcdef1234567890abcdef12345678\n# branch.head other\n", 2000)), false, "mismatched cwd snapshot ignored");
assert.equal(oldState.git.branch, "old", "mismatched snapshot does not replace current git");

assert.equal(refreshWorkspace(oldState, inputsFor("/new")), true, "workspace change detected");
assert.equal(oldState.workspace.path, "/new", "workspace path changed");
assert.equal(oldState.git.repo, false, "workspace change clears git repo");
assert.equal(oldState.git.branch, null, "workspace change clears branch");
assert.equal(oldState.git.status, "unknown", "workspace change returns git to unknown");

const newSnapshot = parseGitStatus("# branch.oid abcdef1234567890abcdef1234567890abcdef12\n# branch.head new\n", 3000);
assert.equal(setGitSnapshot(oldState, "/old", oldSnapshot), false, "stale old cwd snapshot ignored after workspace switch");
assert.equal(oldState.git.repo, false, "stale old cwd does not restore git repo");
assert.equal(setGitSnapshot(oldState, "/new", newSnapshot), true, "new cwd snapshot accepted");
assert.equal(oldState.git.branch, "new", "new branch accepted");

const changedStats = {
	...newSnapshot,
	worktree: { ...newSnapshot.worktree, files: 1, unstaged: ["changed.ts"], additions: 9, deletions: 4 },
};
assert.equal(setGitSnapshot(oldState, "/new", changedStats), true, "working-tree path/stat changes should invalidate the cached state even when branch metadata is unchanged");
assert.equal(oldState.git.worktree.additions, 9, "updated tracked additions should reach render state");
const sameStatsNewTimestamp = { ...changedStats, updatedAt: 4000 };
assert.equal(setGitSnapshot(oldState, "/new", sameStatsNewTimestamp), false, "timestamp-only refresh should not trigger a render");
assert.equal(oldState.git.updatedAt, 4000, "timestamp-only refresh should still update freshness metadata");

console.log("✓ git state workspace/stale snapshot checks passed");
