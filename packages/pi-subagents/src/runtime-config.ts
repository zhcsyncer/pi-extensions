import { resolve } from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";
import { registerAgents } from "./agent-types.js";
import { loadCustomAgents } from "./custom-agents.js";
import { loadSettings } from "./settings.js";
import type { AgentConfig } from "./types.js";

/** Only the state shared by child construction and its owning manager/activation. */
export interface AgentRuntimeConfig {
  cwd: string;
  agentDir: string;
  agents: Map<string, AgentConfig>;
  disableDefaultAgents: boolean;
  pinnedExtensions: string[];
  defaultMaxTurns?: number;
  graceTurns: number;
  rememberAgents: boolean;
  worktreeIsolation: boolean;
}

export function reloadRuntimeAgents(runtime: AgentRuntimeConfig): void {
  registerAgents(loadCustomAgents(runtime.cwd), runtime.agents, runtime.disableDefaultAgents);
}

export function loadRuntimeConfig(cwd: string, defaults: Partial<AgentRuntimeConfig> = {}): AgentRuntimeConfig {
  const settings = loadSettings(cwd);
  const runtime: AgentRuntimeConfig = {
    cwd: resolve(cwd), agentDir: getAgentDir(), agents: new Map(),
    disableDefaultAgents: settings.disableDefaultAgents ?? defaults.disableDefaultAgents ?? false,
    pinnedExtensions: [...(settings.pinnedExtensions ?? defaults.pinnedExtensions ?? [])],
    defaultMaxTurns: settings.defaultMaxTurns ?? defaults.defaultMaxTurns,
    graceTurns: settings.graceTurns ?? defaults.graceTurns ?? 5,
    rememberAgents: settings.rememberAgents ?? defaults.rememberAgents ?? true,
    worktreeIsolation: settings.worktreeIsolation ?? defaults.worktreeIsolation ?? false,
  };
  reloadRuntimeAgents(runtime);
  return runtime;
}
