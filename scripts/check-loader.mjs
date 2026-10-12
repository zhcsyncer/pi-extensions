import assert from "node:assert/strict";
import { existsSync, readFileSync, readdirSync, realpathSync } from "node:fs";
import { findPackageJSON, registerHooks } from "node:module";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { runIsolated } from "./run-isolated.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostNames = new Set(["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@sinclair/typebox", "typebox"]);

function observeNativeHostModules() {
	const sdkManifest = fileURLToPath(new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent")));
	const expected = new Map([...hostNames].filter((name) => name !== "@sinclair/typebox").map((name) =>
		[name, dirname(realpathSync(findPackageJSON(name, pathToFileURL(sdkManifest))))]));
	const observed = new Map();
	const directoryCache = new Map();
	function packageAt(directory) {
		if (directoryCache.has(directory)) return directoryCache.get(directory);
		const file = join(directory, "package.json");
		const manifest = existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) : undefined;
		const result = manifest?.name ? { name: manifest.name, version: manifest.version, root: realpathSync(directory) }
			: directory === dirname(directory) ? undefined : packageAt(dirname(directory));
		directoryCache.set(directory, result);
		return result;
	}
	const hooks = registerHooks({
		load(url, context, nextLoad) {
			const result = nextLoad(url, context);
			if (url.startsWith("file:")) {
				const source = packageAt(dirname(fileURLToPath(url)));
				if (source && hostNames.has(source.name)) {
					observed.set(source.root, { ...source, host: source.root === expected.get(source.name) });
				}
			}
			return result;
		},
	});
	return { observed, stop: () => hooks.deregister() };
}

// Registration smoke only. No session_start, fake model, MCP factory or tool
// execution: downstream tasks must supply their own active-path contracts.
export async function checkPackageLoad(packagePath) {
	process.env.PI_CURSOR_SYSTEM_CREDENTIALS = "0";
	// Only this explicit discovery smoke opts out of live provider catalog refreshes.
	process.env.PI_OFFLINE = "1";
	const provenance = observeNativeHostModules();
	const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const sdkManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8"));
	assert.equal(sdkManifest.version, "1.1.0", "Do not substitute the executing host or another target SDK");
	const manifest = JSON.parse(readFileSync(resolve(packagePath, "package.json"), "utf8"));
	const loader = new DefaultResourceLoader({
		cwd: process.env.HOME,
		agentDir: process.env.PI_CODING_AGENT_DIR,
		// Package settings retain packageRoot metadata used by host warning diagnostics.
		// cwd/agentDir are empty: no ambient extensions or built-in factories are supplied.
		settingsManager: SettingsManager.inMemory({ packages: [packagePath] }),
		noSkills: true, noThemes: true,
		noPromptTemplates: true, noContextFiles: true,
	});
	await loader.reload();
	const { extensions, errors, warnings = [] } = loader.getExtensions();
	provenance.stop();
	const directManifestViolations = ["dependencies", "optionalDependencies"].flatMap((field) =>
		Object.keys(manifest[field] ?? {}).filter((name) => hostNames.has(name)).map((name) => ({ field, name })));
	const hostWarnings = warnings.filter(({ warning }) => /host-provided extension packages/i.test(warning));
	const nativeHostModules = [...provenance.observed.values()];
	const privateNativeLoads = nativeHostModules.filter((module) => !module.host);
	console.log(JSON.stringify({ name: manifest.name, sdk: sdkManifest.version, scope: "registration-only", directManifestViolations, errors, warnings, hostWarnings, nativeHostModules, privateNativeLoads, entries: extensions.map((e) => ({ path: e.path, tools: [...e.tools.keys()], commands: [...e.commands.keys()] })) }));
	assert.deepEqual(errors, [], `${manifest.name}: real loader errors`);
	assert.deepEqual(hostWarnings, [], `${manifest.name}: target host dependency warnings`);
	assert.deepEqual(directManifestViolations, [], `${manifest.name}: direct host dependency declaration`);
	assert.deepEqual(privateNativeLoads, [], `${manifest.name}: native private host module bypass`);
	assert.equal(extensions.length, manifest.pi.extensions.length, `${manifest.name}: every declared entry must load`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	if (process.argv[2] === "--child") {
		await checkPackageLoad(resolve(process.argv[3]));
	} else {
		const paths = process.argv.slice(2);
		if (paths.length === 0) paths.push(root, ...["packages", "providers"].flatMap((group) => readdirSync(resolve(root, group)).map((name) => resolve(root, group, name))));
		let failed = false;
		for (const path of paths) {
			const result = runIsolated(process.execPath, [fileURLToPath(import.meta.url), "--child", resolve(path)], { stdio: "inherit" });
			if (result.error) console.error(result.error);
			if (result.status !== 0) failed = true;
		}
		process.exitCode = failed ? 1 : 0;
	}
}
