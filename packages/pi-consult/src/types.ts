import type { Usage } from "@earendil-works/pi-ai";

export type GradedEffort = "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const EFFORT_ORDINAL: readonly GradedEffort[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

export type ConsultTrigger = "onDemand" | "watchdog";

export type ConsultVerdict = "recommend" | "confirm" | "revise" | "stop" | "split";
export type ConsultOutcome = "completed" | "blocked" | "failed" | "cancelled";
export type ConsultAdoptionEffect = "changed" | "confirmed" | "rejected";

export interface PanelMember {
	model: string;
	effort?: GradedEffort;
}

export interface ConsultGates {
	watchdog: number;
}

export interface ConsultBudget {
	perRun: number;
	perSession: number;
}

export interface ConsultGuidance {
	promptSnippet?: string;
	promptGuidelines?: string[];
}

export interface ConsultConfig {
	panel: PanelMember[];
	fanout: boolean;
	gates: ConsultGates;
	budget: ConsultBudget;
	disabledForModels: string[];
	guidance?: ConsultGuidance;
}

export type UsageSnapshot = Usage;

export interface ConsultRaw {
	model: string;
	effort?: GradedEffort;
	text: string;
	usage?: UsageSnapshot;
	durationMs: number;
	attempts: number;
}

export interface ConsultEnvelope {
	verdict: ConsultVerdict;
	summary: string;
	conflicts?: string[];
	raw: ConsultRaw[];
	error?: string;
}

export interface ConsultEvent {
	ts: string;
	session: string;
	toolCallId: string;
	trigger: ConsultTrigger;
	why: string;
	models: string[];
	outcome: ConsultOutcome;
	verdict: ConsultVerdict | "error";
	adopted: boolean | null;
	adoptionEffect: ConsultAdoptionEffect | null;
	tokensIn: number;
	tokensOut: number;
	cacheRead: number;
	cacheWrite: number;
	costUsd: number;
}

export type ConsultLivePhase = "connecting" | "thinking" | "writing";

export interface ConsultLiveMember {
	model: string;
	effort?: GradedEffort;
	phase: ConsultLivePhase;
	approxOutputTokens: number;
	attempt?: number;
}

export interface ConsultDetails {
	trigger: ConsultTrigger;
	models: string[];
	envelope?: ConsultEnvelope;
	outcome?: ConsultOutcome;
	live?: ConsultLiveMember[];
	errorMessage?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isGradedEffort(value: unknown): value is GradedEffort {
	return typeof value === "string" && (EFFORT_ORDINAL as readonly string[]).includes(value);
}

export function parseModelKey(key: string): { provider: string; modelId: string } | undefined {
	const trimmed = key.trim();
	if (!trimmed) return undefined;
	const normalized = trimmed.includes("/") ? trimmed : trimmed.replace(":", "/");
	const index = normalized.indexOf("/");
	if (index <= 0 || index === normalized.length - 1) return undefined;
	return { provider: normalized.slice(0, index), modelId: normalized.slice(index + 1) };
}

export function canonicalModelKey(key: string): string {
	const parsed = parseModelKey(key);
	return parsed ? `${parsed.provider}/${parsed.modelId}` : key;
}

export function modelKeyOf(model: { provider: string; id: string }): string {
	return `${model.provider}/${model.id}`;
}
