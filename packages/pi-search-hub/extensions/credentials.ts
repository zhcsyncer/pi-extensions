/**
 * Credential resolution for pi-search-hub extension.
 *
 * Supports three credential formats (following pi-web-providers convention):
 *   • "!command"   → execute shell command, return trimmed stdout (cached)
 *   • "ALL_CAPS"   → read process.env[ALL_CAPS]
 *   • otherwise     → return as literal string (actual key)
 */

import { execSync } from "node:child_process";
import { COMMAND_TIMEOUT_MS } from "./utils.js";
import type { NoticeSink } from "./diagnostics.js";
import type { BackendConfig, SearchConfig } from "./types.js";
import { readKeyCursor, writeKeyCursor } from "./key-cursors.js";

// ---------------------------------------------------------------------------
// Credential cache
// ---------------------------------------------------------------------------

const commandValueCache = new Map<string, { value?: string; errorMessage?: string }>();

/** Invalidate cached shell-command credentials so key rotation takes effect. */
export function clearCredentialCache(): void {
	commandValueCache.clear();
}

// ---------------------------------------------------------------------------
// Credential resolution
// ---------------------------------------------------------------------------

/**
 * Resolve a credential reference à la pi-web-providers:
 *   • "!command"   → execute shell command, return trimmed stdout (cached)
 *   • "ALL_CAPS"   → read process.env[ALL_CAPS]
 *   • otherwise     → return as literal string (actual key)
 */
export function resolveConfigValue(reference: string | undefined, onNotice?: NoticeSink): string | undefined {
	if (!reference || reference.trim().length === 0) return undefined;
	const normalizedReference = reference.trim();

	// !command — execute shell command, cache result
	if (normalizedReference.startsWith("!")) {
		const cached = commandValueCache.get(normalizedReference);
		if (cached) {
			if (cached.errorMessage) throw new Error(cached.errorMessage);
			return cached.value;
		}
		try {
			const output = execSync(normalizedReference.slice(1), {
				encoding: "utf-8",
				stdio: ["ignore", "pipe", "pipe"],
				timeout: COMMAND_TIMEOUT_MS,
			})
				.trim();
			const value = output.length > 0 ? output : undefined;
			commandValueCache.set(normalizedReference, { value });
			return value;
		} catch {
			// Node's shell error includes the command and stderr, which can contain credentials.
			const errorMessage = "Search Hub credential command failed. Check the configured credential command and its permissions.";
			commandValueCache.set(normalizedReference, { errorMessage });
			throw new Error(errorMessage);
		}
	}

	// ALL_CAPS → env var lookup
	const envValue = process.env[normalizedReference];
	if (envValue !== undefined) {
		const normalizedEnvValue = envValue.trim();
		return normalizedEnvValue.length > 0 ? normalizedEnvValue : undefined;
	}
	if (/^[A-Z][A-Z0-9_]*$/.test(normalizedReference)) {
		// Warn: value looks like an env var reference but the env var is unset.
		// If this was intended as a literal key, rename it or set the env var.
		onNotice?.("Configured credential environment reference is unset. Check the backend API key configuration; " +
			"all-uppercase values are treated as environment references, not literal keys.");
		return undefined;
	}

	// Otherwise → literal string (actual key in config)
	// Reject common accidental non-key literals that would otherwise leak into
	// Authorization headers as "Bearer null" / "Bearer undefined".
	if (normalizedReference === "null" || normalizedReference === "undefined" || normalizedReference === "none") {
		return undefined;
	}
	return normalizedReference;
}

// ---------------------------------------------------------------------------
// Convenience env vars
// ---------------------------------------------------------------------------

/** Convenience env vars checked as fallback when config has no apiKey for a backend. */
export const FALLBACK_ENV_MAP: Record<string, string> = {
	exa: "SEARCH_EXA_API_KEY",
	tavily: "SEARCH_TAVILY_API_KEY",
	firecrawl: "SEARCH_FIRECRAWL_API_KEY",
	parallel: "SEARCH_PARALLEL_API_KEY",
};

function backendConfig(backend: string, config: SearchConfig): BackendConfig | undefined {
	return config.backends?.[backend as keyof NonNullable<SearchConfig["backends"]>];
}

