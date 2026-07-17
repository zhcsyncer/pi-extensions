import { readFile, writeFile } from "node:fs/promises";

const packageFiles = [
	new URL("../package.json", import.meta.url),
	new URL("../packages/pi-recap/package.json", import.meta.url),
	new URL("../packages/pi-tool-display-intent/package.json", import.meta.url),
];
const packages = await Promise.all(
	packageFiles.map(async (packageFile) => JSON.parse(await readFile(packageFile, "utf8"))),
);
const [rootPackage, ...workspacePackages] = packages;

for (const workspacePackage of workspacePackages) {
	if (rootPackage.version !== workspacePackage.version) {
		throw new Error(
			`Fixed package versions diverged: ${rootPackage.name}@${rootPackage.version} and ${workspacePackage.name}@${workspacePackage.version}`,
		);
	}
}

const version = rootPackage.version;
const readmes = [
	new URL("../README.md", import.meta.url),
	new URL("../packages/pi-recap/README.md", import.meta.url),
	new URL("../packages/pi-recap/README.zh-CN.md", import.meta.url),
	new URL("../packages/pi-tool-display-intent/README.md", import.meta.url),
	new URL("../packages/pi-tool-display-intent/README.zh-CN.md", import.meta.url),
];
const gitInstallPattern = /(git:github\.com\/zhcsyncer\/pi-extensions)@v\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?/g;

for (const readme of readmes) {
	const current = await readFile(readme, "utf8");
	const next = current.replace(gitInstallPattern, `$1@v${version}`);
	if (next === current && !current.includes(`git:github.com/zhcsyncer/pi-extensions@v${version}`)) {
		throw new Error(`No versioned Git install command found in ${readme.pathname}`);
	}
	await writeFile(readme, next);
}

console.log(`Synchronized Git install examples to v${version}`);
