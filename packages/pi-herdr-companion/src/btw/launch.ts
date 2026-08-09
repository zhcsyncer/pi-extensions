import type { HerdrClient } from "../herdr-client.ts";
import { HerdrCommandError, isMissingPaneError } from "../herdr-client.ts";
import type { RuntimeSnapshot } from "../runtime.ts";
import type { BtwContextStore, PaneLiveness } from "./context-store.ts";
import type { LaunchState } from "./protocol.ts";
import { BTW_PAYLOAD_ENV, buildChildPiArgs, type BtwPayload } from "./types.ts";

export type BtwLaunchClient = Pick<
	HerdrClient,
	"splitPane" | "closePane" | "startAgent" | "getPane" | "getAgent"
>;
export type BtwLaunchStore = Pick<BtwContextStore, "writeLaunchState" | "readLaunchState" | "remove">;

export interface LaunchBtwOptions {
	payload: BtwPayload;
	payloadPath: string;
	runtime: RuntimeSnapshot;
	signal?: AbortSignal;
}

export interface LaunchBtwResult {
	paneId: string;
	agentName: string;
}

function sideAgentName(payload: BtwPayload): string {
	return `btw-${payload.parentSessionId.slice(0, 6).toLowerCase()}-${payload.launchId.slice(0, 6).toLowerCase()}`
		.replace(/[^a-z0-9_-]/g, "-")
		.slice(0, 32);
}

export class BtwLauncher {
	constructor(
		private readonly client: BtwLaunchClient,
		private readonly store: BtwLaunchStore,
		private readonly now: () => Date = () => new Date(),
	) {}

	async launch(options: LaunchBtwOptions): Promise<LaunchBtwResult> {
		const { payload, payloadPath, runtime, signal } = options;
		let paneId: string | undefined;
		let unidentifiedSplitFailure = false;
		const agentName = sideAgentName(payload);
		try {
			try {
				const pane = await this.client.splitPane({
					target: "current",
					direction: payload.config.split,
					cwd: payload.metadata.cwd,
					focus: true,
					environment: { [BTW_PAYLOAD_ENV]: payloadPath },
				}, signal);
				paneId = pane.paneId;
			} catch (error) {
				// A failure response may still carry the explicit split result. Never
				// infer ownership from cwd/tab/list deltas: another pane may be unrelated.
				paneId = error instanceof HerdrCommandError ? error.paneId : undefined;
				unidentifiedSplitFailure = !paneId;
				throw error;
			}

			if (!paneId || paneId === runtime.paneId) throw new Error("Refusing invalid /btw side pane identity");
			await this.store.writeLaunchState(
				payloadPath,
				this.launchState(payload, "pane_created", { paneId, agentName }),
			);
			const model = payload.config.model === "inherit" ? payload.metadata.model : payload.config.model;
			const thinking = payload.config.thinking === "inherit" ? payload.parentThinkingLevel : payload.config.thinking;
			await this.client.startAgent({
				name: agentName,
				kind: "pi",
				paneId,
				args: buildChildPiArgs(payload, model, thinking),
				timeoutMs: 40_000,
			}, signal);
			// The child may bind its first Pi session while agent start is waiting.
			// Preserve that binding rather than overwriting it with a stale snapshot.
			const current = await this.store.readLaunchState(payloadPath).catch(() => undefined);
			await this.store.writeLaunchState(payloadPath, {
				...this.launchState(payload, "child_ready", { paneId, agentName }),
				...(current?.launchId === payload.launchId && current.childSessionId
					? { childSessionId: current.childSessionId }
					: {}),
			});
			return { paneId, agentName };
		} catch (error) {
			if (paneId && paneId !== runtime.paneId) await this.client.closePane(paneId).catch(() => undefined);
			await this.store.remove(payloadPath).catch(() => undefined);
			if (unidentifiedSplitFailure) {
				const message = error instanceof Error ? error.message : String(error);
				throw new Error(`${message}. The split response had no pane ID; a possible orphan pane was left untouched.`);
			}
			throw error;
		}
	}

	/** Resolve the named child first so a pane move cannot make an old ID look stale. */
	async isPaneLive(_paneId: string, agentName?: string): Promise<PaneLiveness> {
		if (!agentName) return "unknown";
		let currentPaneId: string;
		try {
			currentPaneId = (await this.client.getAgent(agentName)).paneId;
		} catch {
			return "unknown";
		}
		if (!currentPaneId) return "unknown";
		try {
			await this.client.getPane(currentPaneId);
			return true;
		} catch (error) {
			return isMissingPaneError(error) ? false : "unknown";
		}
	}

	private launchState(
		payload: BtwPayload,
		status: LaunchState["status"],
		identity: Pick<LaunchState, "paneId" | "agentName"> = {},
	): LaunchState {
		return {
			version: 1,
			launchId: payload.launchId,
			status,
			...identity,
			updatedAt: this.now().toISOString(),
		};
	}
}