function collectKeyRefs(backend: string, config: SearchConfig): string[] {
	const bc = backendConfig(backend, config);
	const refs: string[] = [];
	if (Array.isArray(bc?.apiKeys)) {
		for (const value of bc.apiKeys) {
			if (typeof value === "string" && value.trim()) refs.push(value.trim());
		}
	}
	if (refs.length === 0 && typeof bc?.apiKey === "string" && bc.apiKey.trim()) {
		refs.push(bc.apiKey.trim());
	}
	return refs;
}

/** Resolve every configured key for a backend: apiKeys (or legacy apiKey), then env fallback. */
export function resolveBackendKeys(backend: string, config: SearchConfig, onNotice?: NoticeSink): string[] {
	const notice = onNotice ? (message: string) => onNotice(`Search Hub ${backend}: ${message}`) : undefined;
	const keys: string[] = [];
	const seen = new Set<string>();
	for (const ref of collectKeyRefs(backend, config)) {
		const resolved = resolveConfigValue(ref, notice);
		if (resolved && !seen.has(resolved)) {
			seen.add(resolved);
			keys.push(resolved);
		}
	}
	if (keys.length > 0) return keys;
	const fallbackEnv = FALLBACK_ENV_MAP[backend];
	if (fallbackEnv) {
		const envValue = process.env[fallbackEnv];
		if (envValue && envValue.trim().length > 0) return [envValue.trim()];
	}
	return [];
}

/** Lazy resolution: config.apiKeys / apiKey → resolveConfigValue() → FALLBACK_ENV_MAP fallback. */
export function resolveBackendKey(backend: string, config: SearchConfig, onNotice?: NoticeSink): string | undefined {
	return resolveBackendKeys(backend, config, onNotice)[0];
}

/** Rotate only on 429 / 402 / 432 / quota exhaustion. Ordinary 4xx/5xx/timeouts stay put. */
export function isKeyRotationError(error: unknown): boolean {
	const text = error instanceof Error ? error.message : String(error);
	if (/\b(429|402|432)\b/.test(text)) return true;
	return /\bquota\b/i.test(text);
}

/**
 * Try keys starting at the persisted cursor. Advance and persist only on rotation errors.
 * A changed key list resets the cursor to 0.
 */
export async function withRotatedKeys<T>(
	backend: string,
	keys: readonly string[],
	fn: (key: string) => Promise<T>,
): Promise<T> {
	if (keys.length === 0) throw new Error(`No API keys configured for ${backend}`);
	if (keys.length === 1) return fn(keys[0]);
	const start = readKeyCursor(backend, keys);
	let lastError: unknown;
	for (let offset = 0; offset < keys.length; offset++) {
		const index = (start + offset) % keys.length;
		try {
			return await fn(keys[index]);
		} catch (error) {
			lastError = error;
			if (!isKeyRotationError(error) || offset === keys.length - 1) throw error;
			writeKeyCursor(backend, keys, (index + 1) % keys.length);
		}
	}
	throw lastError;
}

/** Describe where a backend's key comes from for setup and readiness display. */
export function getKeySource(backend: string, config: SearchConfig): { configured: boolean; source: string } {
	const refs = collectKeyRefs(backend, config);
	const ref = refs[0];
	if (!ref) {
		const fallbackEnv = FALLBACK_ENV_MAP[backend];
		if (fallbackEnv && process.env[fallbackEnv]?.trim()) {
			return { configured: true, source: `env:${fallbackEnv}` };
		}
		return { configured: false, source: "" };
	}
	if (ref.startsWith("!")) {
		return { configured: true, source: `shell:${ref.slice(0, 40)}...` };
	}
	if (ref === "null" || ref === "undefined" || ref === "none") {
		return { configured: false, source: "" };
	}
	if (/^[A-Z][A-Z0-9_]*$/.test(ref)) {
		const envValue = process.env[ref]?.trim();
		if (envValue) return { configured: true, source: `env:${ref}` };
		return { configured: false, source: `env:${ref} (unset)` };
	}
	return { configured: true, source: refs.length > 1 ? "literal keys" : "literal" };
}
