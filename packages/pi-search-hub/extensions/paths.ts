import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export const SEARCH_HUB_EXTENSION_ID = "pi-search-hub";

export function getSearchHubDataDir(agentDir = getAgentDir()): string {
	return join(agentDir, "extension-data", SEARCH_HUB_EXTENSION_ID);
}

export function getGlobalConfigPath(agentDir = getAgentDir()): string {
	return join(getSearchHubDataDir(agentDir), "config.json");
}

export function getLegacyGlobalConfigPath(agentDir = getAgentDir()): string {
	return join(agentDir, "extensions", "search.json");
}

export function getProjectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "extension-data", SEARCH_HUB_EXTENSION_ID, "config.json");
}

export function getLegacyProjectConfigPath(cwd: string): string {
	return join(cwd, CONFIG_DIR_NAME, "search.json");
}

export function getExaUsagePath(agentDir = getAgentDir()): string {
	return join(getSearchHubDataDir(agentDir), "state", "exa-usage.json");
}

export function getLegacyExaUsagePath(agentDir = getAgentDir()): string {
	return join(agentDir, "exa-usage.json");
}
