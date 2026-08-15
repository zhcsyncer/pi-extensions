import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export function createIsolatedSmokeEnvironment(baseEnvironment = process.env) {
	const root = mkdtempSync(join(tmpdir(), "pi-extensions-smoke-"));
	const home = join(root, "home");
	const xdgConfigHome = join(root, "xdg-config");
	const agentDir = join(root, "agent");
	const originalCacheRoot =
		baseEnvironment.XDG_CACHE_HOME ||
		(baseEnvironment.HOME ? join(baseEnvironment.HOME, ".cache") : join(root, "cache"));
	const corepackHome = baseEnvironment.COREPACK_HOME || join(originalCacheRoot, "node", "corepack");
	for (const directory of [home, xdgConfigHome, agentDir]) {
		mkdirSync(directory, { recursive: true });
	}

	return {
		root,
		environment: {
			...baseEnvironment,
			HOME: home,
			XDG_CONFIG_HOME: xdgConfigHome,
			PI_CODING_AGENT_DIR: agentDir,
			// pnpm is a Corepack shim. Keep its already-bootstrapped cache while
			// isolating extension config roots, so smoke remains offline-capable.
			COREPACK_HOME: corepackHome,
		},
	};
}

const packagePaths = [
	".",
	"./packages/pi-recap",
	"./packages/pi-tool-display-intent",
	"./packages/pi-todo",
	"./packages/pi-glance",
	"./packages/pi-plan-mode",
	"./packages/pi-search-hub",
	"./packages/pi-context7",
	"./packages/pi-ask-user-question",
	"./packages/pi-subagents",
	"./packages/pi-fast-mode",
	"./providers/pi-provider-volcengine-agent-plan",
];

export function runSmokeChecks() {
	const { root, environment } = createIsolatedSmokeEnvironment();
	try {
		const providerCheck = spawnSync(
			"pnpm",
			["--filter", "pi-provider-volcengine-agent-plan", "check"],
			{ env: environment, stdio: "inherit" },
		);
		if (providerCheck.error) throw providerCheck.error;
		if (providerCheck.status !== 0) {
			throw new Error(`Agent Plan provider check exited with status ${providerCheck.status ?? 1}`);
		}

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
						...environment,
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
				throw new Error(`${packagePath} smoke check exited with status ${result.status ?? 1}`);
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
		rmSync(root, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runSmokeChecks();
}
