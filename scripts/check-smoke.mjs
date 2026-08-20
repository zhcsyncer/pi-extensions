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
	"./packages/pi-herdr-companion",
	"./packages/pi-subagents",
	"./packages/pi-fast-mode",
	"./packages/pi-meter",
	"./providers/pi-provider-volcengine-agent-plan",
	"./providers/pi-provider-cursor-ask",
];

export function runSmokeChecks() {
	const { root, environment } = createIsolatedSmokeEnvironment();
	try {
		for (const providerPackage of [
			"pi-provider-volcengine-agent-plan",
			"pi-provider-cursor-ask",
		]) {
			const providerCheck = spawnSync(
				"pnpm",
				["--filter", providerPackage, "check"],
				{ env: environment, stdio: "inherit" },
			);
			if (providerCheck.error) throw providerCheck.error;
			if (providerCheck.status !== 0) {
				throw new Error(`${providerPackage} check exited with status ${providerCheck.status ?? 1}`);
			}
		}

		for (const packagePath of packagePaths) {
			const isAgentPlan = packagePath === "./providers/pi-provider-volcengine-agent-plan";
			const isCursorAsk = packagePath === "./providers/pi-provider-cursor-ask";
			const providerPackage = isAgentPlan
				? "pi-provider-volcengine-agent-plan"
				: isCursorAsk
					? "pi-provider-cursor-ask"
					: undefined;
			const providerId = isAgentPlan
				? "volcengine-agent-plan"
				: isCursorAsk
					? "cursor"
					: "__pi_release_check__";
			const piArgs = [
				"--no-extensions",
				"-e",
				providerPackage ? "." : packagePath,
				"--list-models",
				providerId,
			];
			const result = spawnSync(
				providerPackage ? "pnpm" : "pi",
				providerPackage
					? ["--filter", providerPackage, "exec", "pi", ...piArgs]
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
						...(isCursorAsk
							? {
								CURSOR_ACCESS_TOKEN: "release-smoke-test-token",
								PI_CURSOR_SYSTEM_CREDENTIALS: "0",
								PI_OFFLINE: "1",
							}
							: {}),
					},
					stdio: providerPackage ? "pipe" : "inherit",
					encoding: providerPackage ? "utf8" : undefined,
				},
			);
			if (result.error) throw result.error;
			if (result.status !== 0) {
				if (providerPackage) {
					process.stderr.write(result.stderr ?? "");
					process.stderr.write(result.stdout ?? "");
				}
				throw new Error(`${packagePath} smoke check exited with status ${result.status ?? 1}`);
			}
			if (providerPackage) {
				const modelCount = (result.stdout ?? "")
					.split("\n")
					.filter((line) => line.startsWith(`${providerId} `)).length;
				const expectedCount = isAgentPlan ? 13 : 6;
				if (modelCount !== expectedCount) {
					process.stderr.write(result.stderr ?? "");
					process.stderr.write(result.stdout ?? "");
					throw new Error(
						`${providerId} smoke expected ${expectedCount} models, received ${modelCount}`,
					);
				}
				console.log(`${packagePath}: catalog smoke passed (${modelCount} models)`);
			}
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runSmokeChecks();
}
