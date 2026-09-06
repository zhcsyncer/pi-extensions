/**
 * Adapted from MIT-licensed @juicesharp/rpiv-advisor 2.8.0
 * (https://github.com/juicesharp/rpiv-mono/tree/main/packages/rpiv-advisor).
 * Copyright (c) 2026 juicesharp.
 *
 * Side-call path: buildSessionContext → convertToLlm → tail massage →
 * inventory prefix → streamSimple({ tools: [] }). Failures all funnel through
 * the single envelope constructor.
 */

import type {
	AssistantMessage,
	AssistantMessageEvent,
	AssistantMessageEventStream,
	Message,
	TextContent,
	ThinkingLevel,
} from "@earendil-works/pi-ai";
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
import { getRuntimeStreamSimple, loadStreamSimple } from "./pi-compat.ts";
import { CONSULT_SYSTEM_PROMPT } from "./prompt.ts";
import type { ConsultTracker } from "./tracker.ts";
import type {
	ConsultConfig,
	ConsultDetails,
	ConsultEvent,
	ConsultLiveMember,
	ConsultLivePhase,
	ConsultOutcome,
	ConsultTrigger,
	UsageSnapshot,
} from "./types.ts";

export type StreamSimpleFn = (
	model: ResolvedPanelMember["model"],
	context: { systemPrompt: string; messages: Message[]; tools: [] },
	options: { signal?: AbortSignal; reasoning?: ThinkingLevel; apiKey?: string; headers?: unknown },
) => AssistantMessageEventStream;

function advisorTextFromResponse(response: AssistantMessage): string {
	return response.content
		.filter((part): part is TextContent => part.type === "text")
		.map((part) => part.text)
		.join("\n")
		.trim();
}

interface MemberProgress {
	phase: ConsultLivePhase;
	approxOutputTokens: number;
	attempt: number;
}

export function estimateOutputTokens(value: string): number {
	let ascii = 0;
	let nonAscii = 0;
	for (const char of value) {
		if (char.codePointAt(0)! <= 0x7f) ascii += 1;
		else nonAscii += 1;
	}
	return Math.ceil(ascii / 4 + nonAscii);
}

function partialOutputUsage(event: AssistantMessageEvent): number {
	return "partial" in event && Number.isFinite(event.partial.usage.output) ? event.partial.usage.output : 0;
}

