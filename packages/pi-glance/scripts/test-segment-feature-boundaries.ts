import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = process.cwd();
const FEATURE_FILE_PATTERN = /-segment-feature\.ts$/;
const IO_NETWORK_PROCESS_IMPORTS = new Set([
	"fs",
	"fs/promises",
	"node:fs",
	"node:fs/promises",
	"child_process",
	"node:child_process",
	"process",
	"node:process",
	"http",
	"node:http",
	"https",
	"node:https",
	"net",
	"node:net",
	"tls",
	"node:tls",
	"dgram",
	"node:dgram",
	"dns",
	"node:dns",
	"undici",
	"ws",
]);
const FORBIDDEN_LOCAL_MODULES = new Set([
	"./segment-registry.js",
	"./runtime.js",
	"./renderer.js",
	"./status-line.js",
	"./pane.js",
	"./editor.js",
	"./settings-catalog.js",
	"./config.js",
	"./state.js",
	"./themes.js",
	"./palette.js",
	"./footer.js",
	"./runtime-snapshot.js",
	"./git.js",
]);
const TYPE_ONLY_LOCAL_MODULES = new Set(["./segment-feature.js", "./types.js"]);
const EXPECTED_FEATURE_FILES = [
	"context-segment-feature.ts",
	"cost-segment-feature.ts",
	"git-segment-feature.ts",
	"model-segment-feature.ts",
	"throughput-segment-feature.ts",
	"tokens-segment-feature.ts",
] as const;
const VALUE_LOCAL_IMPORT_POLICY = {
	"context-segment-feature.ts": new Set(["./config-options.js", "./segment-display-primitives.js"]),
	"cost-segment-feature.ts": new Set(["./segment-display-primitives.js"]),
	"git-segment-feature.ts": new Set(["./config-options.js"]),
	"model-segment-feature.ts": new Set(["./config-options.js"]),
	"throughput-segment-feature.ts": new Set(["./config-schema.js"]),
	"tokens-segment-feature.ts": new Set(["./config-options.js", "./segment-display-primitives.js"]),
} satisfies Record<(typeof EXPECTED_FEATURE_FILES)[number], ReadonlySet<string>>;

interface SourceFile {
	path: string;
	text: string;
}

async function readRootFeatureFiles(): Promise<SourceFile[]> {
	const rootEntries = await readdir(ROOT, { withFileTypes: true });
	const featureNames = rootEntries
		.filter((entry) => entry.isFile() && FEATURE_FILE_PATTERN.test(entry.name))
		.map((entry) => entry.name)
		.sort();
	return Promise.all(featureNames.map(async (path) => ({ path, text: await readFile(join(ROOT, path), "utf8") })));
}

function fail(message: string): never {
	assert.fail(message);
}

function allowedValueLocalModules(file: SourceFile): ReadonlySet<string> {
	return VALUE_LOCAL_IMPORT_POLICY[file.path as (typeof EXPECTED_FEATURE_FILES)[number]] ?? new Set<string>();
}

function assertAllowedImport(file: SourceFile, specifier: string, isTypeOnly: boolean): void {
	if (specifier.startsWith("@earendil-works/pi-")) fail(`${file.path}: segment feature must not import pi package ${specifier}`);
	if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${file.path}: segment feature must not import IO/network/process module ${specifier}`);
	if (FORBIDDEN_LOCAL_MODULES.has(specifier)) fail(`${file.path}: segment feature must not import runtime/UI/config/theme/state module ${specifier}`);
	if (TYPE_ONLY_LOCAL_MODULES.has(specifier) && !isTypeOnly) fail(`${file.path}: segment feature may only type-import from ${specifier}`);
	if (specifier.startsWith("./") && !TYPE_ONLY_LOCAL_MODULES.has(specifier) && !allowedValueLocalModules(file).has(specifier)) {
		fail(`${file.path}: segment feature local deps should match its per-feature value import policy; unexpected import ${specifier}`);
	}
}

function assertNoForbiddenRuntimeUse(file: SourceFile): void {
	if (/\b(?:setInterval|setTimeout|setImmediate|requestAnimationFrame)\s*\(/.test(file.text)) {
		fail(`${file.path}: segment feature must not use timers/tickers`);
	}
	if (/\.notify\s*\(/.test(file.text)) fail(`${file.path}: segment feature must not call notify`);
}

const featureFiles = await readRootFeatureFiles();
assert.ok(featureFiles.length > 0, "at least one root *-segment-feature.ts boundary should exist");
assert.deepEqual(
	featureFiles.map((file) => file.path),
	EXPECTED_FEATURE_FILES,
	"segment feature boundary should cover exactly the six extracted root feature modules",
);
assert.deepEqual(
	Object.keys(VALUE_LOCAL_IMPORT_POLICY).sort(),
	[...EXPECTED_FEATURE_FILES].sort(),
	"segment feature value import policy should explicitly cover every extracted feature module",
);

const importPattern = /(?:import|export)\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
for (const file of featureFiles) {
	for (const match of file.text.matchAll(importPattern)) {
		assertAllowedImport(file, match[2]!, match[1] === "type ");
	}
	assertNoForbiddenRuntimeUse(file);
}

console.log(`✓ segment feature boundary checks passed (${featureFiles.map((file) => file.path).join(", ")})`);
