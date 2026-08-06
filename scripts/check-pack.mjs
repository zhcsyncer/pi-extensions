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
	"./packages/pi-plan-mode",
	"./packages/pi-search-hub",
	"./packages/pi-context7",
	"./packages/pi-ask-user-question",
	"./providers/pi-provider-volcengine-agent-plan",
];

const requiredPackFiles = new Map([
	[".", [
		"README.md",
		"README.zh-CN.md",
		"packages/pi-recap/extensions/multiplexer.ts",
		"packages/pi-glance/index.ts",
		"packages/pi-glance/footer.ts",
		"packages/pi-glance/README.md",
		"packages/pi-glance/README.zh-CN.md",
		"packages/pi-plan-mode/package.json",
		"packages/pi-plan-mode/extensions/plan-mode.ts",
		"packages/pi-plan-mode/src/config.ts",
		"packages/pi-plan-mode/src/storage.ts",
		"packages/pi-plan-mode/src/widgets.ts",
		"packages/pi-plan-mode/README.md",
		"packages/pi-plan-mode/README.zh-CN.md",
		"packages/pi-search-hub/README.md",
		"packages/pi-search-hub/README.zh-CN.md",
		"packages/pi-context7/extensions/context7.ts",
		"packages/pi-context7/lib/api.ts",
		"packages/pi-context7/config.json.example",
		"packages/pi-context7/skills/context7-docs/SKILL.md",
		"packages/pi-context7/README.md",
		"packages/pi-context7/README.zh-CN.md",
		"packages/pi-context7/UPSTREAM_SOURCE.md",
		"packages/pi-ask-user-question/index.ts",
		"packages/pi-ask-user-question/view/tool-renderer.ts",
		"packages/pi-ask-user-question/locales/zh.json",
		"packages/pi-ask-user-question/README.md",
		"packages/pi-ask-user-question/UPSTREAM_SOURCE.md",
	]],
	["./packages/pi-recap", [
		"extensions/recap.ts",
		"extensions/multiplexer.ts",
		"examples/recap.json",
		"README.md",
		"README.zh-CN.md",
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
	["./packages/pi-plan-mode", [
		"extensions/plan-mode.ts",
		"src/config.ts",
		"src/storage.ts",
		"src/widgets.ts",
		"README.md",
		"README.zh-CN.md",
		"CHANGELOG.md",
		"LICENSE",
	]],
	["./packages/pi-search-hub", ["README.md", "README.zh-CN.md"]],
	["./packages/pi-context7", [
		"extensions/context7.ts",
		"lib/api.ts",
		"lib/config.ts",
		"lib/render.ts",
		"config.json.example",
		"skills/context7-docs/SKILL.md",
		"README.md",
		"README.zh-CN.md",
		"CHANGELOG.md",
		"LICENSE",
		"UPSTREAM_LICENSE",
		"UPSTREAM_SOURCE.md",
	]],
	["./packages/pi-ask-user-question", [
		"index.ts",
		"ask-user-question.ts",
		"state/key-router.ts",
		"view/tool-renderer.ts",
		"locales/en.json",
		"locales/zh.json",
		"README.md",
		"CHANGELOG.md",
		"LICENSE",
		"UPSTREAM_LICENSE",
		"UPSTREAM_SOURCE.md",
	]],
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
	"packages/pi-plan-mode/README.md",
	"packages/pi-plan-mode/README.zh-CN.md",
	"packages/pi-search-hub/README.md",
	"packages/pi-search-hub/README.zh-CN.md",
	"packages/pi-context7/README.md",
	"packages/pi-context7/README.zh-CN.md",
	"packages/pi-ask-user-question/README.md",
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
	"packages/pi-plan-mode/README.md",
	"packages/pi-plan-mode/README.zh-CN.md",
);
await assertBilingualPair(
	"packages/pi-search-hub/README.md",
	"packages/pi-search-hub/README.zh-CN.md",
);
await assertBilingualPair(
	"packages/pi-context7/README.md",
	"packages/pi-context7/README.zh-CN.md",
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
