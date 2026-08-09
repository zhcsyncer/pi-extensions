import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BtwContextStore } from "./context-store.ts";
import {
	MERGE_MESSAGE_CUSTOM_TYPE,
	MERGE_PHASE_CUSTOM_TYPE,
	MERGE_PROTOCOL_VERSION,
	ackMatchesRequest,
	buildMergeMessageContent,
	isMergeRequest,
	isMergeState,
	textOfUserMessage,
	validateRequestAgainstPayload,
	type MergeAck,
	type MergePhase,
	type MergeRequest,
	type MergeState,
} from "./protocol.ts";
import type { BtwPayload } from "./types.ts";

export type MergeStorePort = Pick<
	BtwContextStore,
	| "listLaunchPayloadPaths"
	| "read"
	| "readMergeRequest"
	| "readMergeState"
	| "writeMergeState"
	| "readMergeAck"
	| "writeMergeAck"
	| "withDeliveryLock"
>;

export interface ParentMergePort {
	getSessionId(): string;
	isIdle(): boolean;
	getEntries(): SessionEntry[];
	appendMergeMessage(content: string, details: { requestId: string; launchId: string }): void;
	submitPrompt(prompt: string): void;
	persistPhase(data: { requestId: string; launchId: string; phase: MergePhase; prompt: string; updatedAt: string }): void;
	notify(message: string, type: "info" | "warning" | "error"): void;
}

export interface MergeScanResult {
	delivered: number;
	deferred: number;
	rejected: number;
}

const PHASE_RANK: Record<MergePhase, number> = {
	message_appended: 1,
	prompt_submitted: 2,
	acked: 3,
};

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestIdOf(value: unknown): string {
	return isRecord(value) && typeof value.requestId === "string" && value.requestId ? value.requestId : "unknown";
}

