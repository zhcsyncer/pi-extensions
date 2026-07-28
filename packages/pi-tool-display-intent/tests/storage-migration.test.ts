import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import test from "node:test";
import { finalizeToolDisplayStorageMigration, prepareToolDisplayStorageMigration } from "../src/storage-migration.js";
import {
	getLegacyToolDisplayConfigPath,
	getLegacyToolDisplayDebugLogPath,
	getLegacyToolDisplayLegacyBackupPath,
	getToolDisplayConfigPath,
	getToolDisplayDebugLogPath,
	getToolDisplayLegacyBackupPath,
} from "../src/storage-paths.js";

function write(file: string, content: string): void {
	mkdirSync(dirname(file), { recursive: true });
	writeFileSync(file, content);
}

test("tool-display-intent migrates config, backup, and debug log into extension-data", () => {
	const root = mkdtempSync(join(tmpdir(), "pi-tool-display-storage-"));
	const previous = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	try {
		write(getLegacyToolDisplayConfigPath(), '{"previewRows":7,"removed":true}\n');
		write(getLegacyToolDisplayLegacyBackupPath(), '{"previewLines":5}\n');
		write(getLegacyToolDisplayDebugLogPath(), "diagnostic\n");

		const prepared = prepareToolDisplayStorageMigration();
		assert.equal(prepared.copiedLegacyConfig, true);
		assert.equal(existsSync(getLegacyToolDisplayConfigPath()), true, "legacy config stays until canonical validation succeeds");
		assert.equal(readFileSync(getToolDisplayConfigPath(), "utf8"), '{"previewRows":7,"removed":true}\n');

		const notices = finalizeToolDisplayStorageMigration(prepared, true);
		assert.equal(existsSync(getLegacyToolDisplayConfigPath()), false);
		assert.equal(existsSync(getLegacyToolDisplayLegacyBackupPath()), false);
		assert.equal(existsSync(getLegacyToolDisplayDebugLogPath()), false);
		assert.equal(readFileSync(getToolDisplayLegacyBackupPath(), "utf8"), '{"previewLines":5}\n');
		assert.equal(readFileSync(getToolDisplayDebugLogPath(), "utf8"), "diagnostic\n");
		assert.match(notices.join("\n"), /Migrated tool-display-intent config/);
	} finally {
		if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR;
		else process.env.PI_CODING_AGENT_DIR = previous;
		rmSync(root, { recursive: true, force: true });
	}
});
