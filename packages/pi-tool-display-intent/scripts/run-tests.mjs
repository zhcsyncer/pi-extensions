import { readdirSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { spawnSync } from "node:child_process";

const packageRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const require = createRequire(new URL("../package.json", import.meta.url));
const tsxCli = require.resolve("tsx/cli");
const testFiles = readdirSync(join(packageRoot, "tests"))
	.filter((file) => file.endsWith(".test.ts"))
	.sort()
	.map((file) => join("tests", file));
const isolatedAgentDir = mkdtempSync(join(tmpdir(), "pi-tool-display-tests-"));

try {
	const result = spawnSync(process.execPath, [tsxCli, "--test", ...testFiles], {
		cwd: packageRoot,
		env: {
			...process.env,
			PI_CODING_AGENT_DIR: isolatedAgentDir,
		},
		stdio: "inherit",
	});
	if (result.error) throw result.error;
	process.exitCode = result.status ?? 1;
} finally {
	rmSync(isolatedAgentDir, { recursive: true, force: true });
}
