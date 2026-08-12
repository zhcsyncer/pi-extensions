import { createHash } from "node:crypto";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Type, type Static } from "typebox";
import type { HerdrClient } from "./herdr-client.ts";
import type { RuntimeSnapshot } from "./runtime.ts";

export const HERDR_WORKER_TOOL_NAME = "herdr_worker";
export const HERDR_WORKER_REPORT_PREFIX = "[pi-herdr-worker-report:v1]";
export const HERDR_AGENT_NAME_PATTERN = "^[a-z][a-z0-9_-]{0,31}$";

const HERDR_AGENT_NAME_REGEX = /^[a-z][a-z0-9_-]{0,31}$/;
const PARENT_NAME_PREFIX = "pi-parent-";
const PARENT_NAME_HASH_LENGTH = 22;

export const herdrWorkerSchema = Type.Object({
	paneId: Type.String({
		minLength: 1,
		description: "Existing Herdr pane ID whose shell is available for starting a Pi agent.",
	}),
	name: Type.String({
		minLength: 1,
		maxLength: 32,
		pattern: HERDR_AGENT_NAME_PATTERN,
		description: "Unique Herdr Worker name; must match [a-z][a-z0-9_-]{0,31}.",
	}),
	prompt: Type.String({
		minLength: 1,
		description: "Task prompt delivered to the Worker as a normal user prompt.",
	}),
});

export type HerdrWorkerInput = Static<typeof herdrWorkerSchema>;

export interface HerdrWorkerDetails {
	paneId: string;
	workerName: string;
	parentName: string;
}

export type HerdrWorkerClient = Pick<
	HerdrClient,
	"getAgent" | "renameAgent" | "startAgent" | "promptAgent"
>;

export function parentAgentName(sessionId: string): string {
	const hash = createHash("sha256").update(sessionId).digest("hex").slice(0, PARENT_NAME_HASH_LENGTH);
	return `${PARENT_NAME_PREFIX}${hash}`;
}

export function buildWorkerCallbackContract(parentName: string): string {
	return [
		"When this assigned task reaches final success or confirmed failure, report exactly once to the parent with:",
		`herdr agent prompt ${parentName} "${HERDR_WORKER_REPORT_PREFIX} <final outcome>"`,
		"Do not send progress reports. The reserved prefix must be the first text in the report.",
	].join(" ");
}

export function isWorkerReportInput(text: string): boolean {
	return text.startsWith(HERDR_WORKER_REPORT_PREFIX);
}

export function registerHerdrWorkerReportInput(pi: ExtensionAPI): void {
	pi.on("input", (event, ctx) => {
		if (!isWorkerReportInput(event.text)) return { action: "continue" };
		try {
			pi.sendMessage(
				{
					customType: "pi-herdr-worker-report",
					content: event.text,
					display: true,
				},
				{ deliverAs: "followUp", triggerTurn: true },
			);
		} catch {
			// Never let a reserved report fall back to the original streaming mode;
			// that could turn a failed follow-up injection into an accidental steer.
			ctx.ui.notify("Could not queue the Herdr Worker report as a follow-up; the reserved input was suppressed.", "warning");
		}
		return { action: "handled" };
	});
}

export class HerdrWorkerDispatcher {
	private parentName?: string;
	private naming?: Promise<string>;

	constructor(
		private readonly client: HerdrWorkerClient,
		private readonly runtime: RuntimeSnapshot,
	) {}

	async dispatch(input: HerdrWorkerInput, ctx: ExtensionContext, signal?: AbortSignal): Promise<HerdrWorkerDetails> {
		this.assertInput(input);
		const parentName = await this.ensureParentName(ctx.sessionManager.getSessionId(), signal);
		await this.client.startAgent({
			name: input.name,
			kind: "pi",
			paneId: input.paneId,
			args: ["--append-system-prompt", buildWorkerCallbackContract(parentName)],
		}, signal);
		await this.client.promptAgent(input.name, input.prompt, signal);
		return { paneId: input.paneId, workerName: input.name, parentName };
	}

	private assertInput(input: HerdrWorkerInput): void {
		if (!input.paneId.trim()) throw new Error("herdr_worker requires a non-empty paneId");
		if (!HERDR_AGENT_NAME_REGEX.test(input.name)) {
			throw new Error("herdr_worker name must match [a-z][a-z0-9_-]{0,31}");
		}
		if (!input.prompt.trim()) throw new Error("herdr_worker requires a non-empty prompt");
	}

	private async ensureParentName(sessionId: string, signal?: AbortSignal): Promise<string> {
		if (this.parentName) return this.parentName;
		if (this.naming) return this.naming;
		const naming = this.resolveParentName(sessionId, signal);
		this.naming = naming;
		try {
			const resolved = await naming;
			this.parentName = resolved;
			return resolved;
		} finally {
			if (this.naming === naming) this.naming = undefined;
		}
	}

	private async resolveParentName(sessionId: string, signal?: AbortSignal): Promise<string> {
		const paneId = this.runtime.paneId;
		if (!paneId) throw new Error("herdr_worker requires a current Herdr pane identity");
		if (!sessionId.trim()) throw new Error("herdr_worker requires a current Pi session ID");
		const current = await this.client.getAgent(paneId, signal);
		if (current.name) return current.name;
		const generated = parentAgentName(sessionId);
		const renamed = await this.client.renameAgent(paneId, generated, signal);
		if (renamed.name !== generated) {
			throw new Error("Herdr agent rename did not confirm the generated parent name");
		}
		return generated;
	}
}

export function registerHerdrWorkerTool(
	pi: ExtensionAPI,
	dispatcher: HerdrWorkerDispatcher,
): void {
	pi.registerTool({
		name: HERDR_WORKER_TOOL_NAME,
		label: "Herdr Worker",
		description: "Start a Pi Worker in an existing available Herdr pane and asynchronously submit one task. The caller supplies the pane ID and a valid unique Worker name. Completion is reported only by the Worker's explicit reserved final report; Herdr idle/done is not a completion signal. This tool does not create panes or worktrees, wait for completion, restart, or clean up.",
		promptSnippet: "Dispatch one asynchronous Pi Worker into an existing Herdr pane",
		promptGuidelines: [
			"Use herdr_worker only with an existing available Herdr pane ID and a valid unique Worker name.",
			"After herdr_worker returns, treat only a [pi-herdr-worker-report:v1] final report as Worker completion; do not infer completion from Herdr idle or done.",
		],
		parameters: herdrWorkerSchema,
		executionMode: "sequential",
		async execute(_toolCallId, params, signal, _onUpdate, ctx) {
			const details = await dispatcher.dispatch(params, ctx, signal);
			return {
				content: [{
					type: "text",
					text: `Dispatched ${details.workerName} in ${details.paneId}. The Worker will report final success or confirmed failure asynchronously with ${HERDR_WORKER_REPORT_PREFIX}.`,
				}],
				details,
			};
		},
	});
}
