import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll } from "vitest";

const root = mkdtempSync(join(tmpdir(), "pi-todo-tests-"));
const previous = {
	HOME: process.env.HOME,
	XDG_CONFIG_HOME: process.env.XDG_CONFIG_HOME,
	PI_CODING_AGENT_DIR: process.env.PI_CODING_AGENT_DIR,
};

for (const directory of ["home", "xdg", "agent"]) mkdirSync(join(root, directory), { recursive: true });
process.env.HOME = join(root, "home");
process.env.XDG_CONFIG_HOME = join(root, "xdg");
process.env.PI_CODING_AGENT_DIR = join(root, "agent");

afterAll(() => {
	for (const [name, value] of Object.entries(previous)) {
		if (value === undefined) delete process.env[name];
		else process.env[name] = value;
	}
	rmSync(root, { recursive: true, force: true });
});
