export type QuotaProviderId = "claude" | "codex" | "supergrok" | "ollama";
/** Built-in id or a guest adapter id. Guest ids stay open strings. */
export type QuotaSourceId = string;

export interface QuotaWindow {
	id: string;
	label: string;
	usedPercent: number;
	resetsAt?: string;
	note?: string;
}

export interface QuotaSnapshot {
	provider: QuotaSourceId;
	title: string;
	primary?: QuotaWindow;
	windows: QuotaWindow[];
	fetchedAt: number;
	ok: boolean;
	error?: string;
	stale?: boolean;
}

export interface QuotaStoreFile {
	version: 1;
	ttlMs: number;
	minIntervalMs: number;
	providers: Partial<Record<QuotaSourceId, QuotaSnapshot>>;
	lastAttemptAt: Partial<Record<QuotaSourceId, number>>;
}

export interface QuotaRefreshDecision {
	provider: QuotaSourceId;
	refresh: boolean;
	reason: "fresh" | "min-interval" | "expired" | "forced" | "missing";
}

export const QUOTA_TTL_MS = 60_000;
export const QUOTA_MIN_INTERVAL_MS = 30_000;
export const QUOTA_PROVIDERS: readonly QuotaProviderId[] = ["claude", "codex", "supergrok", "ollama"];

export function isBuiltinQuotaProvider(id: string): id is QuotaProviderId {
	return (QUOTA_PROVIDERS as readonly string[]).includes(id);
}

export function quotaProviderTitle(id: QuotaSourceId): string {
	switch (id) {
		case "claude":
			return "Claude";
		case "codex":
			return "OpenAI Codex";
		case "supergrok":
			return "SuperGrok";
		case "ollama":
			return "Ollama Cloud";
		default:
			return id;
	}
}

export function quotaProviderBrand(id: QuotaSourceId): string {
	switch (id) {
		case "claude":
			return "claude";
		case "codex":
			return "openai";
		case "supergrok":
			return "xai";
		case "ollama":
			return "ollama";
		default:
			return id;
	}
}
