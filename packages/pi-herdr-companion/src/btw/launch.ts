import type { HerdrClient, HerdrPane } from "../herdr-client.ts";
import { HerdrCommandError, isMissingPaneError } from "../herdr-client.ts";
import type { RuntimeSnapshot } from "../runtime.ts";
import type { BtwContextStore, PaneLiveness } from "./context-store.ts";
import type { LaunchState } from "./protocol.ts";
import { BTW_PAYLOAD_ENV, buildChildPiArgs, type BtwPayload } from "./types.ts";

export type BtwLaunchClient = Pick<HerdrClient, "splitPane" | "listPanes" | "closePane" | "startAgent" | "getPane">;
export type BtwLaunchStore = Pick<BtwContextStore, "writeLaunchState" | "remove">;

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

function paneIdFromSplitJson(stdout: string): string | undefined {
	try {
		const value = JSON.parse(stdout) as { result?: { pane?: { pane_id?: unknown } } };
		return typeof value.result?.pane?.pane_id === "string" ? value.result.pane.pane_id : undefined;
	} catch {
		return undefined;
	}
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
		let before: HerdrPane[] | undefined;
		try {
			before = await this.client.listPanes(signal).catch(() => undefined);
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
				paneId = error instanceof HerdrCommandError ? paneIdFromSplitJson(error.stdout) : undefined;
				paneId ??= await this.findUnambiguousNewPane(before, payload.metadata.cwd, runtime);
				throw error;
			}

			if (!paneId || paneId === runtime.paneId) throw new Error("Refusing invalid /btw side pane identity");
			await this.store.writeLaunchState(payloadPath, this.launchState(payload, "pane_created", paneId));
			const agentName = sideAgentName(payload);
			const model = payload.config.model === "inherit" ? payload.metadata.model : payload.config.model;
			const thinking = payload.config.thinking === "inherit" ? payload.parentThinkingLevel : payload.config.thinking;
			await this.client.startAgent({
				name: agentName,
				kind: "pi",
				paneId,
				args: buildChildPiArgs(payload, model, thinking),
				timeoutMs: 40_000,
			}, signal);
			await this.store.writeLaunchState(payloadPath, this.launchState(payload, "child_ready", paneId));
			return { paneId, agentName };
		} catch (error) {
			if (paneId && paneId !== runtime.paneId) await this.client.closePane(paneId).catch(() => undefined);
			await this.store.remove(payloadPath).catch(() => undefined);
			throw error;
		}
	}

	async isPaneLive(paneId: string): Promise<PaneLiveness> {
		try {
			await this.client.getPane(paneId);
			return true;
		} catch (error) {
			return isMissingPaneError(error) ? false : "unknown";
		}
	}

	private launchState(payload: BtwPayload, status: LaunchState["status"], paneId?: string): LaunchState {
		return {
			version: 1,
			launchId: payload.launchId,
			status,
			...(paneId ? { paneId } : {}),
			updatedAt: this.now().toISOString(),
		};
	}

	private async findUnambiguousNewPane(
		before: HerdrPane[] | undefined,
		cwd: string,
		runtime: RuntimeSnapshot,
	): Promise<string | undefined> {
		if (!before) return undefined;
		const previous = new Set(before.map((pane) => pane.paneId));
		const candidates = (await this.client.listPanes().catch(() => []))
			.filter((pane) => !previous.has(pane.paneId))
			.filter((pane) => pane.paneId !== runtime.paneId && pane.cwd === cwd)
			.filter((pane) => !runtime.tabId || pane.tabId === runtime.tabId);
		return candidates.length === 1 ? candidates[0]?.paneId : undefined;
	}
}
