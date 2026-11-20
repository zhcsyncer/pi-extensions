import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedSmokeEnvironment } from "./check-smoke.mjs";
import { runIsolated } from "./run-isolated.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const hashLock = (workspace) => createHash("sha256").update(readFileSync(join(workspace, "pnpm-lock.yaml"))).digest("hex");
function copyWorkspace(source, target) {
	const files = ["package.json", "pnpm-workspace.yaml", "pnpm-lock.yaml", "scripts/check-sdk.mjs"];
	for (const group of ["packages", "providers"]) {
		for (const name of readdirSync(join(source, group))) files.push(`${group}/${name}/package.json`);
	}
	for (const file of files) {
		mkdirSync(dirname(join(target, file)), { recursive: true });
		copyFileSync(join(source, file), join(target, file));
	}
}
function check(command, args, environment, log, offline) {
	const options = { cwd: environment.HOME, env: environment, encoding: "utf8", maxBuffer: 32 * 1024 * 1024, timeout: 300_000 };
	const result = offline ? runIsolated(command, args, options) : spawnSync(command, args, options);
	writeFileSync(log, `$ ${command} ${args.join(" ")}\n${result.stdout ?? ""}${result.stderr ?? ""}${result.error ?? ""}`);
	assert.equal(result.status, 0, `See ${log}: ${result.error ?? result.stderr}`);
	return result.stdout.trim();
}

const [mode, preparedArg, thirdArg] = process.argv.slice(2);
assert.ok(["prepare", "verify"].includes(mode) && preparedArg && thirdArg,
	"Usage: node scripts/check-frozen-install.mjs prepare <new-prepared-dir> <existing-store> | verify <prepared-dir> <new-verification-dir>");
const prepared = resolve(preparedArg);
const output = mode === "prepare" ? prepared : resolve(thirdArg);
assert.ok(!existsSync(output), "Choose a new output directory; never overwrite evidence");
mkdirSync(output, { recursive: true });
const { root: sandbox, environment } = createIsolatedSmokeEnvironment();
// Explicit public-only warm-up: no user config, credentials, policy cache or Corepack cache.
environment.COREPACK_HOME = join(sandbox, "corepack");
environment.pnpm_config_registry = "https://registry.npmjs.org/";
environment.pnpm_config_fetch_retries = "0";
try {
	const workspace = join(output, "workspace");
	const record = mode === "verify" ? JSON.parse(readFileSync(join(prepared, "prepared.json"), "utf8")) : undefined;
	copyWorkspace(mode === "prepare" ? root : join(prepared, "workspace"), workspace);
	const expectedPnpm = JSON.parse(readFileSync(join(workspace, "package.json"), "utf8")).packageManager.split("@")[1];
	const pnpm = check("pnpm", ["--version"], environment, join(output, "pnpm.log"), true);
	assert.equal(pnpm, expectedPnpm, "Put the exact pnpm executable on PATH; checks never download/switch package managers");
	const store = record?.store ?? resolve(thirdArg);
	assert.ok(existsSync(store), "Pass an explicitly shared content-addressed store");
	const lock = hashLock(workspace);
	if (record) {
		assert.equal(lock, record.lockSha256, "Prepared workspace lockfile changed");
		assert.equal(pnpm, record.pnpm);
		// This HOME and cache start empty. Only the explicitly prepared non-secret
		// metadata/policy cache is copied; no node_modules or user state is reused.
		assert.ok(!existsSync(environment.XDG_CACHE_HOME));
		cpSync(join(prepared, "cache"), environment.XDG_CACHE_HOME, { recursive: true });
	}
	const args = ["--dir", workspace, "install", "--frozen-lockfile", "--ignore-scripts", "--store-dir", store];
	if (record) args.push("--offline");
	check("pnpm", args, environment, join(output, "install.log"), Boolean(record));
	assert.equal(hashLock(workspace), lock, "Frozen install modified the lockfile");
	check(process.execPath, [join(workspace, "scripts/check-sdk.mjs")], environment, join(output, "sdk.log"), true);
	if (mode === "prepare") {
		cpSync(environment.XDG_CACHE_HOME, join(prepared, "cache"), { recursive: true });
		writeFileSync(join(prepared, "prepared.json"), `${JSON.stringify({ pnpm, store, lockSha256: lock, registry: environment.pnpm_config_registry }, null, 2)}\n`);
	}
	console.log(`${mode}: PASS; new isolated HOME/cache, unchanged lockfile, verified SDK graph; evidence: ${output}`);
} finally {
	rmSync(sandbox, { recursive: true, force: true });
}
