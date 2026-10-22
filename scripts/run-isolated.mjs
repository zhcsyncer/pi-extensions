import { spawnSync } from "node:child_process";
import { rmSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIsolatedSmokeEnvironment } from "./check-smoke.mjs";

// Linux network namespaces block real services, including subprocesses, while allowing
// loopback fake transports. PI_OFFLINE alone is not a network sandbox.
export function runIsolated(command, args, options = {}) {
	if (process.platform !== "linux") throw new Error("Offline checks require Linux unshare + ip (no unsandboxed fallback)");
	const { root, environment } = createIsolatedSmokeEnvironment();
	try {
		return spawnSync("unshare", ["--net", "--", "sh", "-c", 'ip link set lo up && exec "$@"', "isolated", command, ...args], {
			...options,
			env: { ...environment, ...options.env },
			timeout: options.timeout ?? 180_000,
		});
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const [command, ...args] = process.argv.slice(2);
	if (!command) throw new Error("Usage: node scripts/run-isolated.mjs <command> [args...]");
	const result = runIsolated(command, args, { stdio: "inherit", timeout: 900_000 });
	if (result.error) console.error(result.error.message);
	process.exitCode = result.status ?? 1;
}
