import { strict as assert } from "node:assert";
import { homedir } from "node:os";
import { visibleWidth } from "@earendil-works/pi-tui";
import { defaultConfig } from "../config.js";
import { formatWorkspaceLabel, stripControls } from "../format.js";
import { renderInputSurface } from "../renderer.js";
import { testState } from "./helpers.js";

function findTopBorder(lines: readonly string[]): string {
	return lines.map(stripControls).find((line) => line.startsWith("╭")) ?? "";
}

function topLine(path: string, mode: "name" | "smart" | "path", width = 160): string {
	const config = defaultConfig();
	config.display.workspaceLabel = mode;
	return findTopBorder(renderInputSurface(testState({ workspace: { name: "07_pi-glance", path } }), config, width));
}

function previewState() {
	return testState({
		git: {
			repo: true,
			branch: "main",
			detached: false,
			sha: "a1b2c3d",
			upstream: "origin/main",
			ahead: 1,
			behind: 0,
			staged: 0,
			unstaged: 1,
			untracked: 0,
			conflicts: 0,
			dirty: true,
			status: "dirty",
			updatedAt: 0,
		},
		providers: { availableCount: 2 },
		model: { id: "claude-sonnet-4-20250514", provider: "anthropic", displayName: "Sonnet 4", thinking: "high" },
		usage: { input: 12_400, output: 3_100, cacheRead: 800, cacheWrite: 0, cost: 0.042 },
	});
}

function renderedTop(width: number, mutateConfig?: (config: ReturnType<typeof defaultConfig>) => void, showTitle = true): string {
	const config = defaultConfig();
	mutateConfig?.(config);
	return findTopBorder(renderInputSurface(previewState(), config, width, { showTitle }));
}

const homePath = `${homedir()}/winnie/00_project/07_pi-glance`;

assert.equal(defaultConfig().display.workspaceLabel, "name", "workspace label defaults to name");
assert.equal(formatWorkspaceLabel(homePath, "07_pi-glance", "name", 80), "07_pi-glance", "name mode renders basename");
assert.equal(formatWorkspaceLabel(homePath, "07_pi-glance", "name", 8), "07_pi-g…", "name mode fits title budget");
assert.equal(formatWorkspaceLabel(homePath, "07_pi-glance", "smart", 20, 72), "07_pi-glance", "smart narrow renders basename");
assert.equal(
	formatWorkspaceLabel(homePath, "07_pi-glance", "smart", 80, 100),
	"…/00_project/07_pi-glance",
	"smart half-width renders parent path",
);
assert.equal(
	formatWorkspaceLabel(homePath, "07_pi-glance", "smart", 80, 160),
	"~/winnie/00_project/07_pi-glance",
	"smart wide renders home-shortened path",
);
assert.equal(
	formatWorkspaceLabel(homePath, "07_pi-glance", "path", 80),
	"~/winnie/00_project/07_pi-glance",
	"path mode renders home-shortened path",
);
assert.equal(
	formatWorkspaceLabel(homePath, "07_pi-glance", "path", 22),
	"…/07_pi-glance",
	"narrow path keeps project name",
);
assert.equal(
	formatWorkspaceLabel(homePath, "07_pi-glance", "path", 28),
	"~/winnie/…/07_pi-glance",
	"medium path keeps home prefix and project name",
);
assert.ok(
	!formatWorkspaceLabel(homePath, "07_pi-glance", "path", 80).startsWith(homedir()),
	"path mode never renders full home path",
);

const nonHome = "/mnt/data/work/07_pi-glance";
assert.equal(formatWorkspaceLabel(nonHome, "07_pi-glance", "path", 80), "…/data/work/07_pi-glance", "non-home paths keep only a safe tail");
assert.ok(!formatWorkspaceLabel(nonHome, "07_pi-glance", "path", 80).startsWith("/"), "non-home paths are not absolute");
assert.ok(formatWorkspaceLabel(nonHome, "07_pi-glance", "path", 80).includes("07_pi-glance"), "non-home path keeps project name");

assert.ok(topLine(homePath, "name").includes(" 07_pi-glance "), "surface name mode uses basename title");
assert.ok(topLine(homePath, "smart", 100).includes(" …/00_project/07_pi-glance "), "surface smart half-width uses parent path title");
assert.ok(topLine(homePath, "path").includes(" ~/winnie/00_project/07_pi-glance "), "surface path mode uses safe path title");
assert.ok(!topLine(homePath, "path").includes(homedir()), "surface never renders full home path");

for (const width of [56, 64, 72, 96, 120, 160]) {
	const top = renderedTop(width);
	assert.ok(visibleWidth(top) <= width, `preview top frame fits width ${width}`);
}
assert.ok(stripControls(renderedTop(56)).includes("$ $0.042"), "preview top status preserves cost at width 56");
assert.ok(!stripControls(renderedTop(56)).includes("Sonnet 4"), "preview top status drops trailing segment when seam budget is tight at width 56");
assert.ok(stripControls(renderedTop(72)).includes("Sonnet 4"), "preview top status keeps model once width allows it");
assert.ok(stripControls(renderedTop(18)).includes(" repo "), "preview title starts at the seam's innerWidth 16 threshold");
assert.ok(!stripControls(renderedTop(16)).includes(" repo "), "preview title falls back below the seam's innerWidth 16 threshold");
assert.ok(!stripControls(renderedTop(64, undefined, false)).includes(" repo "), "showTitle false keeps workspace title hidden in preview top frame");

const quietGitTop = stripControls(
	renderedTop(64, (config) => {
		config.segments = config.segments.map((segment) => ({ ...segment, enabled: segment.id === "git" }));
	}),
);
assert.ok(quietGitTop.includes("git main"), "preview top preserves quiet git segment rendering");
assert.ok(!quietGitTop.includes("ctx"), "preview top respects enabled segment list");

console.log("✓ workspace label checks passed");
