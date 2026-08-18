import { appendFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

const ZERO_SHA = /^0+$/;

export function isInternalDoc(file) {
	const path = file.replaceAll("\\", "/");
	if (path === "AGENTS.md" || path === "BACKLOG.md" || path === "RELEASING.md") return true;
	if (path === ".changeset/README.md") return true;
	return path.startsWith("docs/");
}

export function needsFullCheck(files) {
	if (files.length === 0) return true;
	return files.some((file) => !isInternalDoc(file));
}

function listChangedFiles(base, head) {
	if (!base || !head || ZERO_SHA.test(base)) return null;
	const result = spawnSync("git", ["diff", "--name-only", "--diff-filter=ACMRT", `${base}...${head}`], {
		encoding: "utf8",
	});
	if (result.status !== 0) return null;
	return result.stdout
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean);
}

function writeOutput(full) {
	const line = `full=${full ? "true" : "false"}`;
	console.log(line);
	if (process.env.GITHUB_OUTPUT) {
		appendFileSync(process.env.GITHUB_OUTPUT, `${line}\n`);
	}
}

const isCli =
	Boolean(process.argv[1]) && import.meta.url === pathToFileURL(resolve(process.argv[1])).href;
if (isCli) {
	const files = listChangedFiles(process.env.CI_SCOPE_BASE, process.env.CI_SCOPE_HEAD);
	if (files === null) {
		console.log("Could not resolve a file diff; running the full package check.");
		writeOutput(true);
	} else {
		console.log(files.length === 0 ? "No changed files in diff." : `Changed files:\n${files.join("\n")}`);
		writeOutput(needsFullCheck(files));
	}
}
