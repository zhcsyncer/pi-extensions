export type QuotaProviderId = "claude" | "codex" | "supergrok" | "ollama";

export interface QuotaWindow {
	id: string;
	label: string;
	usedPercent: number;
	resetsAt?: string;
	note?: string;
}

export interface QuotaSnapshot {
	provider: QuotaProviderId;
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
	providers: Partial<Record<QuotaProviderId, QuotaSnapshot>>;
	lastAttemptAt: Partial<Record<QuotaProviderId, number>>;
}

export interface QuotaRefreshDecision {
	provider: QuotaProviderId;
	refresh: boolean;
	reason: "fresh" | "min-interval" | "expired" | "forced" | "missing";
}

export const QUOTA_TTL_MS = 60_000;
export const QUOTA_MIN_INTERVAL_MS = 30_000;
export const QUOTA_PROVIDERS: readonly QuotaProviderId[] = ["claude", "codex", "supergrok", "ollama"];

export function quotaProviderTitle(id: QuotaProviderId): string {
	switch (id) {
		case "claude":
			return "Claude";
		case "codex":
			return "OpenAI Codex";
		case "supergrok":
			return "SuperGrok";
		case "ollama":
			return "Ollama Cloud";
	}
}
