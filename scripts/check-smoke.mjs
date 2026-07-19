import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const isolatedAgentDir = mkdtempSync(join(tmpdir(), "pi-extensions-smoke-"));
const packagePaths = [
	".",
	"./packages/pi-recap",
	"./packages/pi-tool-display-intent",
];

try {
	for (const packagePath of packagePaths) {
		const result = spawnSync(
			"pi",
			["--no-extensions", "-e", packagePath, "--list-models", "__pi_release_check__"],
			{
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: isolatedAgentDir,
				},
				stdio: "inherit",
			},
		);
		if (result.error) throw result.error;
		if (result.status !== 0) process.exit(result.status ?? 1);
	}
} finally {
	rmSync(isolatedAgentDir, { recursive: true, force: true });
}