async function callAdvisorMember(opts: {
	member: ResolvedPanelMember;
	messages: Message[];
	streamSimple: StreamSimpleFn;
	signal?: AbortSignal;
	apiKey?: string;
	headers?: unknown;
	useRuntimeFacade: boolean;
	onProgress?: (label: string, progress: MemberProgress) => void;
}): Promise<AdvisorOutcome> {
	const requestOptions = opts.useRuntimeFacade
		? { signal: opts.signal, reasoning: opts.member.effort }
		: { apiKey: opts.apiKey, headers: opts.headers, signal: opts.signal, reasoning: opts.member.effort };

	const startedAt = Date.now();
	let accumulatedUsage: ReturnType<typeof usageSnapshotFrom>;
	let accumulatedApprox = 0;
	let attempt = 0;
	const metadata = () => ({
		...(opts.member.effort ? { effort: opts.member.effort } : {}),
		durationMs: Date.now() - startedAt,
		attempts: attempt,
	});
	const call = async (): Promise<AssistantMessage> => {
		attempt += 1;
		let phase: ConsultLivePhase = "connecting";
		let currentApprox = 0;
		let thinking = "";
		let text = "";
		let sawThinkingDelta = false;
		let sawTextDelta = false;
		let final: AssistantMessage | undefined;
		let lastPhase: ConsultLivePhase | undefined;
		let lastApprox = -1;
		let lastUpdateAt = 0;
		const report = (nextPhase: ConsultLivePhase, approxOutputTokens: number, force = false): void => {
			const now = Date.now();
			if (!force && nextPhase === lastPhase && (approxOutputTokens === lastApprox || now - lastUpdateAt < 500)) return;
			lastPhase = nextPhase;
			lastApprox = approxOutputTokens;
			lastUpdateAt = now;
			try {
				opts.onProgress?.(opts.member.label, { phase: nextPhase, approxOutputTokens, attempt });
			} catch {
				// Progress rendering is best effort and must not fail the advisor request.
			}
		};

		report(phase, accumulatedApprox, true);
		const stream = opts.streamSimple(
			opts.member.model,
			{ systemPrompt: CONSULT_SYSTEM_PROMPT, messages: opts.messages, tools: [] },
			requestOptions,
		);
		const phaseRank: Record<ConsultLivePhase, number> = { connecting: 0, thinking: 1, writing: 2 };
		const advance = (next: ConsultLivePhase): void => {
			if (phaseRank[next] >= phaseRank[phase]) phase = next;
		};
		for await (const event of stream) {
			switch (event.type) {
				case "start":
					advance("thinking");
					break;
				case "thinking_start":
					advance("thinking");
					break;
				case "thinking_delta":
					advance("thinking");
					thinking += event.delta;
					sawThinkingDelta = true;
					break;
				case "thinking_end":
					advance("thinking");
					if (!sawThinkingDelta) thinking = event.content;
					break;
				case "text_start":
					advance("writing");
					break;
				case "text_delta":
					advance("writing");
					text += event.delta;
					sawTextDelta = true;
					break;
				case "text_end":
					advance("writing");
					if (!sawTextDelta) text = event.content;
					break;
				case "done":
					final = event.message;
					continue;
				case "error":
					final = event.error;
					continue;
			}
			const estimated = estimateOutputTokens(thinking + text);
			currentApprox = Math.max(currentApprox, estimated, partialOutputUsage(event));
			report(phase, accumulatedApprox + currentApprox);
		}
		const response = final ?? (await stream.result());
		accumulatedApprox += Math.max(currentApprox, response.usage.output);
		accumulatedUsage = addUsage(accumulatedUsage, usageSnapshotFrom(response.usage));
		return response;
	};

	try {
		let response = await call();
		if (response.stopReason === "aborted") {
			return { ok: false, label: opts.member.label, error: ERR_CALL_ABORTED, usage: accumulatedUsage, ...metadata() };
		}
		if (response.stopReason === "error") {
			return {
				ok: false,
				label: opts.member.label,
				error: errCallFailed(response.errorMessage),
				usage: accumulatedUsage,
				...metadata(),
			};
		}
		let responseText = advisorTextFromResponse(response);
		if (!responseText) {
			response = await call();
			if (response.stopReason === "aborted") {
				return { ok: false, label: opts.member.label, error: ERR_CALL_ABORTED, usage: accumulatedUsage, ...metadata() };
			}
			if (response.stopReason === "error") {
				return {
					ok: false,
					label: opts.member.label,
					error: errCallFailed(response.errorMessage),
					usage: accumulatedUsage,
					...metadata(),
				};
			}
			responseText = advisorTextFromResponse(response);
			if (!responseText) {
				return { ok: false, label: opts.member.label, error: ERR_EMPTY_RESPONSE, usage: accumulatedUsage, ...metadata() };
			}
		}
		return { ok: true, label: opts.member.label, text: responseText, usage: accumulatedUsage, ...metadata() };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			ok: false,
			label: opts.member.label,
			error: errCallThrew(message),
			...(accumulatedUsage ? { usage: accumulatedUsage } : {}),
			...metadata(),
		};
	}
}

