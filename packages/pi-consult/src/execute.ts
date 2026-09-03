/**
 * Adapted from MIT-licensed @juicesharp/rpiv-advisor 2.8.0
 * (https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor).
 * Copyright (c) 2026 juicesharp.
 *
 * Side-call path: buildSessionContext → convertToLlm → tail massage →
 * inventory prefix → completeSimple({ tools: [] }). Failures all funnel through
 * the single envelope constructor.
 */

import type { AssistantMessage, Message, TextContent, ThinkingLevel } from "@earendil-works/pi-ai";
import {
	type AgentToolResult,
	type AgentToolUpdateCallback,
	buildSessionContext,
	convertToLlm,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { budgetBlockReason } from "./budget.ts";
import { prepareConsultMessages } from "./context.ts";
import {
	addUsage,
	type AdvisorOutcome,
	buildConsultToolResult,
	errorEnvelope,
	mergeAdvisorOutcomes,
	sumUsage,
	usageSnapshotFrom,
} from "./envelope.ts";
import { appendConsultEvent } from "./events.ts";
import { getInventoryMessage } from "./inventory.ts";
import {
	ERR_CALL_ABORTED,
	ERR_EMPTY_RESPONSE,
	ERR_EMPTY_WHY,
	ERR_NO_MODEL,
	ERR_NO_MODEL_DETAIL,
	ERR_NO_PANEL,
	ERR_NO_PANEL_DETAIL,
	errCallFailed,
	errCallThrew,
	errMisconfigured,
	errNoApiKey,
	errNoApiKeyDetail,
	msgConsulting,
} from "./messages.ts";
import { sessionIdFrom } from "./paths.ts";
import { resolvePanelMembers, selectPanel, type ResolvedPanelMember } from "./panel.ts";
import { getRuntimeCompleteSimple, loadCompleteSimple } from "./pi-compat.ts";
import { CONSULT_SYSTEM_PROMPT } from "./prompt.ts";
import type { ConsultTracker } from "./tracker.ts";
import type { ConsultConfig, ConsultDetails, ConsultOutcome, ConsultTrigger } from "./types.ts";

export type CompleteSimpleFn = (
	model: ResolvedPanelMember["model"],
	context: { systemPrompt: string; messages: Message[]; tools: [] },
	options: { signal?: AbortSignal; reasoning?: ThinkingLevel; apiKey?: string; headers?: unknown },
) => Promise<AssistantMessage>;

function advisorTextFromResponse(response: AssistantMessage): string {
	return response.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

async function callAdvisorMember(opts: {
	member: ResolvedPanelMember;
	messages: Message[];
	completeSimple: CompleteSimpleFn;
	signal?: AbortSignal;
	apiKey?: string;
	headers?: unknown;
	useRuntimeFacade: boolean;
}): Promise<AdvisorOutcome> {
	const requestOptions = opts.useRuntimeFacade
		? { signal: opts.signal, reasoning: opts.member.effort }
		: { apiKey: opts.apiKey, headers: opts.headers, signal: opts.signal, reasoning: opts.member.effort };

	let accumulatedUsage: ReturnType<typeof usageSnapshotFrom>;
	const call = async (): Promise<AssistantMessage> => {
		const response = await opts.completeSimple(
			opts.member.model,
			{ systemPrompt: CONSULT_SYSTEM_PROMPT, messages: opts.messages, tools: [] },
			requestOptions,
		);
		accumulatedUsage = addUsage(accumulatedUsage, usageSnapshotFrom(response.usage));
		return response;
	};

	try {
		let response = await call();
		if (response.stopReason === "aborted") {
			return { ok: false, label: opts.member.label, error: ERR_CALL_ABORTED, usage: accumulatedUsage };
		}
		if (response.stopReason === "error") {
			return {
				ok: false,
				label: opts.member.label,
				error: errCallFailed(response.errorMessage),
				usage: accumulatedUsage,
			};
		}
		let text = advisorTextFromResponse(response);
		if (!text) {
			response = await call();
			if (response.stopReason === "aborted") {
				return { ok: false, label: opts.member.label, error: ERR_CALL_ABORTED, usage: accumulatedUsage };
			}
			if (response.stopReason === "error") {
				return {
					ok: false,
					label: opts.member.label,
					error: errCallFailed(response.errorMessage),
					usage: accumulatedUsage,
				};
			}
			text = advisorTextFromResponse(response);
			if (!text) {
				return { ok: false, label: opts.member.label, error: ERR_EMPTY_RESPONSE, usage: accumulatedUsage };
			}
		}
		return { ok: true, label: opts.member.label, text, usage: accumulatedUsage };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			label: opts.member.label,
			error: errCallThrew(message),
			...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
		};
	}
}

export async function runConsultPanel(opts: {
	members: ResolvedPanelMember[];
	messages: Message[];
	completeSimple: CompleteSimpleFn;
	signal?: AbortSignal;
	authFor?: (member: ResolvedPanelMember) => Promise<{
		ok: boolean;
		error?: string;
		apiKey?: string;
		headers?: unknown;
	}>;
	useRuntimeFacade: boolean;
}): Promise<AdvisorOutcome[]> {
	const runMember = async (member: ResolvedPanelMember): Promise<AdvisorOutcome> => {
		if (opts.authFor) {
			const auth = await opts.authFor(member);
			if (!auth.ok) {
				return {
					ok: false,
					label: member.label,
					error: errMisconfigured(member.label, auth.error ?? ERR_NO_MODEL_DETAIL),
				};
			}
			if (!auth.apiKey && !opts.useRuntimeFacade) {
				return {
					ok: false,
					label: member.label,
					error: errNoApiKey(member.label),
				};
			}
			return callAdvisorMember({
				member,
				messages: opts.messages,
				completeSimple: opts.completeSimple,
				signal: opts.signal,
				apiKey: auth.apiKey,
				headers: auth.headers,
				useRuntimeFacade: opts.useRuntimeFacade,
			});
		}
		return callAdvisorMember({
			member,
			messages: opts.messages,
			completeSimple: opts.completeSimple,
			signal: opts.signal,
			useRuntimeFacade: opts.useRuntimeFacade,
		});
	};

	if (opts.members.length <= 1) {
		const member = opts.members[0];
		if (!member) return [];
		return [await runMember(member)];
	}
	return Promise.all(opts.members.map((member) => runMember(member)));
}

export interface ExecuteConsultOptions {
	why: string;
	toolCallId?: string;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	config: ConsultConfig;
	tracker: ConsultTracker;
	agentDir?: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<ConsultDetails>;
	completeSimple?: CompleteSimpleFn;
}

export async function executeConsult(opts: ExecuteConsultOptions): Promise<AgentToolResult<ConsultDetails>> {
	const why = opts.why.trim();
	const fail = (
		activeTrigger: ConsultTrigger,
		summary: string,
		error = summary,
		models: string[] = [],
		outcome: Exclude<ConsultOutcome, "completed"> = "blocked",
	) =>
		buildConsultToolResult({
			envelope: errorEnvelope(summary, error),
			trigger: activeTrigger,
			models,
			outcome,
		});

	if (!why) return fail(opts.tracker.pendingTrigger ?? "pull", ERR_EMPTY_WHY);
	const trigger: ConsultTrigger = opts.tracker.consumeTrigger();

	const budgetError = budgetBlockReason(opts.config.budget, opts.tracker.runCount, opts.tracker.sessionCount);
	if (budgetError) return fail(trigger, budgetError);

	const selected = selectPanel(opts.config.panel, { fanout: opts.config.fanout, trigger });
	if (selected.length === 0) return fail(trigger, ERR_NO_PANEL, ERR_NO_PANEL_DETAIL);

	const members = resolvePanelMembers(selected, (provider, modelId) => opts.ctx.modelRegistry.find(provider, modelId));
	if (members.length === 0) {
		return fail(trigger, ERR_NO_MODEL, ERR_NO_MODEL_DETAIL, selected.map((member) => member.model));
	}

	const runtimeCompleteSimple = getRuntimeCompleteSimple(opts.ctx.modelRegistry);
	let completeSimple = opts.completeSimple ?? runtimeCompleteSimple;
	if (!completeSimple) {
		try {
			completeSimple = await loadCompleteSimple();
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			return fail(trigger, errCallThrew(message), message, members.map((member) => member.label), "failed");
		}
	}

	const authByLabel = new Map<
		string,
		Awaited<ReturnType<typeof opts.ctx.modelRegistry.getApiKeyAndHeaders>>
	>();
	for (const member of members) {
		const auth = await opts.ctx.modelRegistry.getApiKeyAndHeaders(member.model);
		authByLabel.set(member.label, auth);
		if (!auth.ok) {
			return fail(trigger, errMisconfigured(member.label, auth.error), auth.error, members.map((item) => item.label));
		}
		if (!auth.apiKey && !runtimeCompleteSimple && !opts.completeSimple) {
			return fail(trigger, errNoApiKey(member.label), errNoApiKeyDetail(member.model.provider), members.map((item) => item.label));
		}
	}

	const { messages: sessionMessages } = buildSessionContext(
		opts.ctx.sessionManager.getEntries(),
		opts.ctx.sessionManager.getLeafId(),
	);
	const branchMessages = prepareConsultMessages(convertToLlm(sessionMessages), why, opts.toolCallId);
	const inventoryMessage = getInventoryMessage(opts.pi.getAllTools());
	const messages: Message[] = inventoryMessage ? [inventoryMessage, ...branchMessages] : branchMessages;

	// Authentication can yield while another consult reserves the same budget.
	// Re-check and increment synchronously immediately before the paid request.
	const reservationError = budgetBlockReason(opts.config.budget, opts.tracker.runCount, opts.tracker.sessionCount);
	if (reservationError) return fail(trigger, reservationError);
	opts.tracker.recordConsult();

	const models = members.map((member) => member.label);
	const effort = members[0]?.effort;
	opts.onUpdate?.({
		content: [{ type: "text", text: msgConsulting(models.join(" + "), effort) }],
		details: {
			trigger,
			models,
			...(effort ? { effort } : {}),
		},
	});

	const outcomes = await runConsultPanel({
		members,
		messages,
		completeSimple: completeSimple as CompleteSimpleFn,
		signal: opts.signal,
		useRuntimeFacade: Boolean(runtimeCompleteSimple) && !opts.completeSimple,
		authFor: async (member) =>
			authByLabel.get(member.label) ?? { ok: false, error: `missing cached auth for ${member.label}` },
	});

	const envelope = mergeAdvisorOutcomes(outcomes);
	const outcome: ConsultOutcome = !envelope.error
		? "completed"
		: opts.signal?.aborted || (outcomes.length > 0 && outcomes.every((item) => !item.ok && item.error === ERR_CALL_ABORTED))
			? "cancelled"
			: "failed";

	const usage = sumUsage(envelope.raw);
	try {
		await appendConsultEvent(
			{
				ts: new Date().toISOString(),
				session: sessionIdFrom(opts.ctx.sessionManager.getSessionFile?.()),
				trigger,
				why,
				models,
				verdict: envelope.error ? "error" : envelope.verdict,
				adopted: null,
				tokensIn: usage?.input ?? 0,
				tokensOut: usage?.output ?? 0,
				cacheRead: usage?.cacheRead ?? 0,
				cacheWrite: usage?.cacheWrite ?? 0,
				costUsd: usage?.cost.total ?? 0,
			},
			opts.agentDir,
		);
	} catch {
		// Logging must not smash the session; the tool result still returns.
	}

	return buildConsultToolResult({ envelope, trigger, models, outcome, effort: members[0]?.effort, usage });
}
