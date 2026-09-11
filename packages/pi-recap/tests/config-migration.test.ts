import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import {
	getGlobalConfigPath,
	getLegacyGlobalConfigPath,
	getLegacyProjectConfigPath,
	getProjectConfigPath,
	loadRecapConfig,
} from "../extensions/recap.ts";

async function writeJson(file: string, value: unknown): Promise<void> {
	await mkdir(path.dirname(file), { recursive: true });
	await writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function context(cwd: string, trusted: boolean, notifications: string[]): ExtensionContext {
	return {
		cwd,
		isProjectTrusted: () => trusted,
		ui: {
			notify(message: string) {
				notifications.push(message);
			},
		},
	} as unknown as ExtensionContext;
}

test("Recap migrates global and trusted project configs while dropping unmappable fields", async () => {
	const root = await mkdtemp(path.join(tmpdir(), "pi-recap-config-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	const previousAgentDir = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = agentDir;
	const notifications: string[] = [];
	try {
		await writeJson(getLegacyGlobalConfigPath(), {
			recap: { enabled: false, removed: true },
			display: { widgetPlacement: "belowEditor", notify: true },
		});
		await writeJson(getLegacyProjectConfigPath(cwd), {
			title: { maxLength: 72, obsolete: true },
		});

		const untrusted = await loadRecapConfig(context(cwd, false, notifications));
		assert.equal(untrusted.recap.auto, false);
		assert.equal(untrusted.title.applyToSessionName, false);
		assert.equal(existsSync(getLegacyProjectConfigPath(cwd)), true);
		assert.equal(existsSync(getProjectConfigPath(cwd)), false);

		const trusted = await loadRecapConfig(context(cwd, true, notifications));
		assert.equal(trusted.recap.auto, false);
		assert.equal(existsSync(getLegacyGlobalConfigPath()), false);
		assert.equal(existsSync(getLegacyProjectConfigPath(cwd)), false);
		assert.equal(existsSync(getGlobalConfigPath()), true);
		assert.equal(existsSync(getProjectConfigPath(cwd)), true);
		const savedGlobal = await readFile(getGlobalConfigPath(), "utf8");
		assert.doesNotMatch(savedGlobal, /removed|notify|"enabled"|manualCommand|maxLength|widgetPlacement|applyPolicy|restoreOnShutdown/);
		assert.match(savedGlobal, /"auto": false/);
		assert.match(notifications.join("\n"), /recap\.removed/);
		assert.match(notifications.join("\n"), /display/);
		assert.match(notifications.join("\n"), /title\.obsolete/);
		assert.match(notifications.join("\n"), /title\.maxLength/);

	} finally {
		if (previousAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previousAgentDir;
		await rm(root, { recursive: true, force: true });
	}
});
