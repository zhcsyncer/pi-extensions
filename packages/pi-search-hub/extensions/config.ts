/**
 * Config loading and module-level mutable state for pi-search-hub extension.
 */

import type { BackendConfig, RoutingStrategy, SearchBackendName, SearchConfig } from "./types.js";
import { DEFAULT_ROUTING, KEYLESS_FALLBACK_BACKEND, SEARCH_BACKEND_NAMES } from "./types.js";
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
let config: SearchConfig = { backends: {} };

export function getConfig(): SearchConfig {
	return config;
}

export function enabledBackendNames(searchConfig: SearchConfig): SearchBackendName[] {
	const backends = searchConfig.backends ?? {};
	return SEARCH_BACKEND_NAMES.filter((name) => backends[name]?.enabled === true);
}

export function orderedActiveBackends(searchConfig: SearchConfig): SearchBackendName[] {
	const enabled = enabledBackendNames(searchConfig);
	if (enabled.length === 0) return [KEYLESS_FALLBACK_BACKEND];
	const listed = (searchConfig.priority ?? []).filter((name) => enabled.includes(name));
	return [...listed, ...enabled.filter((name) => !listed.includes(name))];
}

export function routingOf(searchConfig: SearchConfig): RoutingStrategy {
	return searchConfig.routing ?? DEFAULT_ROUTING;
}

// ---------------------------------------------------------------------------
// Config loading
// ---------------------------------------------------------------------------

export function loadConfig(cwd: string, projectTrusted = false, onNotice?: MigrationNoticeSink): SearchConfig {
	let next: SearchConfig = {
		backends: {},
		...loadMigratedSearchConfig({
			targetPath: getGlobalConfigPath(),
			legacyPath: getLegacyGlobalConfigPath(),
			scope: "global",
			onNotice,
		}),
	};

	// Save global backends before project config overwrites them.
	const preProjectBackends = { ...(next.backends ?? {}) };

	if (projectTrusted) {
		const project = loadMigratedSearchConfig({
			targetPath: getProjectConfigPath(cwd),
			legacyPath: getLegacyProjectConfigPath(cwd),
			scope: "project",
			onNotice,
		});
		next = { ...next, ...project };
		if (next.backends == null) next.backends = preProjectBackends;
		if (project.backends && typeof project.backends === "object") {
			const merged: Record<string, BackendConfig | undefined> = { ...preProjectBackends, ...next.backends };
			for (const [key, val] of Object.entries(project.backends)) {
				const bc = val as BackendConfig | undefined;
				if (bc && merged[key]) merged[key] = { ...merged[key], ...bc };
				else merged[key] = bc;
			}
			next.backends = merged;
		}
	}

	// Auto-enable backends that have a convenience env var but no explicit config yet.
	// Only enables if the backend is not explicitly disabled (enabled !== false).
	for (const [backend, envVar] of Object.entries(FALLBACK_ENV_MAP)) {
		const envValue = process.env[envVar];
		if (envValue && envValue.trim().length > 0) {
			const configBackends = next.backends as Record<string, BackendConfig> ?? {};
			const existing = configBackends[backend];
			if (!existing || existing.enabled === undefined) {
				if (!next.backends) next.backends = {};
				(next.backends as Record<string, BackendConfig>)[backend] = {
					...existing,
					enabled: true,
				};
			}
		}
	}

	return next;
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
	activeBackendsList = orderedActiveBackends(config);

	// Invalidate credential cache so shell-command keys refresh after config reload
	clearCredentialCache();

	return activeBackendsList;
}

export function getActiveBackends(): string[] {
	return activeBackendsList;
}
