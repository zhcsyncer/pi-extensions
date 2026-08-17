import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export const COMPANION_EXTENSION_ID = "pi-herdr-companion";

export function getCompanionDataDir(agentDir = getAgentDir()): string {
	return join(agentDir, "extension-data", COMPANION_EXTENSION_ID);
}

export function getCompanionConfigPath(agentDir = getAgentDir()): string {
	return join(getCompanionDataDir(agentDir), "config.json");
}

export function getCompanionProcessScriptDir(agentDir = getAgentDir()): string {
	return join(getCompanionDataDir(agentDir), "process-scripts");
}
