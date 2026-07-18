import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

import { ROOT_PACKAGE, validateReleasePolicy } from "./release-policy.mjs";

const require = createRequire(import.meta.url);
const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const temporaryDirectory = await mkdtemp(join(tmpdir(), "pi-release-policy-"));
const statusPath = join(temporaryDirectory, "status.json");

try {
	const changesetFiles = (await readdir(resolve(repositoryRoot, ".changeset"))).filter(
		(file) => file.endsWith(".md") && file.toLowerCase() !== "readme.md",
	);

	if (changesetFiles.length === 0) {
		console.log("No pending changesets; release policy check skipped.");
	} else {
		const changesetsPackagePath = require.resolve("@changesets/cli/package.json");
		const changesetsPackage = JSON.parse(await readFile(changesetsPackagePath, "utf8"));
		const changesetsCliPath = resolve(
			dirname(changesetsPackagePath),
			changesetsPackage.bin.changeset,
		);
		const result = spawnSync(
			process.execPath,
			[changesetsCliPath, "status", "--output", statusPath],
			{
				cwd: repositoryRoot,
				stdio: "inherit",
			},
		);

		if (result.error) throw result.error;
		if (result.status !== 0) process.exit(result.status ?? 1);

		const status = JSON.parse(await readFile(statusPath, "utf8"));
		const violations = validateReleasePolicy(status);
		if (violations.length > 0) {
			console.error("Invalid Changesets release plan:");
			for (const violation of violations) console.error(`- ${violation}`);
			console.error(
				`Add ${ROOT_PACKAGE} to the changeset with a release type at least as high as every changed child package.`,
			);
			process.exitCode = 1;
		} else {
			console.log("Changesets release plan follows the independent package release policy.");
		}
	}
} finally {
	await rm(temporaryDirectory, { recursive: true, force: true });
}
