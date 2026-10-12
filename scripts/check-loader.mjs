import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolated } from "./run-isolated.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// Registration smoke only. No session_start, fake model, MCP factory or tool
// execution: downstream tasks must supply their own active-path contracts.
export async function checkPackageLoad(packagePath) {
	process.env.PI_CURSOR_SYSTEM_CREDENTIALS = "0";
	const { DefaultResourceLoader, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const sdkManifest = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8"));
	assert.equal(sdkManifest.version, "1.1.0", "Do not substitute the executing host or another target SDK");
	const manifest = JSON.parse(readFileSync(resolve(packagePath, "package.json"), "utf8"));
	const loader = new DefaultResourceLoader({
		cwd: process.env.HOME,
		agentDir: process.env.PI_CODING_AGENT_DIR,
		settingsManager: SettingsManager.inMemory(),
		additionalExtensionPaths: [packagePath],
		noExtensions: true, noSkills: true, noThemes: true,
		noPromptTemplates: true, noContextFiles: true,
	});
	await loader.reload();
	const { extensions, errors } = loader.getExtensions();
	assert.deepEqual(errors, [], `${manifest.name}: real loader diagnostics`);
	assert.equal(extensions.length, manifest.pi.extensions.length, `${manifest.name}: every declared entry must load`);
	console.log(JSON.stringify({ name: manifest.name, sdk: sdkManifest.version, scope: "registration-only", entries: extensions.map((e) => ({ path: e.path, tools: [...e.tools.keys()], commands: [...e.commands.keys()] })) }));
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
