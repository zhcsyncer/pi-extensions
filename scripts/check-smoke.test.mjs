import assert from "node:assert/strict";
import { existsSync, rmSync } from "node:fs";
import { dirname } from "node:path";
import test from "node:test";

import { createIsolatedSmokeEnvironment } from "./check-smoke.mjs";

test("isolates every user-level config root used by smoke extensions", () => {
	const baseEnvironment = {
		HOME: "/real/home",
		XDG_CONFIG_HOME: "/real/xdg-config",
		PI_CODING_AGENT_DIR: "/real/agent",
		PATH: process.env.PATH,
	};
	const { root, environment } = createIsolatedSmokeEnvironment(baseEnvironment);

	try {
		assert.deepEqual(baseEnvironment, {
			HOME: "/real/home",
			XDG_CONFIG_HOME: "/real/xdg-config",
			PI_CODING_AGENT_DIR: "/real/agent",
			PATH: process.env.PATH,
		});
		assert.equal(environment.PATH, process.env.PATH);
		assert.equal(environment.COREPACK_HOME, "/real/home/.cache/node/corepack");

		for (const name of ["HOME", "XDG_CONFIG_HOME", "PI_CODING_AGENT_DIR"]) {
			assert.notEqual(environment[name], baseEnvironment[name]);
			assert.equal(dirname(environment[name]), root);
			assert.equal(existsSync(environment[name]), true);
		}
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
