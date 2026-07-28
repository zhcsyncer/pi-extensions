/**
 * Config loading and module-level mutable state for pi-search-hub extension.
 */

import type { BackendConfig, SearchConfig } from "./types.js";
import { clearCredentialCache, FALLBACK_ENV_MAP } from "./credentials.js";
import { loadMigratedSearchConfig, type MigrationNoticeSink } from "./config-storage.js";
import {
	getGlobalConfigPath,
	getLegacyGlobalConfigPath,
	getLegacyProjectConfigPath,
	getProjectConfigPath,
} from "./paths.js";

// ---------------------------------------------------------------------------
// Module-level mutable state
// ---------------------------------------------------------------------------

/** Current runtime config. Keep private so consumers cannot retain a stale Jiti import snapshot. */
let config: SearchConfig = { defaultBackend: "duckduckgo", backends: {} };

export function getConfig(): SearchConfig {
	return config;
}

/** Round-robin counter — increments on each call, never resets until pi restarts. */
let roundRobinIndex = 0;

export function incrementRoundRobin(): number {
	return roundRobinIndex++;
}

/**
 * Latency samples per backend. Each sample is { ms, timestamp }.
 * Samples older than LATENCY_TTL_MS are pruned on every write.
 * Used by the "best-latency" selection strategy.
 */
const LATENCY_TTL_MS = 60_000;
export const latencyMap = new Map<string, { ms: number; timestamp: number }[]>();

export function recordLatency(backend: string, ms: number): void {
	const samples = latencyMap.get(backend) ?? [];
	const now = Date.now();
	// Prune stale samples
	const fresh = samples.filter(s => now - s.timestamp < LATENCY_TTL_MS);
	fresh.push({ ms, timestamp: now });
	latencyMap.set(backend, fresh);
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function loadConfig(cwd: string, projectTrusted = false, onNotice?: MigrationNoticeSink): SearchConfig {
	let config: SearchConfig = {
		defaultBackend: "duckduckgo",
		backends: {},
		...loadMigratedSearchConfig({
			targetPath: getGlobalConfigPath(),
			legacyPath: getLegacyGlobalConfigPath(),
			scope: "global",
			onNotice,
		}),
	};

	// Save global backends before project config overwrites them.
	const preProjectBackends = { ...(config.backends ?? {}) };

	if (projectTrusted) {
		const project = loadMigratedSearchConfig({
			targetPath: getProjectConfigPath(cwd),
			legacyPath: getLegacyProjectConfigPath(cwd),
			scope: "project",
			onNotice,
		});
		config = { ...config, ...project };
		if (config.backends == null) config.backends = preProjectBackends;
		if (project.backends && typeof project.backends === "object") {
			const merged = { ...preProjectBackends, ...config.backends };
			for (const [key, val] of Object.entries(project.backends)) {
				const bc = val as BackendConfig | undefined;
				if (bc && merged[key]) merged[key] = { ...merged[key], ...bc };
				else merged[key] = bc;
			}
			config.backends = merged;
		}
	}

	// Auto-enable backends that have a convenience env var but no explicit config yet.
	// Only enables if the backend is not explicitly disabled (enabled !== false).
	for (const [backend, envVar] of Object.entries(FALLBACK_ENV_MAP)) {
		const envValue = process.env[envVar];
		if (envValue && envValue.trim().length > 0) {
			const configBackends = config.backends as Record<string, BackendConfig> ?? {};
			const existing = configBackends[backend];
			if (!existing || existing.enabled === undefined) {
				if (!config.backends) config.backends = {};
				(config.backends as Record<string, BackendConfig>)[backend] = {
					...existing,
					enabled: true,
				};
			}
		}
	}

	return config;
}

// ---------------------------------------------------------------------------
// Config refresh
// ---------------------------------------------------------------------------

let activeBackendsList: string[] = [];
let configCacheTime = 0;
let configCacheKey = "";
const CONFIG_TTL_MS = 10_000; // re-read config at most every 10s

export function refreshConfig(
	cwd: string,
	projectTrusted = false,
	force = false,
	onNotice?: MigrationNoticeSink,
): string[] {
	const now = Date.now();
	const nextCacheKey = `${getGlobalConfigPath()}\0${cwd}\0${projectTrusted ? "trusted" : "untrusted"}`;
	if (!force && nextCacheKey === configCacheKey && now - configCacheTime < CONFIG_TTL_MS) return activeBackendsList;

	config = loadConfig(cwd, projectTrusted, onNotice);
	configCacheTime = now;
	configCacheKey = nextCacheKey;

	activeBackendsList = Object.entries(config.backends || {})
		.filter(([_, bc]) => bc?.enabled)
		.map(([name]) => name);

	// Always add duckduckgo if no backends explicitly enabled, since it needs no key
	if (activeBackendsList.length === 0) {
		activeBackendsList.push("duckduckgo");
	}

	// Honor defaultBackend: put it first in the auto-try order
	if (config.defaultBackend && activeBackendsList.includes(config.defaultBackend)) {
		activeBackendsList = [
			config.defaultBackend,
			...activeBackendsList.filter(b => b !== config.defaultBackend),
		];
	} else {
		config.defaultBackend = activeBackendsList[0];
	}

	// Invalidate credential cache so shell-command keys refresh after config reload
	clearCredentialCache();

	return activeBackendsList;
}

export function getActiveBackends(): string[] {
	return activeBackendsList;
}
