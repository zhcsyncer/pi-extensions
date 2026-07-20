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
	"./packages/pi-search-hub",
];

const requiredPackFiles = new Map([
	[".", [
		"README.md",
		"README.zh-CN.md",
		"packages/pi-search-hub/README.md",
		"packages/pi-search-hub/README.zh-CN.md",
	]],
	["./packages/pi-search-hub", ["README.md", "README.zh-CN.md"]],
]);

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
	"packages/pi-search-hub/README.md",
	"packages/pi-search-hub/README.zh-CN.md",
);

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
