import { Type } from "typebox";
import { getAgentDir, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { ConsultAdoptionStore } from "../src/adoption.ts";
import { registerConsultCommand } from "../src/command.ts";
import { loadConsultConfig, loadConsultConfigSync, resolveGuidance } from "../src/config.ts";
import { executeConsult } from "../src/execute.ts";
import { appendConsultAdoption, parseConsultLog } from "../src/events.ts";
import { CONSULT_TOOL_NAME, TOOL_LABEL, WATCHDOG_STEER_TEXT, msgConsultEnabled } from "../src/messages.ts";
import { isConsultBlocked, reconcileConsultTool } from "../src/reconcile.ts";
import { renderConsultCall, renderConsultResult } from "../src/tool-display.ts";
import { ConsultTracker } from "../src/tracker.ts";
import { modelKeyOf, type ConsultConfig } from "../src/types.ts";

const ConsultParams = Type.Object({
	why: Type.String({
		minLength: 1,
		description: "Why you need a second opinion right now, in 1-2 sentences.",
	}),
});

const CONSULT_DESCRIPTION =
	"Ask a configured advisor model for a recommendation, confirmation, revision, or stop. " +
	"Required `why` is 1-2 sentences explaining why you need a second opinion now. " +
	"The advisor sees the conversation and your tool inventory, has no tools, and does not talk to the user.";

function currentModelKey(ctx: ExtensionContext): string | undefined {
	return ctx.model ? modelKeyOf(ctx.model) : undefined;
}

function applyReconcile(pi: ExtensionAPI, ctx: ExtensionContext, config: ConsultConfig, notify = false): void {
	const blocked = isConsultBlocked(config, currentModelKey(ctx));
	reconcileConsultTool(pi, ctx, {
		blocked,
		...(notify
			? {
					notify: {
						disabled: "Consult unloaded (no panel or disabled for this model)",
						restored: msgConsultEnabled(config.panel.map((member) => member.model)),
					},
				}
			: {}),
	});
}

export default function consultExtension(pi: ExtensionAPI): void {
	const agentDir = getAgentDir();
	const tracker = new ConsultTracker();
	const adoptionStore = new ConsultAdoptionStore();
	let loaded = loadConsultConfigSync(agentDir);

	const guidance = resolveGuidance(loaded.config);
	pi.registerTool({
		name: CONSULT_TOOL_NAME,
		label: TOOL_LABEL,
		description: CONSULT_DESCRIPTION,
		promptSnippet: guidance.promptSnippet,
		promptGuidelines: guidance.promptGuidelines,
		parameters: ConsultParams,
		renderShell: "self",
		renderCall: (args, theme, context) => renderConsultCall(args, theme, context),
		renderResult: (result, options, theme, context) => {
			adoptionStore.watch(context.toolCallId, context.invalidate);
			return renderConsultResult(result, options, theme, {
				...context,
				adoption: adoptionStore.get(context.toolCallId),
			});
		},
		async execute(toolCallId, params, signal, onUpdate, ctx) {
			const why = typeof params.why === "string" ? params.why : "";
			const result = await executeConsult({
				why,
				toolCallId,
				ctx,
				pi,
				config: loaded.config,
				tracker,
				agentDir,
				signal,
				onUpdate,
			});
			if (result.details?.outcome === "completed") adoptionStore.markConsult(toolCallId);
			return result;
		},
	});

	registerConsultCommand(pi, {
		getConfig: () => loaded.config,
		getRaw: () => loaded.raw,
		setConfig: (config, raw) => {
			loaded = { ...loaded, config, raw };
		},
		tracker,
		agentDir,
		onConfigChanged: (ctx) => applyReconcile(pi, ctx, loaded.config, true),
	});

	pi.on("session_start", async (_event, ctx) => {
		loaded = await loadConsultConfig(agentDir);
		if (loaded.warning && ctx.hasUI) ctx.ui.notify(loaded.warning, "warning");
		tracker.onSessionStart();
		adoptionStore.restore(ctx.sessionManager.getBranch());
		applyReconcile(pi, ctx, loaded.config, true);
	});

	pi.on("before_agent_start", async (_event, ctx) => {
		applyReconcile(pi, ctx, loaded.config);
	});

	pi.on("model_select", async (event, ctx) => {
		if (event.source === "restore") return;
		applyReconcile(pi, ctx, loaded.config, true);
	});

	pi.on("input", async (event) => {
		if (event.source === "extension") return;
		tracker.onUserTurn();
		adoptionStore.clearPending();
	});

	pi.on("tool_execution_start", async (event) => {
		tracker.onToolStart(event.toolCallId, event.toolName, event.args);
	});

	pi.on("tool_execution_end", async (event, ctx) => {
		tracker.onToolEnd(event.toolCallId, event.toolName, event.isError, event.result);
		if (event.toolName === CONSULT_TOOL_NAME) return;
		const decision = tracker.evaluateWatchdog(loaded.config.gates.watchdog, loaded.config.budget);
		if (!decision.fire) return;
		if (isConsultBlocked(loaded.config, currentModelKey(ctx))) return;
		tracker.markWatchdogFired();
		pi.sendUserMessage(WATCHDOG_STEER_TEXT, { deliverAs: "steer" });
	});

	pi.on("message_end", async (event, ctx) => {
		const message = event.message;
		if (message.role !== "assistant") return;
		const text = message.content
			.filter((part) => part.type === "text")
			.map((part) => (part.type === "text" ? part.text : ""))
			.join("\n");
		const parsed = parseConsultLog(text);
		if (!parsed) return;
		const toolCallId = adoptionStore.recordLatest(parsed);
		if (!toolCallId) return;
		const sessionFile = ctx.sessionManager.getSessionFile?.();
		const session = sessionFile ? sessionFile.split(/[/\\]/).pop()?.replace(/\.jsonl?$/, "") || "ephemeral" : "ephemeral";
		try {
			await appendConsultAdoption(
				session,
				toolCallId,
				{ adopted: parsed.adopted, effect: parsed.effect },
				agentDir,
			);
		} catch {
			// Adoption is best-effort self-report.
		}
	});
}
