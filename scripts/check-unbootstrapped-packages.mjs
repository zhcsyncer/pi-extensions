#!/usr/bin/env node

import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { discoverWorkspacePackages, findUnbootstrappedPackages } from "./npm-bootstrap-lib.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const packages = await discoverWorkspacePackages(repositoryRoot);
const missing = await findUnbootstrappedPackages(packages);

if (missing.length === 0) {
	console.log("All public workspace packages already exist on npm; continuing with OIDC publishing.");
} else {
	console.error("Normal OIDC publishing stopped before any package was published.");
	console.error("The following public workspace packages need a one-time npm bootstrap publish:");
	for (const pkg of missing) console.error(`- ${pkg.name}@${pkg.version}`);
	console.error("");
	console.error("For each package:");
	console.error('1. Run the GitHub Actions workflow "Bootstrap npm package" from main.');
	console.error("2. Configure that package's npm Trusted Publisher for .github/workflows/release.yml.");
	console.error("3. Re-run this failed release job; normal publishing will then use OIDC.");
	process.exitCode = 1;
}
