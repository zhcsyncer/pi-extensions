import { strict as assert } from "node:assert";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	assertDiffWorktree, branchDiffTarget, compareDiffTarget, diffArgumentCompletions, listDiffRevisions,
	parseDiffCommand, prepareBranchDiff, resolveDiffRevision, workingTreeDiffTarget,
} from "../diff-target.js";
import { createDiffFixture } from "./diff-fixture.js";

assert.deepEqual(parseDiffCommand("  "), { mode: "menu" });
assert.deepEqual(parseDiffCommand(" worktree "), { mode: "worktree" });
assert.deepEqual(parseDiffCommand("branch"), { mode: "branch", base: undefined });
assert.deepEqual(parseDiffCommand("branch origin/release"), { mode: "branch", base: "origin/release" });
assert.deepEqual(parseDiffCommand("compare"), { mode: "compare", from: undefined, to: undefined });
assert.deepEqual(parseDiffCommand("compare\tHEAD~1"), { mode: "compare", from: "HEAD~1", to: undefined });
assert.deepEqual(parseDiffCommand("compare v1 main"), { mode: "compare", from: "v1", to: "main" });
for (const args of ["unknown", "worktree main", "branch main other", "compare a b c"]) {
	assert.throws(() => parseDiffCommand(args), /Unknown command or extra arguments/, args);
}
assert.deepEqual(diffArgumentCompletions("")?.map((item) => item.value), ["worktree", "branch", "compare"]);
assert.ok(diffArgumentCompletions("")?.every((item) => item.description));
assert.deepEqual(diffArgumentCompletions(" br")?.map((item) => item.value), ["branch"]);
assert.equal(diffArgumentCompletions("branch "), null, "ref arguments must not offer command completions");
assert.equal(diffArgumentCompletions("compare HEAD"), null);
assert.equal(diffArgumentCompletions("bad"), null);

// Integration: real Git repositories prove merge-base and endpoint semantics.
const repo = await createDiffFixture();
const outside = await mkdtemp(join(tmpdir(), "glance-not-git-"));
try {
	await assert.rejects(assertDiffWorktree(outside), /requires a Git working tree/);
	await assertDiffWorktree(repo.cwd);
	assert.equal((await workingTreeDiffTarget(repo.cwd)).unborn, true, "unborn worktrees should remain reviewable");
	assert.deepEqual(await listDiffRevisions(repo.cwd), []);
	await assert.rejects(prepareBranchDiff(repo.cwd), /No origin\/main or local main/);
	await assert.rejects(resolveDiffRevision(repo.cwd, "HEAD"), /HEAD has no valid commit/);

	const root = await repo.commit("Root content");
	await repo.git("tag", "-a", "v1", "-m", "Release root");
	const mainTip = await repo.commit("Main only", "main.txt");
	await repo.git("switch", "-c", "feature", root);
	const feature = await repo.commit("Searchable feature topic", "feature.txt");
	const branch = await prepareBranchDiff(repo.cwd);
	assert.equal(branch.base.label, "main", "local main should be the fallback without origin/main");
	assert.equal(branch.base.sha, mainTip);
	assert.equal(branch.mergeBase, root, "diverged branch review must use the ancestor, not main tip");
	assert.deepEqual(branchDiffTarget(branch, false).revisions, [root, feature]);
	assert.equal(branchDiffTarget(branch, false).includeUntracked, false);
	assert.match(branchDiffTarget(branch, false).description, /merge base.*committed only/);
	assert.deepEqual(branchDiffTarget(branch, true).revisions, [root]);
	assert.equal(branchDiffTarget(branch, true).includeUntracked, true);
	assert.match(branchDiffTarget(branch, true).description, /current working tree.*untracked/);

	await repo.git("update-ref", "refs/remotes/origin/main", feature);
	const remote = await prepareBranchDiff(repo.cwd);
	assert.equal(remote.base.label, "origin/main", "existing origin/main must win over local main");
	assert.equal(remote.mergeBase, feature);
	assert.equal((await prepareBranchDiff(repo.cwd, "main")).mergeBase, root, "explicit base must override the default");

	const from = await resolveDiffRevision(repo.cwd, "main");
	const to = await resolveDiffRevision(repo.cwd, "feature");
	const compare = compareDiffTarget(from, to);
	assert.deepEqual(compare.revisions, [mainTip, feature], "compare must use two endpoints, not their merge base");
	assert.equal(compare.includeUntracked, false);
	assert.match(compare.description, /committed endpoints; no working tree/);
	await repo.commit("Later HEAD", "later.txt");
	assert.deepEqual(compare.revisions, [mainTip, feature], "resolved endpoints must not move with HEAD");
	assert.deepEqual(branchDiffTarget(branch, false).revisions, [root, feature], "branch HEAD must also stay fixed after selection");
	assert.equal((await resolveDiffRevision(repo.cwd, "v1")).sha, root, "annotated tags must peel to commits");
	assert.equal((await resolveDiffRevision(repo.cwd, "HEAD~1")).sha, feature);
	assert.equal((await resolveDiffRevision(repo.cwd, root)).sha, root);
	for (const ref of ["missing-ref", "--help", "--output=owned", ";touch-owned", "HEAD:tracked.txt", "HEAD main", ""]) {
		await assert.rejects(resolveDiffRevision(repo.cwd, ref), /Not a commit|without whitespace/, `invalid ref ${ref} must not become a Git option`);
	}

	const candidates = await listDiffRevisions(repo.cwd);
	assert.ok(candidates.some((candidate) => candidate.kind === "branch" && candidate.name === "feature"));
	assert.ok(candidates.some((candidate) => candidate.kind === "remote" && candidate.name === "origin/main"));
	assert.ok(candidates.some((candidate) => candidate.kind === "tag" && candidate.name === "v1"));
	assert.ok(candidates.some((candidate) => candidate.kind === "commit" && candidate.sha === feature && candidate.subject === "Searchable feature topic"));
	assert.ok(candidates.filter((candidate) => candidate.kind === "commit").length <= 50);
	await assert.rejects(listDiffRevisions(outside), /Could not load Git revisions/);
	const worktree = await workingTreeDiffTarget(repo.cwd);
	assert.deepEqual(worktree.revisions, []);
	assert.equal(worktree.includeUntracked, true);

	await repo.git("switch", "--orphan", "unrelated");
	await assert.rejects(prepareBranchDiff(repo.cwd, "main"), /HEAD has no valid commit/);
	await repo.commit("Unrelated history");
	await assert.rejects(prepareBranchDiff(repo.cwd, "main"), /No common ancestor/);
	await repo.git("update-ref", "-d", "refs/remotes/origin/main");
	await repo.git("branch", "-D", "main");
	await assert.rejects(prepareBranchDiff(repo.cwd), /No origin\/main or local main/);
} finally {
	await repo.cleanup();
	await rm(outside, { recursive: true, force: true });
}
console.log("✓ diff command/completion contracts and real-Git target integration checks passed");
