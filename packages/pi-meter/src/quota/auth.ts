import { readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeQuotaError } from "./sanitize.ts";
import type { QuotaProviderId } from "./types.ts";

export interface OAuthAccess {
	accessToken: string;
	accountId?: string;
}

export const QUOTA_UNSIGNED_OAUTH_ERROR = "no subscription OAuth credentials — run /login";
export const OLLAMA_API_KEY_ERROR = "no Ollama Cloud API key — set OLLAMA_CLOUD_API_KEY or run /login";
export const QUOTA_NO_SNAPSHOT_YET = "no snapshot yet";
/** Old SuperGrok parser; current code treats a missing percent as 0%. */
export const QUOTA_OBSOLETE_SUPERGROK_PERCENT_ERROR = "missing creditUsagePercent";

const QUOTA_AUTH: Record<QuotaProviderId, { providerId: string; type: "oauth" | "api_key" }> = {
	claude: { providerId: "anthropic", type: "oauth" },
	codex: { providerId: "openai-codex", type: "oauth" },
	supergrok: { providerId: "xai", type: "oauth" },
	ollama: { providerId: "ollama-cloud", type: "api_key" },
};

export function unsignedQuotaError(provider: QuotaProviderId): string {
	return provider === "ollama" ? OLLAMA_API_KEY_ERROR : QUOTA_UNSIGNED_OAUTH_ERROR;
}

export function isUnsignedQuotaError(error: string | undefined): boolean {
	return error === QUOTA_UNSIGNED_OAUTH_ERROR
		|| error === OLLAMA_API_KEY_ERROR
		|| error === QUOTA_NO_SNAPSHOT_YET;
}

export function isUnsignedQuotaSnapshot(snapshot: { ok: boolean; error?: string } | undefined): boolean {
	return snapshot !== undefined && !snapshot.ok && isUnsignedQuotaError(snapshot.error);
}

export function isObsoleteQuotaError(error: string | undefined): boolean {
	return error === QUOTA_OBSOLETE_SUPERGROK_PERCENT_ERROR;
}

export function isObsoleteQuotaSnapshot(snapshot: { ok: boolean; error?: string } | undefined): boolean {
	return snapshot !== undefined && !snapshot.ok && isObsoleteQuotaError(snapshot.error);
}

export function shouldBypassQuotaMinInterval(snapshot: { ok: boolean; error?: string } | undefined): boolean {
	return isUnsignedQuotaSnapshot(snapshot) || isObsoleteQuotaSnapshot(snapshot);
}

export function hasStoredQuotaCredential(provider: QuotaProviderId): boolean {
	const spec = QUOTA_AUTH[provider];
	return readStoredCredential(spec.providerId)?.type === spec.type;
}

function decodeJwtPayload(token: string): Record<string, unknown> | undefined {
	const part = token.split(".")[1];
	if (!part) return undefined;
	try {
		const padded = part.replace(/-/g, "+").replace(/_/g, "/") + "=".repeat((4 - (part.length % 4)) % 4);
		const json = Buffer.from(padded, "base64").toString("utf8");
		const parsed = JSON.parse(json) as unknown;
		return typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) ? parsed as Record<string, unknown> : undefined;
	} catch {
		return undefined;
	}
}

function accountIdFromToken(token: string): string | undefined {
	const payload = decodeJwtPayload(token);
	const auth = payload?.["https://api.openai.com/auth"];
	if (auth && typeof auth === "object" && auth !== null && "chatgpt_account_id" in auth) {
		const id = (auth as { chatgpt_account_id?: unknown }).chatgpt_account_id;
		if (typeof id === "string" && id) return id;
	}
	return undefined;
}

export async function resolveApiKeyAccess(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	providerId: string,
): Promise<{ ok: true; apiKey: string } | { ok: false; error: string }> {
	const stored = readStoredCredential(providerId);
	if (stored?.type !== "api_key") {
		return { ok: false, error: OLLAMA_API_KEY_ERROR };
	}
	try {
		const apiKey = await ctx.modelRegistry.getApiKeyForProvider(providerId);
		if (!apiKey) return { ok: false, error: OLLAMA_API_KEY_ERROR };
		return { ok: true, apiKey };
	} catch (error) {
		return { ok: false, error: sanitizeQuotaError(error) };
	}
}

export async function resolveOAuthAccess(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	providerId: string,
): Promise<{ ok: true; access: OAuthAccess } | { ok: false; error: string }> {
	const stored = readStoredCredential(providerId);
	if (stored?.type !== "oauth") {
		return { ok: false, error: QUOTA_UNSIGNED_OAUTH_ERROR };
	}
	try {
		const accessToken = await ctx.modelRegistry.getApiKeyForProvider(providerId);
		if (!accessToken) return { ok: false, error: "token refresh failed — run /login" };
		const accountId = typeof stored.accountId === "string" && stored.accountId
			? stored.accountId
			: accountIdFromToken(accessToken);
		return { ok: true, access: { accessToken, ...(accountId ? { accountId } : {}) } };
	} catch (error) {
		return { ok: false, error: sanitizeQuotaError(error) };
	}
}
