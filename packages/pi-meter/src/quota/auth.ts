import { readStoredCredential, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { sanitizeQuotaError } from "./sanitize.ts";

export interface OAuthAccess {
	accessToken: string;
	accountId?: string;
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

export async function resolveOAuthAccess(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	providerId: string,
): Promise<{ ok: true; access: OAuthAccess } | { ok: false; error: string }> {
	const stored = readStoredCredential(providerId);
	if (stored?.type !== "oauth") {
		return { ok: false, error: "no subscription OAuth credentials — run /login" };
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
