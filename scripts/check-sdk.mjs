import assert from "node:assert/strict";
import { readFileSync, readdirSync, realpathSync } from "node:fs";
import { findPackageJSON } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const sdkNames = new Set(["pi-coding-agent", "pi-ai", "pi-agent-core", "pi-tui", "pi-codemode", "pi-mcp", "pi-telemetry", "chord"].map((name) => `@earendil-works/${name}`));
const visited = new Set();
const versions = new Map();
function inspect(name, from) {
	const entry = realpathSync(findPackageJSON(name, pathToFileURL(from)));
	const identity = `${name}:${entry}`;
	if (visited.has(identity)) return;
	visited.add(identity);
	const directory = dirname(entry);
	const manifest = JSON.parse(readFileSync(entry, "utf8"));
	assert.equal(manifest.name, name === "@sinclair/typebox" ? "typebox" : name);
	const expected = sdkNames.has(name) ? "1.1.0" : "1.3.27";
	assert.equal(manifest.version, expected, `${name}: wrong physical SDK resolved from ${from}`);
	versions.set(name, manifest.version);
	for (const dependency of Object.keys(manifest.dependencies ?? {})) {
		if (sdkNames.has(dependency) || dependency === "typebox") inspect(dependency, join(directory, "package.json"));
	}
}
for (const path of [".", ...["packages", "providers"].flatMap((group) => readdirSync(join(root, group)).map((name) => `${group}/${name}`))]) {
	const file = resolve(root, path, "package.json");
	const manifest = JSON.parse(readFileSync(file, "utf8"));
	for (const dependency of Object.keys(manifest.devDependencies ?? {})) {
		if (sdkNames.has(dependency) || dependency === "typebox" || dependency === "@sinclair/typebox") inspect(dependency, file);
	}
}
assert.ok([...sdkNames].every((name) => versions.has(name)), "All eight target SDK packages must be reached through the installed graph");
console.log(JSON.stringify(Object.fromEntries(versions), null, 2));
