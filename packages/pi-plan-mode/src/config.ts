import { randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, rm, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export type PlanContentLanguage = "auto" | "en" | "zh-CN";

export interface PlanModeConfig {
	contentLanguage: PlanContentLanguage;
}

export interface LoadedPlanModeConfig {
	config: PlanModeConfig;
	path: string;
	warning?: string;
}

export const DEFAULT_PLAN_MODE_CONFIG: PlanModeConfig = {
	contentLanguage: "auto",
};

const CONTENT_LANGUAGES = new Set<PlanContentLanguage>(["auto", "en", "zh-CN"]);

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isMissingFile(error: unknown): boolean {
	return isRecord(error) && error.code === "ENOENT";
}

export function getPlanModeConfigPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "extension-data", "pi-plan-mode", "config.json");
}

export function getLegacyPlanModeConfigPath(agentDir = getAgentDir()): string {
	return path.join(agentDir, "plan-mode.json");
}

export function parsePlanModeConfig(value: unknown): PlanModeConfig {
	if (!isRecord(value)) throw new Error("the root value must be a JSON object");
	if (value.contentLanguage === undefined) return { ...DEFAULT_PLAN_MODE_CONFIG };
	if (typeof value.contentLanguage !== "string" || !CONTENT_LANGUAGES.has(value.contentLanguage as PlanContentLanguage)) {
		throw new Error('contentLanguage must be one of "auto", "en", or "zh-CN"');
	}
	return { contentLanguage: value.contentLanguage as PlanContentLanguage };
}

async function exists(file: string): Promise<boolean> {
	try {
		await stat(file);
		return true;
	} catch (error) {
		if (isMissingFile(error)) return false;
		throw error;
	}
}

async function writeConfigAtomically(file: string, config: PlanModeConfig): Promise<void> {
	const directory = path.dirname(file);
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const temporary = path.join(directory, `.${randomUUID()}.tmp`);
	try {
		await writeFile(temporary, `${JSON.stringify(config, null, 2)}\n`, { encoding: "utf8", mode: 0o600, flag: "wx" });
		await rename(temporary, file);
		await chmod(file, 0o600);
	} finally {
		await rm(temporary, { force: true });
	}
}

async function withMigrationLock<T>(directory: string, fn: () => Promise<T>): Promise<T> {
	await mkdir(directory, { recursive: true, mode: 0o700 });
	const lockPath = path.join(directory, ".config-migration.lock");
	const deadline = Date.now() + 2_000;
	let handle: Awaited<ReturnType<typeof open>> | undefined;
	while (!handle) {
		try {
			handle = await open(lockPath, "wx", 0o600);
			await handle.writeFile(`${JSON.stringify({ pid: process.pid, createdAt: new Date().toISOString() })}\n`);
		} catch (error) {
			if (!isRecord(error) || error.code !== "EEXIST") throw error;
			try {
				if (Date.now() - (await stat(lockPath)).mtimeMs > 30_000) {
					await unlink(lockPath);
					continue;
				}
			} catch (statError) {
				if (isMissingFile(statError)) continue;
				throw statError;
			}
			if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${lockPath}`);
			await new Promise((resolve) => setTimeout(resolve, 25));
		}
	}
	try {
		return await fn();
	} finally {
		await handle.close();
		await rm(lockPath, { force: true });
	}
}

function parseStoredConfig(raw: string): { config: PlanModeConfig; dropped: string[] } {
	const value = JSON.parse(raw) as unknown;
	const config = parsePlanModeConfig(value);
	const dropped = isRecord(value) ? Object.keys(value).filter((key) => key !== "contentLanguage") : [];
	return { config, dropped };
}

function droppedSummary(dropped: readonly string[]): string {
	return dropped.length > 0 ? ` Dropped unmappable fields: ${dropped.join(", ")}.` : "";
}

export async function loadPlanModeConfig(agentDir = getAgentDir()): Promise<LoadedPlanModeConfig> {
	const configPath = getPlanModeConfigPath(agentDir);
	const legacyPath = getLegacyPlanModeConfigPath(agentDir);
	if (await exists(configPath)) {
		try {
			let loaded = parseStoredConfig(await readFile(configPath, "utf8"));
			let warning: string | undefined;
			if (loaded.dropped.length > 0) {
				loaded = await withMigrationLock(path.dirname(configPath), async () => {
					const current = parseStoredConfig(await readFile(configPath, "utf8"));
					if (current.dropped.length > 0) await writeConfigAtomically(configPath, current.config);
					return current;
				});
				warning = `Upgraded Plan Mode config at ${configPath}.${droppedSummary(loaded.dropped)}`;
			}
			if (await exists(legacyPath)) warning = `${warning ? `${warning} ` : ""}Ignored conflicting legacy Plan Mode config at ${legacyPath}.`;
			return { config: loaded.config, path: configPath, ...(warning ? { warning } : {}) };
		} catch (error) {
			return {
				config: { ...DEFAULT_PLAN_MODE_CONFIG },
				path: configPath,
				warning: `Invalid Plan Mode config at ${configPath}: ${error instanceof Error ? error.message : String(error)}. The file was preserved; Using contentLanguage "auto".`,
			};
		}
	}
	if (!(await exists(legacyPath))) return { config: { ...DEFAULT_PLAN_MODE_CONFIG }, path: configPath };
	try {
		return await withMigrationLock(path.dirname(configPath), async () => {
			if (await exists(configPath)) {
				const raced = parseStoredConfig(await readFile(configPath, "utf8"));
				return { config: raced.config, path: configPath };
			}
			const loaded = parseStoredConfig(await readFile(legacyPath, "utf8"));
			await writeConfigAtomically(configPath, loaded.config);
			const verified = parseStoredConfig(await readFile(configPath, "utf8")).config;
			await unlink(legacyPath);
			return {
				config: verified,
				path: configPath,
				warning: `Migrated Plan Mode config from ${legacyPath} to ${configPath}.${droppedSummary(loaded.dropped)}`,
			};
		});
	} catch (error) {
		return {
			config: { ...DEFAULT_PLAN_MODE_CONFIG },
			path: configPath,
			warning: `Invalid Plan Mode config at ${legacyPath}: ${error instanceof Error ? error.message : String(error)}. The legacy file was preserved; Using contentLanguage "auto".`,
		};
	}
}
