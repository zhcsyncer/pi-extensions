export const CONTEXT_WARNING_PERCENT = 70;
export const CONTEXT_ERROR_PERCENT = 85;

export type ContextRiskLevel = "unknown" | "normal" | "warning" | "error";

export function contextRiskLevel(percent: number | null | undefined): ContextRiskLevel {
	if (percent === null || percent === undefined || !Number.isFinite(percent)) return "unknown";
	if (percent >= CONTEXT_ERROR_PERCENT) return "error";
	if (percent >= CONTEXT_WARNING_PERCENT) return "warning";
	return "normal";
}
