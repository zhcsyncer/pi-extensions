import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");

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
	"./packages/pi-adversarial-review",
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

		const headlessReview = spawnSync(
			"pi",
			[
				"--no-extensions",
				"-e",
				"./packages/pi-adversarial-review",
				"-p",
				"/adversarial-review",
			],
			{
				cwd: repositoryRoot,
				env: { ...environment, PI_OFFLINE: "1" },
				encoding: "utf8",
			},
		);
		if (headlessReview.error) throw headlessReview.error;
		if (headlessReview.status === 0) {
			throw new Error("headless adversarial review argument failure must return a non-zero status");
		}
		if (headlessReview.stdout !== "") {
			throw new Error("headless adversarial review failure must not corrupt stdout framing");
		}
		if (!headlessReview.stderr.includes("Outside TUI, pass at least two --reviewer")) {
			process.stderr.write(headlessReview.stderr);
			throw new Error("headless adversarial review failure must explain the missing reviewer routes");
		}
		const reviewAuditDir = join(
			environment.PI_CODING_AGENT_DIR,
			"extension-data",
			"pi-adversarial-review",
			"audit",
		);
		const reviewAuditFiles = readdirSync(reviewAuditDir);
		if (reviewAuditFiles.length !== 1) {
			throw new Error("headless adversarial review failure must persist exactly one standalone audit");
		}
		const reviewAudit = JSON.parse(readFileSync(join(reviewAuditDir, reviewAuditFiles[0]), "utf8"));
		if (
			reviewAudit.kind !== "error" ||
			reviewAudit.mode !== "print" ||
			reviewAudit.payload?.kind !== "command"
		) {
			throw new Error("headless adversarial review audit must retain the failure contract");
		}
		console.log("./packages/pi-adversarial-review: headless failure contract smoke passed");

		const surfaceProbePath = join(root, "assert-review-surface.ts");
		const embeddedRuntimePath = resolve(
			repositoryRoot,
			"packages/pi-adversarial-review/src/runtime/embedded-runtime.ts",
		);
		writeFileSync(surfaceProbePath, `
import { createEmbeddedReviewRuntime } from ${JSON.stringify(embeddedRuntimePath)};

export default function (pi) {
  pi.registerCommand("assert-review-surface", {
    handler: async (_args, ctx) => {
      const runtime = await createEmbeddedReviewRuntime({ pi, ctx, maxConcurrent: 1 });
      const capabilities = await runtime.getCapabilities();
      await runtime.dispose();
      if (capabilities.backend !== "embedded" || capabilities.maxConcurrent !== 1) {
        console.error("embedded runtime capability mismatch");
        process.exitCode = 1;
        return;
      }
      const forbidden = new Set(["Agent", "get_subagent_result", "steer_subagent"]);
      const loaded = pi.getAllTools().map((tool) => tool.name).filter((name) => forbidden.has(name));
      if (loaded.length > 0) {
        console.error("unexpected Subagents tools: " + loaded.join(", "));
        process.exitCode = 1;
        return;
      }
      console.log("review surface is quiet");
    },
  });
}
`);
		const surfaceProbe = spawnSync(
			"pi",
			[
				"--no-extensions",
				"-e",
				"./packages/pi-adversarial-review",
				"-e",
				surfaceProbePath,
				"-p",
				"/assert-review-surface",
			],
			{
				cwd: repositoryRoot,
				env: { ...environment, PI_OFFLINE: "1" },
				encoding: "utf8",
			},
		);
		if (surfaceProbe.error) throw surfaceProbe.error;
		if (
			surfaceProbe.status !== 0 ||
			surfaceProbe.stdout !== "" ||
			!surfaceProbe.stderr.includes("review surface is quiet")
		) {
			process.stderr.write(surfaceProbe.stderr);
			process.stderr.write(surfaceProbe.stdout);
			throw new Error("standalone review must not auto-register Subagents tools");
		}
		console.log("./packages/pi-adversarial-review: embedded runtime and zero tool-surface smoke passed");
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	runSmokeChecks();
}
