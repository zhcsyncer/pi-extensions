import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedSmokeEnvironment } from "./check-smoke.mjs";
import { runIsolated } from "./run-isolated.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hostModules = new Set(["@earendil-works/pi-ai", "@earendil-works/pi-agent-core", "@earendil-works/pi-coding-agent", "@earendil-works/pi-tui", "@sinclair/typebox", "typebox"]);

function command(executable, args, options = {}) {
	const result = spawnSync(executable, args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 180_000, ...options });
	if (result.error) throw result.error;
	assert.equal(result.status, 0, `${executable} ${args.join(" ")}\n${result.stdout}\n${result.stderr}`);
	return result.stdout;
}

function hostCopies(modules, copies = []) {
	if (!existsSync(modules)) return copies;
	for (const entry of readdirSync(modules, { withFileTypes: true })) {
		if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
		const paths = entry.name.startsWith("@")
			? readdirSync(join(modules, entry.name)).map((name) => join(modules, entry.name, name))
			: [join(modules, entry.name)];
		for (const path of paths) {
			const file = join(path, "package.json");
			if (!existsSync(file)) continue;
			const { name, version } = JSON.parse(readFileSync(file, "utf8"));
			if (hostModules.has(name)) copies.push({ name, version, path });
			hostCopies(join(path, "node_modules"), copies);
		}
	}
	return copies;
}

async function worker(output, previousRef) {
	const { DefaultPackageManager, SettingsManager } = await import("@earendil-works/pi-coding-agent");
	const version = JSON.parse(readFileSync(new URL("../package.json", import.meta.resolve("@earendil-works/pi-coding-agent")), "utf8")).version;
	assert.equal(version, "1.1.0");
	const paths = [".", ...["packages", "providers"].flatMap((group) => readdirSync(join(root, group)).map((name) => `${group}/${name}`))];
	const oldTree = join(output, "previous-source");
	mkdirSync(oldTree);
	const archive = join(output, "previous.tar");
	command("git", ["archive", "--format=tar", `--output=${archive}`, previousRef]);
	command("tar", ["-xf", archive, "-C", oldTree]);
	const results = [];
	for (const path of paths) {
		const manifest = JSON.parse(readFileSync(resolve(root, path, "package.json"), "utf8"));
		const label = manifest.name.replaceAll("/", "-").replaceAll("@", "");
		const packs = {};
		for (const [phase, tree] of [["previous", oldTree], ["candidate", root]]) {
			const destination = join(output, "packs", phase, label);
			mkdirSync(destination, { recursive: true });
			const packed = JSON.parse(command("npm", ["pack", "--ignore-scripts", "--json", "--pack-destination", destination, resolve(tree, path)]));
			packs[phase] = join(destination, packed[0].filename);
		}
		for (const mode of ["fresh", "upgrade"]) {
			const agentDir = join(output, mode, label);
			mkdirSync(agentDir, { recursive: true });
			const manager = new DefaultPackageManager({ cwd: process.env.HOME, agentDir, settingsManager: SettingsManager.inMemory() });
			const row = { path, name: manifest.name, mode, sdk: version };
			try {
				// Exercise Pi's real managed npm install flags using unpublished tarballs.
				// The previous source is an explicit Git ref, never the user's installed tree.
				if (mode === "upgrade") await manager.install(`npm:${packs.previous}`);
				await manager.install(`npm:${packs.candidate}`);
				const installed = join(agentDir, "npm", "node_modules", manifest.name);
				assert.deepEqual(JSON.parse(readFileSync(join(installed, "package.json"), "utf8")), manifest, "Candidate manifest must replace the previous tarball even at the same release version");
				row.hostCopies = hostCopies(join(agentDir, "npm", "node_modules"));
				const embedded = join(agentDir, "npm", "node_modules", "@zhcsyncer", "pi-subagents", "package.json");
				if (manifest.name === "@zhcsyncer/pi-adversarial-review" && existsSync(embedded)) row.embeddedSubagents = JSON.parse(readFileSync(embedded, "utf8")).version;
				const loaded = runIsolated(process.execPath, [join(root, "scripts/check-loader.mjs"), "--child", installed], { encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
				const log = `${label}-${mode}-loader.log`;
				writeFileSync(join(output, log), `${loaded.stdout ?? ""}${loaded.stderr ?? ""}${loaded.error ?? ""}`);
				row.loaderStatus = loaded.status ?? 1;
				row.log = log;
				assert.equal(loaded.status, 0, `${manifest.name}: installed registration failed; see ${log}`);
				assert.deepEqual(row.hostCopies, [], "Managed package tree must not retain private host modules");
				row.status = 0;
			} catch (error) {
				row.status = 1;
				row.error = String(error);
			}
			results.push(row);
			writeFileSync(join(output, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
			console.log(`${path} ${mode}: ${row.status === 0 ? "PASS" : "FAIL"}${row.error ? ` ${row.error}` : ""}`);
		}
	}
	process.exitCode = results.some((row) => row.status !== 0) ? 1 : 0;
}

if (process.argv[2] === "--worker") {
	await worker(resolve(process.argv[3]), process.argv[4]);
} else {
	const [destination, previousRef] = process.argv.slice(2);
	if (!destination || !previousRef) throw new Error("Usage: pnpm check:install <new-output-dir> <previous-git-ref> (public registry access required; no model/MCP calls)");
	const output = resolve(destination);
	assert.ok(!existsSync(output), "Choose a new output directory; existing evidence is never overwritten");
	mkdirSync(output, { recursive: true });
	const { root: sandbox, environment } = createIsolatedSmokeEnvironment();
	console.log(`Install artifacts: ${output}; isolated HOME: ${sandbox}`);
	const result = spawnSync(process.execPath, [fileURLToPath(import.meta.url), "--worker", output, previousRef], {
		cwd: root,
		env: { ...environment, npm_config_ignore_scripts: "true", npm_config_audit: "false", npm_config_fund: "false", npm_config_registry: "https://registry.npmjs.org/", npm_config_fetch_retries: "0" },
		stdio: "inherit",
	});
	if (result.error) console.error(result.error);
	process.exitCode = result.status ?? 1;
}
