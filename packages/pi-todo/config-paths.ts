import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const TODO_EXTENSION_ID = "pi-todo";
const LEGACY_CONFIG_DIR = "rpiv-todo";

export function getTodoDataDir(agentDir = getAgentDir()): string {
	return join(agentDir, "extension-data", TODO_EXTENSION_ID);
}

export function getTodoConfigPath(agentDir = getAgentDir()): string {
	return join(getTodoDataDir(agentDir), "config.json");
}

function defaultLegacyConfigPath(): string {
	return join(homedir(), ".config", LEGACY_CONFIG_DIR, "config.json");
}

function resolveXdgConfigHome(): string | undefined {
	const configured = process.env.XDG_CONFIG_HOME?.trim();
	if (!configured) return undefined;
	const expanded = configured === "~"
		? homedir()
		: configured.startsWith("~/")
			? join(homedir(), configured.slice(2))
			: configured;
	return isAbsolute(expanded) ? expanded : undefined;
}

/**
 * Legacy paths in their historical read precedence: XDG first, then the
 * pre-XDG ~/.config fallback. Duplicate paths are removed.
 */
export function getLegacyTodoConfigPaths(): string[] {
	const fallback = defaultLegacyConfigPath();
	const xdgRoot = resolveXdgConfigHome();
	const preferred = xdgRoot ? join(xdgRoot, LEGACY_CONFIG_DIR, "config.json") : fallback;
	return [...new Set([preferred, fallback])];
}
