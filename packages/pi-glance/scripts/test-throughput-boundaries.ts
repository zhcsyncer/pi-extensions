import { strict as assert } from "node:assert";
import { readFile, readdir } from "node:fs/promises";
import { basename, join } from "node:path";

const ROOT = process.cwd();
const THROUGHPUT_MODULE = "throughput.ts";
const THROUGHPUT_RUN_TRACKER_MODULE = "throughput-run-tracker.ts";
const THROUGHPUT_SEGMENT_FEATURE_MODULE = "throughput-segment-feature.ts";
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

interface SourceFile {
	path: string;
	text: string;
}

async function readRootTsFiles(): Promise<SourceFile[]> {
	const rootEntries = await readdir(ROOT, { withFileTypes: true });
	return Promise.all(
		rootEntries
			.filter((entry) => entry.isFile() && entry.name.endsWith(".ts"))
			.map(async (entry) => ({ path: entry.name, text: await readFile(join(ROOT, entry.name), "utf8") })),
	);
}

function fail(message: string): never {
	assert.fail(message);
}

const files = await readRootTsFiles();
const byPath = new Map(files.map((file) => [file.path, file]));
const throughput = files.find((file) => basename(file.path) === THROUGHPUT_MODULE);
assert.ok(throughput, "throughput.ts pure calculation boundary should exist");
const throughputRunTracker = files.find((file) => basename(file.path) === THROUGHPUT_RUN_TRACKER_MODULE);
assert.ok(throughputRunTracker, "throughput-run-tracker.ts pure lifecycle boundary should exist");
const throughputSegmentFeature = files.find((file) => basename(file.path) === THROUGHPUT_SEGMENT_FEATURE_MODULE);
assert.ok(throughputSegmentFeature, "throughput-segment-feature.ts SegmentFeature boundary should exist");

