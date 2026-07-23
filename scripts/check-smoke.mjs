import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";

const isolatedAgentDir = mkdtempSync(join(tmpdir(), "pi-extensions-smoke-"));
const packagePaths = [
	".",
	"./packages/pi-recap",
	"./packages/pi-tool-display-intent",
	"./packages/pi-todo",
	"./packages/pi-search-hub",
	"./providers/pi-provider-volcengine-agent-plan",
];

try {
	const providerCheck = spawnSync(
		"pnpm",
		["--filter", "pi-provider-volcengine-agent-plan", "check"],
		{ stdio: "inherit" },
	);
	if (providerCheck.error) throw providerCheck.error;
	if (providerCheck.status !== 0) process.exit(providerCheck.status ?? 1);

	for (const packagePath of packagePaths) {
		const isAgentPlan = packagePath === "./providers/pi-provider-volcengine-agent-plan";
		const piArgs = [
			"--no-extensions",
			"-e",
			isAgentPlan ? "." : packagePath,
			"--list-models",
			isAgentPlan ? "volcengine-agent-plan" : "__pi_release_check__",
		];
		const result = spawnSync(
			isAgentPlan ? "pnpm" : "pi",
			isAgentPlan
				? ["--filter", "pi-provider-volcengine-agent-plan", "exec", "pi", ...piArgs]
				: piArgs,
			{
				env: {
					...process.env,
					PI_CODING_AGENT_DIR: isolatedAgentDir,
					...(isAgentPlan
						? {
							ARK_AGENT_PLAN_API_KEY: "release-smoke-test-key",
							ARK_AGENT_PLAN_TIER: "small",
						}
						: {}),
				},
				stdio: isAgentPlan ? "pipe" : "inherit",
				encoding: isAgentPlan ? "utf8" : undefined,
			},
		);
		if (result.error) throw result.error;
		if (result.status !== 0) {
			if (isAgentPlan) {
				process.stderr.write(result.stderr ?? "");
				process.stderr.write(result.stdout ?? "");
			}
			process.exit(result.status ?? 1);
		}
		if (isAgentPlan) {
			const modelCount = (result.stdout ?? "")
				.split("\n")
				.filter((line) => line.startsWith("volcengine-agent-plan ")).length;
			if (modelCount !== 12) {
				process.stderr.write(result.stderr ?? "");
				process.stderr.write(result.stdout ?? "");
				throw new Error(`Agent Plan Small smoke expected 12 models, received ${modelCount}`);
			}
			console.log(`${packagePath}: Pi 0.81 Small catalog smoke passed (${modelCount} models)`);
		}
	}
} finally {
	rmSync(isolatedAgentDir, { recursive: true, force: true });
}
