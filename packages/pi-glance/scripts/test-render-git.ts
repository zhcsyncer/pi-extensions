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
assert.equal(gitLine({ status: "dirty", dirty: true, unstaged: 1 }), "git main *", "dirty marker defaults on");
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
assert.equal(gitLine({ status: "conflict", dirty: true, conflicts: 1 }, undefined), "git main !", "conflict marker defaults on");
assert.equal(gitLine({ ahead: 2, behind: 1 }), "git main ↑2 ↓1", "ahead/behind defaults on");
assert.equal(gitLine({ status: "dirty", dirty: true, unstaged: 1, ahead: 2, behind: 1 }, undefined, 48), "git main *", "minimal git keeps status over upstream counts");
assert.equal(
	gitLine({ ahead: 2, behind: 1 }, (config) => {
		config.git.showAheadBehind = false;
	}),
	"git main",
	"ahead/behind can be hidden",
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
