import { strict as assert } from "node:assert";
import { defaultConfig } from "../config.js";
import { stripControls } from "../format.js";
import { renderGlanceLine } from "../status-line.js";
import { testState } from "./helpers.js";
import type { GitSnapshot } from "../types.js";

function stateWithGit(git: Partial<GitSnapshot>) {
	return testState({
		git: {
			repo: true,
			branch: "main",
			detached: false,
			sha: "a1b2c3d",
			upstream: "origin/main",
			ahead: 0,
			behind: 0,
			baseBehind: 0,
			staged: 0,
			unstaged: 0,
			untracked: 0,
			conflicts: 0,
			dirty: false,
			status: "clean",
			updatedAt: 0,
			...git,
		},
		context: { tokens: 10_000, window: 100_000, percent: 10 },
		usage: { input: 100, output: 50, cacheRead: 0, cacheWrite: 0, cost: 0.01 },
	});
}

function gitLine(git: Partial<GitSnapshot>, mutateConfig?: (config: ReturnType<typeof defaultConfig>) => void, width = 120): string {
	const config = defaultConfig();
	config.segments = config.segments.map((segment) => ({ ...segment, enabled: segment.id === "git" }));
	mutateConfig?.(config);
	return stripControls(renderGlanceLine(stateWithGit(git), config, width));
}

assert.equal(gitLine({ status: "clean" }), "git main", "clean branch stays quiet");
assert.equal(gitLine({ status: "dirty", dirty: true, unstaged: 1 }), "git main *", "dirty marker defaults on without worktree counts when files are unknown");
assert.equal(
	gitLine({
		status: "dirty",
		dirty: true,
		unstaged: 1,
		worktree: {
			staged: [],
			unstaged: ["changed.ts"],
			untracked: [],
			conflicts: [],
			files: 6,
			additions: 123,
			deletions: 99,
		},
	}),
	"git main Δ6 +123 −99",
	"status mode should replace the dirty lamp with unique file and tracked +/− counts",
);
assert.equal(
	gitLine(
		{
			status: "dirty",
			dirty: true,
			unstaged: 1,
			worktree: {
				staged: [],
				unstaged: ["changed.ts"],
				untracked: [],
				conflicts: [],
				files: 6,
				additions: 123,
				deletions: 99,
			},
		},
		(config) => {
			config.git.worktreeSummary = "border-right";
		},
	),
	"git main",
	"border-right should keep worktree counts and the dirty lamp out of the Git status line",
);
assert.equal(
	gitLine({ status: "dirty", dirty: true, unstaged: 1 }, (config) => {
		config.git.showDirty = false;
	}),
	"git main",
	"dirty marker can be hidden",
);
assert.equal(
	gitLine(
		{ status: "conflict", dirty: true, conflicts: 1 },
		(config) => {
			config.git.showDirty = false;
		},
	),
	"git main !",
	"conflict marker remains visible when dirty marker is disabled",
);
assert.equal(
	gitLine({
		status: "conflict",
		dirty: true,
		conflicts: 1,
		worktree: {
			staged: [],
			unstaged: [],
			untracked: [],
			conflicts: ["conflict.ts"],
			files: 1,
			additions: 2,
			deletions: 1,
		},
	}),
	"git main ! Δ1 +2 −1",
	"conflict marker stays next to worktree counts",
);
assert.equal(
	gitLine(
		{
			status: "conflict",
			dirty: true,
			conflicts: 1,
			worktree: {
				staged: [],
				unstaged: [],
				untracked: [],
				conflicts: ["conflict.ts"],
				files: 1,
				additions: 2,
				deletions: 1,
			},
		},
		(config) => {
			config.git.worktreeSummary = "border-right";
		},
	),
	"git main !",
	"conflict marker remains when worktree counts move to the border",
);
assert.equal(gitLine({ status: "conflict", dirty: true, conflicts: 1 }, undefined), "git main !", "conflict marker defaults on");
assert.equal(gitLine({ ahead: 2, behind: 1 }), "git main ↑2 ↓1", "ahead/behind defaults on");
assert.equal(
	gitLine({ ahead: 0, behind: 2, baseBehind: 2 }),
	"git main ↓2",
	"upstream behind origin/main should not repeat as main↓N",
);
assert.equal(
	gitLine({ ahead: 0, behind: 2, baseBehind: 2 }, (config) => {
		config.git.showAheadBehind = false;
	}),
	"git main main↓2",
	"hidden upstream behind should still allow main↓N",
);
assert.equal(
	gitLine({ branch: "feat/glance-main-behind", upstream: null, ahead: 0, behind: 0, baseBehind: 8 }),
	"git feat/glance-main-behind main↓8",
	"base behind shows without an upstream",
);
assert.equal(gitLine({ baseBehind: 0 }), "git main", "aligned base stays quiet");
assert.equal(gitLine({ ahead: 1, behind: 0, baseBehind: 8 }), "git main ↑1 main↓8", "upstream ahead and base behind can coexist");
assert.equal(
	gitLine({ status: "dirty", dirty: true, unstaged: 1, ahead: 2, behind: 0, baseBehind: 8 }, undefined, 48),
	"git main *",
	"minimal git keeps the dirty lamp when worktree counts are unknown",
);
assert.equal(
	gitLine(
		{
			status: "dirty",
			dirty: true,
			unstaged: 1,
			ahead: 2,
			behind: 0,
			baseBehind: 8,
			worktree: {
				staged: [],
				unstaged: ["changed.ts"],
				untracked: [],
				conflicts: [],
				files: 6,
				additions: 123,
				deletions: 99,
			},
		},
		undefined,
		48,
	),
	"git main main↓8",
	"minimal git keeps base behind after the dirty lamp yields to worktree counts",
);
assert.equal(
	gitLine({ ahead: 2, behind: 0, baseBehind: 8 }, undefined, 80),
	"git main ↑2 main↓8",
	"compact git keeps upstream ahead and base behind together",
);
assert.equal(
	gitLine({ ahead: 2, behind: 0, baseBehind: 8 }, undefined, 48),
	"git main main↓8",
	"minimal git keeps base behind when there is no dirty or conflict mark",
);
assert.equal(
	gitLine({ ahead: 0, behind: 2, baseBehind: 2 }, undefined, 48),
	"git main",
	"minimal git keeps quiet when the only remaining count would duplicate upstream behind",
);
assert.equal(
	gitLine({ ahead: 2, behind: 1 }, (config) => {
		config.git.showAheadBehind = false;
	}),
	"git main",
	"ahead/behind can be hidden",
);
assert.equal(
	gitLine({ baseBehind: 8 }, (config) => {
		config.git.showBaseBehind = false;
	}),
	"git main",
	"base behind can be hidden",
);
assert.equal(gitLine({}, (config) => (config.git.shaMode = "always")), "git main a1b2c3d", "sha always shows branch sha");
assert.equal(
	gitLine({ branch: null, detached: true }, (config) => (config.git.shaMode = "off")),
	"git HEAD",
	"sha off keeps detached head quiet",
);
assert.equal(
	gitLine({ branch: null, detached: true }, (config) => (config.git.shaMode = "detached")),
	"git a1b2c3d",
	"sha detached shows sha on detached head",
);

console.log("✓ git render settings checks passed");