export async function runConsultPanel(opts: {
	members: ResolvedPanelMember[];
	messages: Message[];
	streamSimple: StreamSimpleFn;
	signal?: AbortSignal;
	onProgress?: (label: string, progress: MemberProgress) => void;
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
					...(member.effort ? { effort: member.effort } : {}),
					durationMs: 0,
					attempts: 0,
				};
			}
			if (!auth.apiKey && !opts.useRuntimeFacade) {
				return {
					ok: false,
					label: member.label,
					error: errNoApiKey(member.label),
					...(member.effort ? { effort: member.effort } : {}),
					durationMs: 0,
					attempts: 0,
				};
			}
			return callAdvisorMember({
				member,
				messages: opts.messages,
				streamSimple: opts.streamSimple,
				signal: opts.signal,
				apiKey: auth.apiKey,
				headers: auth.headers,
				useRuntimeFacade: opts.useRuntimeFacade,
				onProgress: opts.onProgress,
			});
		}
		return callAdvisorMember({
			member,
			messages: opts.messages,
			streamSimple: opts.streamSimple,
			signal: opts.signal,
			useRuntimeFacade: opts.useRuntimeFacade,
			onProgress: opts.onProgress,
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
	toolCallId: string;
	ctx: ExtensionContext;
	pi: ExtensionAPI;
	config: ConsultConfig;
	tracker: ConsultTracker;
	agentDir?: string;
	signal?: AbortSignal;
	onUpdate?: AgentToolUpdateCallback<ConsultDetails>;
	streamSimple?: StreamSimpleFn;
}

export async function executeConsult(opts: ExecuteConsultOptions): Promise<AgentToolResult<ConsultDetails>> {
	const why = opts.why.trim();
	const session = sessionIdFrom(opts.ctx.sessionManager.getSessionFile?.());
	const recordEvent = async (
		trigger: ConsultTrigger,
		models: string[],
		outcome: ConsultOutcome,
		verdict: ConsultEvent["verdict"],
		usage?: UsageSnapshot,
	): Promise<void> => {
		try {
			await appendConsultEvent(
				{
					ts: new Date().toISOString(),
					session,
					toolCallId: opts.toolCallId,
					trigger,
					why,
					models,
					outcome,
					verdict,
					adopted: null,
					adoptionEffect: null,
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
	};
	const fail = async (
		activeTrigger: ConsultTrigger,
		summary: string,
		error = summary,
		models: string[] = [],
		outcome: Exclude<ConsultOutcome, "completed"> = "blocked",
	): Promise<AgentToolResult<ConsultDetails>> => {
		const envelope = errorEnvelope(summary, error);
		await recordEvent(activeTrigger, models, outcome, "error");
		return buildConsultToolResult({ envelope, trigger: activeTrigger, models, outcome });
	};

	if (!why) return fail(opts.tracker.pendingTrigger ?? "onDemand", ERR_EMPTY_WHY);
	const trigger: ConsultTrigger = opts.tracker.consumeTrigger();

	const budgetError = budgetBlockReason(opts.config.budget, opts.tracker.runCount, opts.tracker.sessionCount);
	if (budgetError) return fail(trigger, budgetError);

	const selected = selectPanel(opts.config.panel, { fanout: opts.config.fanout, trigger });
	if (selected.length === 0) return fail(trigger, ERR_NO_PANEL, ERR_NO_PANEL_DETAIL);

	const members = resolvePanelMembers(selected, (provider, modelId) => opts.ctx.modelRegistry.find(provider, modelId));
	if (members.length === 0) {
		return fail(trigger, ERR_NO_MODEL, ERR_NO_MODEL_DETAIL, selected.map((member) => member.model));
	}

	const runtimeStreamSimple = getRuntimeStreamSimple(opts.ctx.modelRegistry);
	let streamSimple = opts.streamSimple ?? runtimeStreamSimple;
	if (!streamSimple) {
		try {
			streamSimple = await loadStreamSimple();
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
		if (!auth.apiKey && !runtimeStreamSimple && !opts.streamSimple) {
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
	const live = new Map<string, ConsultLiveMember>(
		members.map((member) => [
			member.label,
			{
				model: member.label,
				...(member.effort ? { effort: member.effort } : {}),
				phase: "connecting",
				approxOutputTokens: 0,
				attempt: 1,
			},
		]),
	);
	const publishProgress = (): void => {
		try {
			opts.onUpdate?.({
				content: [{ type: "text", text: msgConsulting(models.join(" + "), undefined) }],
				details: {
					trigger,
					models,
					live: models.flatMap((model) => {
						const progress = live.get(model);
						return progress ? [progress] : [];
					}),
				},
			});
		} catch {
			// Streaming UI updates are best effort and must not fail Consult.
		}
	};
	publishProgress();

	const outcomes = await runConsultPanel({
		members,
		messages,
		streamSimple: streamSimple as StreamSimpleFn,
		signal: opts.signal,
		useRuntimeFacade: Boolean(runtimeStreamSimple) && !opts.streamSimple,
		onProgress: (model, progress) => {
			const previous = live.get(model);
			if (
				previous?.phase === progress.phase &&
				previous.approxOutputTokens === progress.approxOutputTokens &&
				(previous.attempt ?? 1) === progress.attempt
			) {
				return;
			}
			live.set(model, { model, ...(previous?.effort ? { effort: previous.effort } : {}), ...progress });
			publishProgress();
		},
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
	await recordEvent(trigger, models, outcome, envelope.error ? "error" : envelope.verdict, usage);

	return buildConsultToolResult({ envelope, trigger, models, outcome, usage });
}
