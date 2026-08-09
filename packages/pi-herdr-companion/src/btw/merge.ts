import { randomUUID } from "node:crypto";
import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import type { BtwContextStore } from "./context-store.ts";
import {
	MERGE_MESSAGE_CUSTOM_TYPE,
	MERGE_PROTOCOL_VERSION,
	ackMatchesRequest,
	buildMergeMessageContent,
	isMergeRequest,
	validateRequestAgainstPayload,
	type MergeAck,
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
	dispatchMergeMessage(content: string, details: { requestId: string; launchId: string }): void;
	notify(message: string, type: "info" | "warning" | "error"): void;
}

export interface MergeScanResult {
	delivered: number;
	deferred: number;
	rejected: number;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requestIdOf(value: unknown): string {
	return isRecord(value) && typeof value.requestId === "string" && value.requestId ? value.requestId : "unknown";
}

function findMergeEvidence(
	entries: readonly SessionEntry[],
	requestId: string,
): Extract<SessionEntry, { type: "custom_message" }> | undefined {
	return entries.find((entry): entry is Extract<SessionEntry, { type: "custom_message" }> =>
		entry.type === "custom_message" &&
		entry.customType === MERGE_MESSAGE_CUSTOM_TYPE &&
		isRecord(entry.details) && entry.details.requestId === requestId);
}

/**
 * Single-owner recovery coordinator.
 *
 * Pi 0.84's ExtensionAPI sendMessage is fire-and-forget. A dispatch call is
 * therefore never treated as delivery evidence: only the request-tagged custom
 * message observed in the parent session can advance to acknowledgement.
 */
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
				await this.writeMailboxState(path, rawRequest, "acked").catch(() => undefined);
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

		const evidence = findMergeEvidence(this.session.getEntries(), rawRequest.requestId);
		if (evidence) {
			await this.writeMailboxState(path, rawRequest, "evidence_observed");
			await this.accept(path, rawRequest);
			result.delivered += 1;
			return;
		}

		const state = await this.store.readMergeState(path).catch(() => undefined);
		if (state?.requestId === rawRequest.requestId && state.dispatch) {
			const started = Date.parse(state.dispatch.startedAt);
			if (Number.isFinite(started) && this.now().getTime() - started < this.dispatchLeaseMs) {
				result.deferred += 1;
				return;
			}
		}
		if (!this.session.isIdle()) {
			result.deferred += 1;
			return;
		}

		const startedAt = this.now().toISOString();
		await this.store.writeMergeState(path, {
			protocolVersion: MERGE_PROTOCOL_VERSION,
			requestId: rawRequest.requestId,
			phase: "dispatched",
			updatedAt: startedAt,
			dispatch: { id: randomUUID(), startedAt },
		});
		try {
			this.session.dispatchMergeMessage(
				buildMergeMessageContent(rawRequest.summary, rawRequest.prompt),
				{ requestId: rawRequest.requestId, launchId: rawRequest.launchId },
			);
		} catch (error) {
			// This catches only a synchronous wrapper failure. It does not prove that
			// an otherwise successful call reached the session; the lease still gates recovery.
			this.session.notify(
				`Could not queue a /btw merge yet; recovery will retry after its lease: ${error instanceof Error ? error.message : String(error)}`,
				"warning",
			);
		}
		result.deferred += 1;
	}

	private async writeMailboxState(
		path: string,
		request: MergeRequest,
		phase: MergeState["phase"],
	): Promise<void> {
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
		// Evidence is already in the session. Persist final mailbox state before
		// exposing the acknowledgement, because the child may close immediately.
		await this.writeMailboxState(path, request, "acked");
		await this.store.writeMergeAck(path, ack);
		this.session.notify("Merged a /btw side thread and started its parent follow-up turn.", "info");
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
