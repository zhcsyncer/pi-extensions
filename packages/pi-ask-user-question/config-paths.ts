import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";

export const ASK_USER_QUESTION_EXTENSION_ID = "pi-ask-user-question";
const LEGACY_CONFIG_DIR = "rpiv-ask-user-question";

export function getAskUserQuestionDataDir(agentDir = getAgentDir()): string {
	return join(agentDir, "extension-data", ASK_USER_QUESTION_EXTENSION_ID);
}

export function getAskUserQuestionConfigPath(agentDir = getAgentDir()): string {
	return join(getAskUserQuestionDataDir(agentDir), "config.json");
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
export function getLegacyAskUserQuestionConfigPaths(): string[] {
	const fallback = defaultLegacyConfigPath();
	const xdgRoot = resolveXdgConfigHome();
	const preferred = xdgRoot ? join(xdgRoot, LEGACY_CONFIG_DIR, "config.json") : fallback;
	return [...new Set([preferred, fallback])];
}