function findMergeMessage(entries: readonly SessionEntry[], requestId: string): Extract<SessionEntry, { type: "custom_message" }> | undefined {
	return entries.find((entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
		entry.type === "custom_message" &&
		entry.customType === MERGE_MESSAGE_CUSTOM_TYPE &&
		isRecord(entry.details) && entry.details.requestId === requestId);
}

function findPersistedPhase(entries: readonly SessionEntry[], requestId: string): MergePhase | undefined {
	let phase: MergePhase | undefined;
	for (const entry of entries) {
		if (entry.type !== "custom" || entry.customType !== MERGE_PHASE_CUSTOM_TYPE || !isRecord(entry.data)) continue;
		if (entry.data.requestId !== requestId) continue;
		const candidate = entry.data.phase;
		if (candidate !== "message_appended" && candidate !== "prompt_submitted" && candidate !== "acked") continue;
		if (!phase || PHASE_RANK[candidate] > PHASE_RANK[phase]) phase = candidate;
	}
	return phase;
}

function hasSubmittedPrompt(
	entries: readonly SessionEntry[],
	mergeEntryId: string,
	prompt: string,
): boolean {
	const byId = new Map(entries.map((entry) => [entry.id, entry]));
	for (const entry of entries) {
		if (entry.type !== "message" || textOfUserMessage(entry.message) !== prompt.trim()) continue;
		let parentId = entry.parentId;
		const visited = new Set<string>();
		while (parentId && !visited.has(parentId)) {
			if (parentId === mergeEntryId) return true;
			visited.add(parentId);
			parentId = byId.get(parentId)?.parentId ?? null;
		}
	}
	return false;
}

function maxPhase(...phases: Array<MergePhase | undefined>): MergePhase | undefined {
	return phases.reduce<MergePhase | undefined>((latest, phase) =>
		phase && (!latest || PHASE_RANK[phase] > PHASE_RANK[latest]) ? phase : latest, undefined);
}

export class MergeCoordinator {
	private scanning = false;

	constructor(
		private readonly store: MergeStorePort,
		private readonly session: ParentMergePort,
		private readonly now: () => Date = () => new Date(),
		private readonly dispatchLeaseMs = 10 * 60 * 1_000,
	) {}

	async scan(): Promise<MergeScanResult> {
		if (this.scanning) return { delivered: 0, deferred: 0, rejected: 0 };
		this.scanning = true;
		try {
			const result: MergeScanResult = { delivered: 0, deferred: 0, rejected: 0 };
			let paths: string[];
			try {
				paths = await this.store.listLaunchPayloadPaths();
			} catch {
				return result;
			}
			for (const path of paths) {
				try {
					await this.store.withDeliveryLock(path, () => this.processLaunch(path, result));
				} catch {
					// Corrupt, foreign, locked, or concurrently removed launches are skipped safely.
				}
			}
			return result;
		} finally {
			this.scanning = false;
		}
	}

	private async processLaunch(path: string, result: MergeScanResult): Promise<void> {
		const rawRequest = await this.store.readMergeRequest(path);
		if (rawRequest === undefined) return;
		const payload = await this.store.read(path);
		if (payload.parentSessionId !== this.session.getSessionId()) return;

		const ack = await this.store.readMergeAck(path).catch(() => undefined);
		if (ackMatchesRequest(ack, rawRequest)) {
			if (ack?.status === "accepted" && isMergeRequest(rawRequest)) {
				await this.writeMailboxPhase(path, rawRequest, "acked").catch(() => undefined);
			}
			return;
		}

		if (!isMergeRequest(rawRequest)) {
			await this.reject(path, rawRequest, "malformed merge request");
			result.rejected += 1;
			return;
		}
		const validation = validateRequestAgainstPayload(rawRequest, payload);
		if (validation) {
			await this.reject(path, rawRequest, validation);
			result.rejected += 1;
			return;
		}

		const entries = this.session.getEntries();
		const mergeMessage = findMergeMessage(entries, rawRequest.requestId);
		const promptSubmitted = mergeMessage
			? hasSubmittedPrompt(entries, mergeMessage.id, rawRequest.prompt)
			: false;
		const mailbox = await this.store.readMergeState(path).catch(() => undefined);
		const mailboxPhase = mailbox?.requestId === rawRequest.requestId ? mailbox.phase : undefined;
		let phase = maxPhase(
			mailboxPhase,
			findPersistedPhase(entries, rawRequest.requestId),
			mergeMessage ? "message_appended" : undefined,
			promptSubmitted ? "prompt_submitted" : undefined,
		);

		if (mergeMessage && (!phase || PHASE_RANK[phase] < PHASE_RANK.message_appended)) {
			phase = "message_appended";
		}
		if (promptSubmitted) phase = "prompt_submitted";

		if (phase === "prompt_submitted" || phase === "acked") {
			// Persist the observed user-message boundary before acknowledging it.
			// A crash after this point recovers without resubmitting the prompt.
			await this.persistPhase(path, rawRequest, "prompt_submitted");
			await this.accept(path, rawRequest);
			result.delivered += 1;
			return;
		}

		if (!mergeMessage) {
			if (!this.session.isIdle()) {
				result.deferred += 1;
				return;
			}
			this.session.appendMergeMessage(buildMergeMessageContent(rawRequest.summary), {
				requestId: rawRequest.requestId,
				launchId: rawRequest.launchId,
			});
			await this.persistPhase(path, rawRequest, "message_appended");
			phase = "message_appended";
		}

		const currentState = await this.store.readMergeState(path).catch(() => undefined);
		if (currentState?.requestId === rawRequest.requestId && currentState.dispatch) {
			const started = Date.parse(currentState.dispatch.startedAt);
			if (Number.isFinite(started) && this.now().getTime() - started < this.dispatchLeaseMs) {
				result.deferred += 1;
				return;
			}
		}

		if (!this.session.isIdle()) {
			result.deferred += 1;
			return;
		}

		const dispatch: MergeState = {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: rawRequest.requestId,
			phase: "message_appended",
			updatedAt: this.now().toISOString(),
			dispatch: { id: randomUUID(), startedAt: this.now().toISOString() },
		};
		await this.store.writeMergeState(path, dispatch);
		try {
			this.session.submitPrompt(rawRequest.prompt.trim());
		} catch (error) {
			await this.writeMailboxPhase(path, rawRequest, "message_appended");
			this.session.notify(`Could not submit a /btw follow-up yet: ${error instanceof Error ? error.message : String(error)}`, "warning");
		}
		// Ack only after a later scan observes the durable user-message entry.
		result.deferred += 1;
	}

	private async persistPhase(path: string, request: MergeRequest, phase: MergePhase): Promise<void> {
		const updatedAt = this.now().toISOString();
		this.session.persistPhase({
			requestId: request.requestId,
			launchId: request.launchId,
			phase,
			prompt: request.prompt,
			updatedAt,
		});
		await this.store.writeMergeState(path, {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: request.requestId,
			phase,
			updatedAt,
		});
	}

	private async writeMailboxPhase(path: string, request: MergeRequest, phase: MergePhase): Promise<void> {
		await this.store.writeMergeState(path, {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: request.requestId,
			phase,
			updatedAt: this.now().toISOString(),
		});
	}

	private async accept(path: string, request: MergeRequest): Promise<void> {
		const ack: MergeAck = {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: request.requestId,
			status: "accepted",
			processedAt: this.now().toISOString(),
		};
		// Persist the final phase before exposing the acknowledgement to the child;
		// once the ack is visible the child may immediately close and remove launch state.
		await this.persistPhase(path, request, "acked");
		await this.store.writeMergeAck(path, ack);
		this.session.notify("Merged a /btw side thread; continuing with its follow-up prompt.", "info");
	}

	private async reject(path: string, rawRequest: unknown, reason: string): Promise<void> {
		await this.store.writeMergeAck(path, {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: requestIdOf(rawRequest),
			status: "rejected",
			processedAt: this.now().toISOString(),
			reason,
		});
		this.session.notify(`Rejected a /btw merge request: ${reason}`, "warning");
	}
}

export function mergeRequestBelongsToPayload(request: MergeRequest, payload: BtwPayload): boolean {
	return validateRequestAgainstPayload(request, payload) === undefined;
}
