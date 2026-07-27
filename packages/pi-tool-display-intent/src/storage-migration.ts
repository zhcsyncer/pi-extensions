import { randomUUID } from "node:crypto";
import {
	closeSync,
	existsSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	rmSync,
	statSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import {
	getLegacyToolDisplayConfigPath,
	getLegacyToolDisplayDebugLogPath,
	getLegacyToolDisplayLegacyBackupPath,
	getToolDisplayConfigPath,
	getToolDisplayDataDir,
	getToolDisplayDebugLogPath,
	getToolDisplayLegacyBackupPath,
} from "./storage-paths.js";

export interface PreparedToolDisplayMigration {
	copiedLegacyConfig: boolean;
	notices: string[];
}

const waitBuffer = new Int32Array(new SharedArrayBuffer(4));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function sleepSync(milliseconds: number): void {
	Atomics.wait(waitBuffer, 0, 0, milliseconds);
}

export function withToolDisplayStorageLock<T>(fn: () => T, directory = getToolDisplayDataDir()): T {
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const lockPath = join(directory, ".storage-migration.lock");
	const deadline = Date.now() + 1_000;
	let descriptor: number | undefined;
	while (descriptor === undefined) {
		try {
			descriptor = openSync(lockPath, "wx", 0o600);
			writeFileSync(descriptor, `${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			try {
				if (Date.now() - statSync(lockPath).mtimeMs > 30_000) {
					unlinkSync(lockPath);
					continue;
				}
			} catch (statError) {
				if (isRecord(statError) && statError.code === "ENOENT") continue;
				throw statError;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockPath}`);
			sleepSync(20);
		}
	}
	try {
		return fn();
	} finally {
		closeSync(descriptor);
		rmSync(lockPath, { force: true });
	}
}

function copyAtomically(source: string, target: string): void {
	const content = readFileSync(source);
	const directory = dirname(target);
	mkdirSync(directory, { recursive: true, mode: 0o700 });
	const temporary = join(directory, `.${randomUUID()}.tmp`);
	try {
		writeFileSync(temporary, content, { mode: 0o600, flag: "wx" });
		renameSync(temporary, target);
		if (!readFileSync(target).equals(content)) throw new Error(`Verification failed for ${target}`);
	} finally {
		rmSync(temporary, { force: true });
	}
}

export function prepareToolDisplayStorageMigration(): PreparedToolDisplayMigration {
	const target = getToolDisplayConfigPath();
	const legacy = getLegacyToolDisplayConfigPath();
	const notices: string[] = [];
	if (existsSync(target)) {
		if (existsSync(legacy)) notices.push(`Ignored conflicting legacy tool-display-intent config at ${legacy}; canonical config is ${target}.`);
		return { copiedLegacyConfig: false, notices };
	}
	if (!existsSync(legacy)) return { copiedLegacyConfig: false, notices };
	try {
		return withToolDisplayStorageLock(() => {
			if (existsSync(target)) return { copiedLegacyConfig: false, notices };
			copyAtomically(legacy, target);
			return { copiedLegacyConfig: true, notices };
		});
	} catch (error) {
		notices.push(`Failed to prepare tool-display-intent config migration from ${legacy} to ${target}: ${error instanceof Error ? error.message : String(error)}. The legacy file was preserved.`);
		return { copiedLegacyConfig: false, notices };
	}
}

function migrateAncillary(source: string, target: string, label: string, notices: string[]): void {
	if (!existsSync(source)) return;
	if (existsSync(target)) {
		notices.push(`Kept conflicting legacy ${label} at ${source}; canonical file is ${target}.`);
		return;
	}
	copyAtomically(source, target);
	unlinkSync(source);
	notices.push(`Migrated tool-display-intent ${label} from ${source} to ${target}.`);
}

export function finalizeToolDisplayStorageMigration(prepared: PreparedToolDisplayMigration, configValid: boolean): string[] {
	const notices = [...prepared.notices];
	try {
		withToolDisplayStorageLock(() => {
			if (prepared.copiedLegacyConfig) {
				if (!configValid) {
					notices.push(`Tool-display-intent config migration was not finalized because ${getToolDisplayConfigPath()} is invalid; ${getLegacyToolDisplayConfigPath()} was preserved.`);
					return;
				}
				unlinkSync(getLegacyToolDisplayConfigPath());
				notices.push(`Migrated tool-display-intent config from ${getLegacyToolDisplayConfigPath()} to ${getToolDisplayConfigPath()}.`);
			}
			migrateAncillary(getLegacyToolDisplayLegacyBackupPath(), getToolDisplayLegacyBackupPath(), "legacy config backup", notices);
			migrateAncillary(getLegacyToolDisplayDebugLogPath(), getToolDisplayDebugLogPath(), "debug log", notices);
		});
	} catch (error) {
		notices.push(`Failed to finalize tool-display-intent storage migration: ${error instanceof Error ? error.message : String(error)}.`);
	}
	return notices;
}
