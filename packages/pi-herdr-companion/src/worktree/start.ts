import { complete } from "@earendil-works/pi-ai/compat";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import type { HerdrClient } from "../herdr-client.ts";
import type { RuntimeSnapshot } from "../runtime.ts";
import {
	DISPATCHED_ENTRY_TYPE,
	DISTILL_MAX_TOKENS,
	buildDistillInstruction,
	parseDispatchBrief,
	serializeSessionForDistill,
	sessionHasDistillableConversation,
	wrapDisplayLines,
} from "./brief.ts";
import { type LaunchClient, launchWorktreeSession } from "./launch.ts";

export interface StartUi {
	notify(message: string, type?: "info" | "warning" | "error"): void;
	editor(title: string, prefill?: string): Promise<string | undefined>;
}

export type DistillCompleter = (
	model: { provider: string; id: string },
	context: {
		systemPrompt: string;
		messages: Array<{ role: "user"; content: Array<{ type: "text"; text: string }>; timestamp: number }>;
	},
	options: {
		apiKey: string;
		headers?: Record<string, string | null>;
		env?: Record<string, string>;
		maxTokens?: number;
		signal?: AbortSignal;
	},
) => Promise<{
	content: Array<{ type: string; text?: string }>;
	stopReason?: string;
	errorMessage?: string;
}>;

export interface StartCommandContext {
	isIdle(): boolean;
	model?: { provider: string; id: string };
	modelRegistry: {
		getApiKeyAndHeaders(model: unknown): Promise<{
			ok: boolean;
			apiKey?: string;
			headers?: Record<string, string | null>;
			env?: Record<string, string>;
			error?: string;
		}>;
	};
	ui: StartUi;
	sessionManager: {
		getEntries(): readonly { type?: string; message?: { role?: string; content?: unknown } }[];
		getBranch?(): readonly { type?: string; message?: { role?: string; content?: unknown } }[];
	};
}

export function registerStartRenderers(pi: ExtensionAPI): void {
	pi.registerEntryRenderer<{ branch: string; workspaceId?: string; brief: string }>(
		DISPATCHED_ENTRY_TYPE,
		(entry, _options, theme) => {
			const data = entry.data ?? { branch: "", brief: "" };
			const heading = data.workspaceId
				? `${theme.fg("accent", "[已派出]")} ${data.branch} · ${data.workspaceId}`
				: `${theme.fg("accent", "[已派出]")} ${data.branch}`;
			return {
				render(width: number) {
					return [heading, ...wrapDisplayLines(data.brief, width)];
				},
				invalidate() {},
			};
		},
	);
}

function conversationEntries(ctx: StartCommandContext) {
	return ctx.sessionManager.getBranch?.() ?? ctx.sessionManager.getEntries();
}

function textFromComplete(response: Awaited<ReturnType<DistillCompleter>>): string {
	return response.content
		.filter((item): item is { type: "text"; text: string } => item.type === "text" && typeof item.text === "string")
		.map((item) => item.text)
		.join("\n")
		.trim();
}

export function createStartController(
	pi: ExtensionAPI,
	options: {
		runtime: RuntimeSnapshot;
		client: LaunchClient;
		completeModel?: DistillCompleter;
	},
) {
	const completeModel = options.completeModel ?? (complete as unknown as DistillCompleter);

	async function distillPlan(ctx: StartCommandContext, branch?: string): Promise<string> {
		if (!ctx.model) throw new Error("/herdr-worktree start requires an active model.");
		const conversation = serializeSessionForDistill(conversationEntries(ctx));
		if (!conversation) throw new Error("There is no conversation to distill into a dispatch plan.");
		const auth = await ctx.modelRegistry.getApiKeyAndHeaders(ctx.model);
		if (!auth.ok || !auth.apiKey) {
			throw new Error(auth.error ?? `No API key for ${ctx.model.provider}`);
		}
		const response = await completeModel(
			ctx.model,
			{
				systemPrompt: buildDistillInstruction(branch),
				messages: [{
					role: "user",
					content: [{ type: "text", text: conversation }],
					timestamp: Date.now(),
				}],
			},
			{
				apiKey: auth.apiKey,
				...(auth.headers ? { headers: auth.headers } : {}),
				...(auth.env ? { env: auth.env } : {}),
				maxTokens: DISTILL_MAX_TOKENS,
			},
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			throw new Error(response.errorMessage ?? "Dispatch plan generation failed.");
		}
		const text = textFromComplete(response);
		if (!text) throw new Error("Dispatch plan generation returned no text.");
		return text;
	}

	async function beginDistill(routeBranch: string | undefined, ctx: StartCommandContext): Promise<void> {
		if (!ctx.isIdle()) {
			ctx.ui.notify("/herdr-worktree start needs an idle session.", "warning");
			return;
		}
		if (!options.runtime.workspaceId?.trim()) {
			ctx.ui.notify("Cannot dispatch: the current Herdr workspace is unknown.", "error");
			return;
		}
		if (routeBranch && (routeBranch === "main" || routeBranch === "master")) {
			ctx.ui.notify(`Refusing to dispatch to ${routeBranch}.`, "error");
			return;
		}
		if (!sessionHasDistillableConversation(conversationEntries(ctx))) {
			ctx.ui.notify("There is no conversation to distill into a dispatch plan.", "error");
			return;
		}

		ctx.ui.notify("整理派出计划…", "info");
		let drafted: string;
		try {
			drafted = await distillPlan(ctx, routeBranch);
		} catch (error) {
			ctx.ui.notify(
				`/herdr-worktree start failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
			return;
		}

		const parsed = parseDispatchBrief(drafted, routeBranch);
		if (parsed.status === "not-ready") {
			ctx.ui.notify(`Dispatch plan is not ready: ${parsed.reason}`, "warning");
			return;
		}
		if (parsed.status === "invalid") {
			ctx.ui.notify(parsed.message, "error");
			return;
		}

		const edited = await ctx.ui.editor("Review dispatch plan", parsed.brief);
		if (edited === undefined) {
			ctx.ui.notify("Worktree start cancelled.", "info");
			return;
		}
		const reviewed = parseDispatchBrief(edited, routeBranch);
		if (reviewed.status !== "ready") {
			const message = reviewed.status === "not-ready"
				? `Dispatch plan is not ready: ${reviewed.reason}`
				: reviewed.message;
			ctx.ui.notify(message, "error");
			return;
		}

		try {
			const launched = await launchWorktreeSession({
				client: options.client,
				sourceWorkspaceId: options.runtime.workspaceId as string,
				branch: reviewed.branch,
				brief: reviewed.brief,
			});
			if (launched.status === "rejected") {
				ctx.ui.notify(launched.message, "error");
				return;
			}
			if (launched.status === "incomplete") {
				ctx.ui.notify(
					launched.workspaceId
						? `Worktree ${launched.workspaceId} was created, but dispatch did not start: ${launched.message}`
						: launched.message,
					"error",
				);
				return;
			}
			pi.appendEntry(DISPATCHED_ENTRY_TYPE, {
				branch: launched.branch,
				workspaceId: launched.workspaceId,
				brief: reviewed.brief,
			});
			ctx.ui.notify(`Dispatched ${launched.branch} to ${launched.workspaceId}.`, "info");
		} catch (error) {
			ctx.ui.notify(
				`/herdr-worktree start failed: ${error instanceof Error ? error.message : String(error)}`,
				"error",
			);
		}
	}

	return { beginDistill };
}

export type StartClient = LaunchClient & Pick<HerdrClient, "getWorkspace" | "removeWorktree">;