const importPattern = /(?:import|export)\s+(type\s+)?(?:[^"'`]*?\s+from\s+)?["']([^"']+)["']/g;
const forbiddenThroughputLocalModules = new Set(["./runtime.js", "./renderer.js", "./status-line.js", "./pane.js", "./editor.js", "./config.js", "./settings-catalog.js", "./state.js"]);
const forbiddenThroughputFeatureLocalModules = new Set([
	"./segment-registry.js",
	"./runtime.js",
	"./renderer.js",
	"./status-line.js",
	"./pane.js",
	"./editor.js",
	"./config.js",
	"./settings-catalog.js",
	"./state.js",
	"./themes.js",
	"./palette.js",
]);
const throughputFeatureAllowedLocalModules = new Set(["./config-schema.js", "./segment-feature.js", "./types.js"]);

function assertPureThroughputImport(file: SourceFile, specifier: string): void {
	if (specifier.startsWith("@earendil-works/pi-")) fail(`${file.path}: throughput pure module must not import pi package ${specifier}`);
	if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${file.path}: throughput pure module must not import IO/network/process module ${specifier}`);
	if (forbiddenThroughputLocalModules.has(specifier)) fail(`${file.path}: throughput pure module must not import UI/runtime/config/state module ${specifier}`);
}

for (const match of throughput.text.matchAll(importPattern)) {
	const isTypeOnly = match[1] === "type ";
	const specifier = match[2]!;
	assertPureThroughputImport(throughput, specifier);
	if (specifier === "./types.js" && !isTypeOnly) fail(`${throughput.path}: throughput may only type-import from ./types.js`);
	if (specifier !== "./types.js") fail(`${throughput.path}: throughput pure module should stay dependency-light; unexpected import ${specifier}`);
}

for (const match of throughputRunTracker.text.matchAll(importPattern)) {
	const isTypeOnly = match[1] === "type ";
	const specifier = match[2]!;
	assertPureThroughputImport(throughputRunTracker, specifier);
	if (specifier === "./types.js" && !isTypeOnly) fail(`${throughputRunTracker.path}: throughput run tracker may only type-import from ./types.js`);
	if (!["./throughput.js", "./types.js"].includes(specifier)) fail(`${throughputRunTracker.path}: throughput run tracker may only import throughput calculation and types, not ${specifier}`);
}

const throughputFeatureImports = [...throughputSegmentFeature.text.matchAll(importPattern)].map((match) => ({
	isTypeOnly: match[1] === "type ",
	specifier: match[2]!,
}));

for (const { isTypeOnly, specifier } of throughputFeatureImports) {
	if (specifier.startsWith("@earendil-works/pi-")) fail(`${throughputSegmentFeature.path}: throughput feature must not import pi package ${specifier}`);
	if (IO_NETWORK_PROCESS_IMPORTS.has(specifier)) fail(`${throughputSegmentFeature.path}: throughput feature must not import IO/network/process module ${specifier}`);
	if (forbiddenThroughputFeatureLocalModules.has(specifier)) fail(`${throughputSegmentFeature.path}: throughput feature must not import runtime/UI/config/theme module ${specifier}`);
	if (specifier.startsWith("./") && !throughputFeatureAllowedLocalModules.has(specifier)) fail(`${throughputSegmentFeature.path}: throughput feature local deps should stay narrow; unexpected import ${specifier}`);
	if (["./segment-feature.js", "./types.js"].includes(specifier) && !isTypeOnly) fail(`${throughputSegmentFeature.path}: throughput feature may only type-import from ${specifier}`);
}

assert.equal(
	throughputFeatureImports.some((record) => record.specifier === "./config-schema.js" && !record.isTypeOnly),
	true,
	"throughput feature should value-import config-schema descriptor for precision settings",
);
assert.equal(
	throughputFeatureImports.some((record) => record.specifier === "./config-options.js"),
	false,
	"throughput feature should not import config-options precision values",
);

if (/function\s+throughputPrecisionLabel\b/.test(throughputSegmentFeature.text)) {
	fail(`${throughputSegmentFeature.path}: throughput precision settings label should come from config-schema descriptor`);
}
if (/THROUGHPUT_PRECISION_VALUES/.test(throughputSegmentFeature.text)) {
	fail(`${throughputSegmentFeature.path}: throughput precision settings cycle should use config-schema descriptor next()`);
}

for (const file of [throughput, throughputRunTracker, throughputSegmentFeature]) {
	if (/\bDate\.now\s*\(/.test(file.text)) fail(`${file.path}: throughput boundary must use injected timestamps/state, not Date.now()`);
	if (/\b(?:setInterval|setTimeout|setImmediate|requestAnimationFrame)\s*\(/.test(file.text)) fail(`${file.path}: Reply speed UX v2 must not use timers/tickers for provisional or unknown status`);
	if (/\.notify\s*\(/.test(file.text)) fail(`${file.path}: throughput boundary must never notify`);
	if (/(?:\.\s*(?:content|delta|text_delta|thinking_delta)\b|\[\s*["'](?:content|delta|text_delta|thinking_delta)["']\s*\])/.test(file.text)) {
		fail(`${file.path}: throughput boundary must not read message content/delta text as a token fallback`);
	}
	if (/\.\s*length\b/.test(file.text)) {
		fail(`${file.path}: throughput boundary must not use string/content length as a token fallback`);
	}
}

for (const file of files) {
	if (/\.notify\s*\([^;\n]*(?:throughput|reply speed|TPS|tok\/s|spd)/i.test(file.text)) {
		fail(`${file.path}: throughput/Reply speed copy should not be sent through ctx.ui.notify`);
	}
}

for (const fileName of ["throughput.ts", "throughput-run-tracker.ts", "throughput-segment-feature.ts", "runtime.ts", "segment-registry.ts", "renderer.ts", "status-line.ts"] as const) {
	const file = byPath.get(fileName);
	assert.ok(file, `${fileName} should exist for throughput boundary checks`);
	if (/\b(?:setInterval|setTimeout|setImmediate|requestAnimationFrame)\s*\(/.test(file.text)) {
		fail(`${file.path}: Reply speed UX v2 must not use timers/tickers for provisional or unknown status`);
	}
}

for (const fileName of ["throughput.ts", "throughput-run-tracker.ts", "throughput-segment-feature.ts", "runtime.ts", "segment-registry.ts"] as const) {
	const file = byPath.get(fileName);
	assert.ok(file, `${fileName} should exist for throughput estimation boundary checks`);
	if (/(?:\.\s*(?:content|delta|text_delta|thinking_delta)\b|\[\s*["'](?:content|delta|text_delta|thinking_delta)["']\s*\])/.test(file.text)) {
		fail(`${file.path}: Reply speed must not inspect content/delta text for token estimation`);
	}
}

console.log("✓ throughput boundary checks passed");
