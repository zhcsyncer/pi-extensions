import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../package.json", import.meta.url));
const tsxCli = require.resolve("tsx/cli");

test("HTML export keeps aggregate history target/result without fallback intent", () => {
	const result = spawnSync(process.execPath, [tsxCli, "tests/html-export-probe.ts"], {
		cwd: packageRoot,
		env: process.env,
		encoding: "utf8",
		timeout: 30_000,
	});
	assert.equal(
		result.status,
		0,
		`HTML export probe failed:\n${result.stdout}\n${result.stderr}`,
	);
	assert.match(result.stdout, /HTML_EXPORT_OK/);
});
