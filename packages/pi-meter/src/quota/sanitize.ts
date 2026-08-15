const SECRETISH = /(sk-|eyJ|Bearer\s+\S+|token=|account[_-]?id|user[_-]?id|email)/i;

export function sanitizeQuotaError(error: unknown): string {
	const raw = error instanceof Error ? error.message : String(error);
	const compact = raw.replace(/\s+/g, " ").trim();
	if (!compact) return "request failed";
	if (SECRETISH.test(compact) || compact.includes("@")) return "request failed";
	return compact.slice(0, 160);
}
