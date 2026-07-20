import { readFile, writeFile } from "node:fs/promises";

const rootPackage = JSON.parse(
	await readFile(new URL("../package.json", import.meta.url), "utf8"),
);
const version = rootPackage.version;
const readmes = [
	new URL("../README.md", import.meta.url),
	new URL("../README.zh-CN.md", import.meta.url),
	new URL("../packages/pi-recap/README.md", import.meta.url),
	new URL("../packages/pi-recap/README.zh-CN.md", import.meta.url),
	new URL("../packages/pi-tool-display-intent/README.md", import.meta.url),
	new URL("../packages/pi-tool-display-intent/README.zh-CN.md", import.meta.url),
	new URL("../packages/pi-todo/README.md", import.meta.url),
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
