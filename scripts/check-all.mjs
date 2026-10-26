import { mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { runIsolated } from "./run-isolated.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const output = resolve(process.argv[2] ?? "/var/tmp/pi-extensions-check-all");
mkdirSync(output, { recursive: true });
const packages = ["packages", "providers"].flatMap((group) =>
	readdirSync(resolve(root, group)).map((name) => `${group}/${name}`));
const results = [];
function check(path, step, args) {
	const result = runIsolated("pnpm", args, { cwd: root, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 });
	const log = `${path.replaceAll("/", "-")}-${step}.log`;
	writeFileSync(resolve(output, log), `${result.stdout ?? ""}${result.stderr ?? ""}${result.error ? `\n${result.error.message}\n` : ""}`);
	results.push({ path, step, status: result.status ?? 1, signal: result.signal, log });
	console.log(`${path} ${step}: ${result.status === 0 ? "PASS" : "FAIL"} (${log})`);
}
for (const path of packages) {
	const manifest = JSON.parse(readFileSync(resolve(root, path, "package.json"), "utf8"));
	// Run leaves independently: a type failure must not hide runtime/test failures.
	const steps = ["typecheck", "test"];
	if (manifest.name === "pi-provider-cursor-ask") steps.push("lint", "format:check", "security-check", "proto:check", "test:legacy", "build");
	for (const step of steps) {
		if (!manifest.scripts?.[step]) throw new Error(`${path}: missing ${step}; classify explicitly instead of silently skipping`);
		check(path, step, ["--dir", path, step]);
	}
}
for (const step of ["check:sdk", "check:isolated", "check:release-policy", "check:loader", "check:smoke", "check:pack"]) check("root", step, [step]);
writeFileSync(resolve(output, "results.json"), `${JSON.stringify(results, null, 2)}\n`);
process.exitCode = results.some((result) => result.status !== 0) ? 1 : 0;
