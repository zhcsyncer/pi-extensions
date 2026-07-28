import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import { getAgentDir } from "@earendil-works/pi-coding-agent";

export interface Context7Config {
  apiKey?: string;
}

interface ConfigCache {
  path: string;
  mtimeMs: number;
  apiKey?: string;
}

let cache: ConfigCache | undefined;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonEmpty(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

/** Global config path used by the Context7 extension. */
export function getContext7ConfigPath(agentDir = getAgentDir()): string {
  return path.join(agentDir, "extension-data", "pi-context7", "config.json");
}

/** Test helper: drop the in-memory config cache. */
export function clearContext7ConfigCache(): void {
  cache = undefined;
}

/**
 * Read apiKey from extension-data config when present.
 * Missing/invalid files are treated as "no config key".
 */
export function readContext7ConfigApiKey(agentDir = getAgentDir()): string | undefined {
  const configPath = getContext7ConfigPath(agentDir);
  try {
    const { mtimeMs } = statSync(configPath);
    if (cache && cache.path === configPath && cache.mtimeMs === mtimeMs) {
      return cache.apiKey;
    }

    const parsed = JSON.parse(readFileSync(configPath, "utf8")) as unknown;
    const apiKey =
      isRecord(parsed) && typeof parsed.apiKey === "string"
        ? nonEmpty(parsed.apiKey)
        : undefined;
    cache = { path: configPath, mtimeMs, apiKey };
    return apiKey;
  } catch {
    // Missing file, unreadable path, or invalid JSON → no configured key.
    if (cache?.path === configPath) cache = undefined;
    return undefined;
  }
}

/**
 * Resolve the active API key.
 * Preference: config.json `apiKey`, then `CONTEXT7_API_KEY` env fallback.
 */
export function resolveContext7ApiKey(agentDir = getAgentDir()): string | undefined {
  return readContext7ConfigApiKey(agentDir) ?? nonEmpty(process.env.CONTEXT7_API_KEY);
}
