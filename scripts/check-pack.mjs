import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packagePaths = [
	".",
	"./packages/pi-recap",
	"./packages/pi-tool-display-intent",
	"./packages/pi-todo",
	"./packages/pi-glance",
	"./packages/pi-search-hub",
	"./providers/pi-provider-volcengine-agent-plan",
];

const requiredPackFiles = new Map([
	[".", [
		"README.md",
		"README.zh-CN.md",
		"packages/pi-glance/index.ts",
		"packages/pi-glance/footer.ts",
		"packages/pi-glance/README.md",
		"packages/pi-glance/README.zh-CN.md",
		"packages/pi-search-hub/README.md",
		"packages/pi-search-hub/README.zh-CN.md",
	]],
	["./packages/pi-glance", [
		"index.ts",
		"bottom-details.ts",
		"footer.ts",
		"README.md",
		"README.zh-CN.md",
		"LICENSE",
		"UPSTREAM_LICENSE",
		"UPSTREAM_SOURCE.md",
	]],
	["./packages/pi-search-hub", ["README.md", "README.zh-CN.md"]],
	["./providers/pi-provider-volcengine-agent-plan", [
		"index.ts",
		"README.md",
		"README.zh-CN.md",
		"LICENSE",
	]],
]);
const maintainedReadmes = [
	".changeset/README.md",
	"README.md",
	"README.zh-CN.md",
	"packages/pi-recap/README.md",
	"packages/pi-recap/README.zh-CN.md",
	"packages/pi-glance/README.md",
	"packages/pi-glance/README.zh-CN.md",
	"packages/pi-search-hub/README.md",
	"packages/pi-search-hub/README.zh-CN.md",
	"providers/pi-provider-volcengine-agent-plan/README.md",
	"providers/pi-provider-volcengine-agent-plan/README.zh-CN.md",
	"packages/pi-todo/README.md",
	"packages/pi-tool-display-intent/README.md",
	"packages/pi-tool-display-intent/README.zh-CN.md",
];
const pinnedInstallPattern = /(?:pi\s+(?:install|-e)|npm\s+(?:install|i)|pnpm\s+add|yarn\s+add)[^\n]*@v?\d+\.\d+\.\d+/;

async function assertBilingualPair(englishPath, chinesePath) {
	const [english, chinese] = await Promise.all([
		readFile(resolve(repositoryRoot, englishPath), "utf8"),
		readFile(resolve(repositoryRoot, chinesePath), "utf8"),
	]);
	const headingLevels = (markdown) => Array.from(
		markdown.matchAll(/^(#{1,6})\s+.+$/gm),
		(match) => match[1].length,
	);
	assert.deepEqual(
		headingLevels(chinese),
		headingLevels(english),
		`${chinesePath} must keep the same heading structure as ${englishPath}`,
	);
	assert.match(english, new RegExp(`\\[简体中文\\]\\(\\./${chinesePath.split("/").pop().replaceAll(".", "\\.")}\\)`));
	assert.match(chinese, /\[English\]\(\.\/README\.md\)/);
}

await assertBilingualPair("README.md", "README.zh-CN.md");
await assertBilingualPair(
	"packages/pi-glance/README.md",
	"packages/pi-glance/README.zh-CN.md",
);
await assertBilingualPair(
	"packages/pi-search-hub/README.md",
	"packages/pi-search-hub/README.zh-CN.md",
);
await assertBilingualPair(
	"providers/pi-provider-volcengine-agent-plan/README.md",
	"providers/pi-provider-volcengine-agent-plan/README.zh-CN.md",
);
for (const readmePath of maintainedReadmes) {
	const readme = await readFile(resolve(repositoryRoot, readmePath), "utf8");
	assert.doesNotMatch(
		readme,
		pinnedInstallPattern,
		`${readmePath} installation commands must not pin a release version`,
	);
}

for (const packagePath of packagePaths) {
	const result = spawnSync(
		"npm",
		["pack", "--dry-run", "--json", packagePath],
		{
			cwd: repositoryRoot,
			encoding: "utf8",
		},
	);
	if (result.error) throw result.error;
	if (result.status !== 0) {
		process.stderr.write(result.stderr);
		process.stderr.write(result.stdout);
		process.exit(result.status ?? 1);
	}

	const packResult = JSON.parse(result.stdout);
	const files = new Set((packResult[0]?.files ?? []).map((file) => file.path));
	for (const requiredFile of requiredPackFiles.get(packagePath) ?? []) {
		assert.ok(files.has(requiredFile), `${packagePath} npm pack is missing ${requiredFile}`);
	}
	console.log(`${packagePath}: npm pack dry-run passed (${files.size} files)`);
}
