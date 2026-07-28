import { dirname, join } from "node:path";
import { resolvePiAgentDir } from "./agent-dir.js";

export function getToolDisplayDataDir(agentDir = resolvePiAgentDir()): string {
	return join(agentDir, "extension-data", "pi-tool-display-intent");
}

export function getToolDisplayConfigPath(agentDir = resolvePiAgentDir()): string {
	return join(getToolDisplayDataDir(agentDir), "config.json");
}

export function getLegacyToolDisplayConfigPath(agentDir = resolvePiAgentDir()): string {
	return join(agentDir, "extensions", "pi-tool-display-intent", "config.json");
}

export function getToolDisplayLegacyBackupPath(agentDir = resolvePiAgentDir()): string {
	return join(getToolDisplayDataDir(agentDir), "config.legacy.json");
}

export function getLegacyToolDisplayLegacyBackupPath(agentDir = resolvePiAgentDir()): string {
	return join(dirname(getLegacyToolDisplayConfigPath(agentDir)), "config.legacy.json");
}

export function getToolDisplayDebugLogPath(agentDir = resolvePiAgentDir()): string {
	return join(getToolDisplayDataDir(agentDir), "state", "debug.log");
}

export function getLegacyToolDisplayDebugLogPath(agentDir = resolvePiAgentDir()): string {
	return join(dirname(getLegacyToolDisplayConfigPath(agentDir)), "debug", "debug.log");
}
