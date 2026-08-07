import { CONFIG_DIR_NAME, getAgentDir } from "@earendil-works/pi-coding-agent";
import { join } from "node:path";

export const SUBAGENTS_EXTENSION_ID = "pi-subagents";

export function getGlobalSubagentsDataDir(agentDir = getAgentDir()): string {
  return join(agentDir, "extension-data", SUBAGENTS_EXTENSION_ID);
}

export function getProjectSubagentsDataDir(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "extension-data", SUBAGENTS_EXTENSION_ID);
}

export function getGlobalSubagentsSettingsPath(agentDir = getAgentDir()): string {
  return join(getGlobalSubagentsDataDir(agentDir), "config.json");
}

export function getLegacyGlobalSubagentsSettingsPath(agentDir = getAgentDir()): string {
  return join(agentDir, "subagents.json");
}

export function getProjectSubagentsSettingsPath(cwd: string): string {
  return join(getProjectSubagentsDataDir(cwd), "config.json");
}

export function getLegacyProjectSubagentsSettingsPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "subagents.json");
}

export function getGlobalAgentToolDescriptionPath(agentDir = getAgentDir()): string {
  return join(getGlobalSubagentsDataDir(agentDir), "agent-tool-description.md");
}

export function getLegacyGlobalAgentToolDescriptionPath(agentDir = getAgentDir()): string {
  return join(agentDir, "agent-tool-description.md");
}

export function getProjectAgentToolDescriptionPath(cwd: string): string {
  return join(getProjectSubagentsDataDir(cwd), "agent-tool-description.md");
}

export function getLegacyProjectAgentToolDescriptionPath(cwd: string): string {
  return join(cwd, CONFIG_DIR_NAME, "agent-tool-description.md");
}
