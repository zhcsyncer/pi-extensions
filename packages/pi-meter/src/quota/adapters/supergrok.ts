import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { isRecord } from "../../fs.ts";
import { resolveOAuthAccess } from "../auth.ts";
import { sanitizeQuotaError } from "../sanitize.ts";
import type { QuotaSnapshot, QuotaWindow } from "../types.ts";

export const SUPERGROK_BILLING_URL = "https://cli-chat-proxy.grok.com/v1/billing?format=credits";

function productLabel(id: string): string {
	if (id === "GrokBuild") return "Build";
	if (id === "GrokChat") return "Chat";
	return id;
}

export function parseSuperGrokBilling(payload: unknown, fetchedAt: number): QuotaSnapshot {
	if (!isRecord(payload) || !isRecord(payload.config)) {
		return { provider: "supergrok", title: "SuperGrok", windows: [], fetchedAt, ok: false, error: "unexpected response" };
	}
	const config = payload.config;
	const period = isRecord(config.currentPeriod) ? config.currentPeriod : undefined;
	const usedPercent = typeof config.creditUsagePercent === "number" ? config.creditUsagePercent : undefined;
	if (usedPercent === undefined) {
		return { provider: "supergrok", title: "SuperGrok", windows: [], fetchedAt, ok: false, error: "missing creditUsagePercent" };
	}
	const resetsAt = typeof period?.endTime === "string"
		? period.endTime
		: typeof period?.endsAt === "string"
			? period.endsAt
			: undefined;
	const primary: QuotaWindow = {
		id: "weekly",
		label: "Weekly credits",
		usedPercent,
		...(resetsAt ? { resetsAt } : {}),
	};
	const windows: QuotaWindow[] = [primary];
	if (Array.isArray(config.productUsage)) {
		for (const product of config.productUsage) {
			if (!isRecord(product)) continue;
			const id = typeof product.product === "string" ? product.product : typeof product.id === "string" ? product.id : undefined;
			const percent = typeof product.usagePercent === "number" ? product.usagePercent : undefined;
			if (!id || percent === undefined) continue;
			windows.push({
				id,
				label: productLabel(id),
				usedPercent: percent,
			});
		}
	}
	return {
		provider: "supergrok",
		title: "SuperGrok",
		primary,
		windows,
		fetchedAt,
		ok: true,
	};
}

export async function fetchSuperGrokQuota(
	ctx: Pick<ExtensionContext, "modelRegistry">,
	fetchedAt = Date.now(),
	fetchImpl: typeof fetch = fetch,
): Promise<QuotaSnapshot> {
	const auth = await resolveOAuthAccess(ctx, "xai");
	if (!auth.ok) {
		return { provider: "supergrok", title: "SuperGrok", windows: [], fetchedAt, ok: false, error: auth.error };
	}
	try {
		const response = await fetchImpl(SUPERGROK_BILLING_URL, {
			headers: {
				Authorization: `Bearer ${auth.access.accessToken}`,
				Accept: "application/json",
			},
		});
		if (!response.ok) {
			return { provider: "supergrok", title: "SuperGrok", windows: [], fetchedAt, ok: false, error: `HTTP ${response.status}` };
		}
		return parseSuperGrokBilling(await response.json(), fetchedAt);
	} catch (error) {
		return { provider: "supergrok", title: "SuperGrok", windows: [], fetchedAt, ok: false, error: sanitizeQuotaError(error) };
	}
}
