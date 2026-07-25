#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import {
	assertVersionPrApplied,
	discoverWorkspacePackages,
	packageExistsOnRegistry,
	selectBootstrapPackage,
} from "./npm-bootstrap-lib.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const requestedName = process.argv[2];

function run(command, args, options = {}) {
	const result = spawnSync(command, args, {
		cwd: options.cwd ?? repositoryRoot,
		encoding: options.capture ? "utf8" : undefined,
		stdio: options.capture ? ["ignore", "pipe", "pipe"] : "inherit",
		env: process.env,
	});
	if (result.error) throw result.error;
	if (result.status !== 0) {
		const detail = options.capture ? `: ${(result.stderr || result.stdout || "").trim()}` : "";
		throw new Error(`${command} ${args.join(" ")} failed with exit code ${result.status}${detail}`);
	}
	return options.capture ? result.stdout.trim() : "";
}

if (!process.env.NODE_AUTH_TOKEN?.trim()) {
	throw new Error("NODE_AUTH_TOKEN is missing. Configure NPM_BOOTSTRAP_TOKEN in the protected npm-bootstrap environment.");
}
if (process.env.GITHUB_ACTIONS === "true" && process.env.GITHUB_REF !== "refs/heads/main") {
	throw new Error(`Bootstrap publishing must run from main, not ${process.env.GITHUB_REF || "an unknown ref"}.`);
}

const status = run("git", ["status", "--porcelain"], { capture: true });
if (status) throw new Error("Bootstrap checkout is not clean; refusing to publish.");
const head = run("git", ["rev-parse", "HEAD"], { capture: true });
const remoteMain = run("git", ["rev-parse", "origin/main"], { capture: true });
if (head !== remoteMain) throw new Error("Bootstrap checkout does not match origin/main.");

const packages = await discoverWorkspacePackages(repositoryRoot);
const selected = selectBootstrapPackage(packages, requestedName);
if (await packageExistsOnRegistry(selected.name)) {
	throw new Error(`${selected.name} already exists on npm. Publish future versions through the normal OIDC release workflow.`);
}

let changelog;
try {
	changelog = await readFile(join(selected.directory, "CHANGELOG.md"), "utf8");
} catch (error) {
	throw new Error(`${selected.name} must have a CHANGELOG.md produced by the Changesets version PR.`);
}
assertVersionPrApplied(selected, changelog);

console.log(`Bootstrap publishing ${selected.name}@${selected.version} from ${selected.directory}`);
run("npm", ["pack", "--dry-run"], { cwd: selected.directory });
run("npm", ["publish", "--access", "public"], { cwd: selected.directory });

console.log("");
console.log(`Bootstrap publish completed for ${selected.name}@${selected.version}.`);
console.log("Next steps:");
console.log("1. Configure this package's npm Trusted Publisher for .github/workflows/release.yml.");
console.log("2. Re-run the previously failed normal release job so OIDC publishing and release reconciliation can finish.");
