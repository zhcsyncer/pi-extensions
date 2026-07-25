import path from "node:path";
import { Buffer } from "node:buffer";
import { Type } from "typebox";
import {
	getAgentDir,
	withFileMutationQueue,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import {
	DEFAULT_PLAN_MODE_CONFIG,
	getPlanModeConfigPath,
	loadPlanModeConfig,
	type PlanContentLanguage,
} from "../src/config.ts";
import {
	SUBMIT_PLAN_TOOL,
	getPlanningTools,
	isPlanningToolAllowed,
	withoutManagedTools,
} from "../src/policy.ts";
import {
	appendPlanningPrompt,
	buildImplementationHandoff,
	buildReviewFeedback,
} from "../src/prompts.ts";
import { resolveRevdiffBinary, reviewPlanWithRevdiff } from "../src/review.ts";
import {
	approvePlan,
	cleanupReviewWorkspace,
	createTemporaryPlanRoot,
	ensurePersistentPlanRoot,
	generatePlanId,
	getPlanPaths,
	isValidPlanId,
	readPlanMetadata,
	removeTemporaryPlanRoot,
	saveSubmittedPlan,
	updatePlanStatus,
	writeReviewAnnotations,
} from "../src/storage.ts";
import {
	SESSION_STATE_VERSION,
	type PlanMetadata,
	type PlanMode,
	type PlanSessionState,
	type PlanStorageMode,
} from "../src/types.ts";
import {
	renderModeWidget,
	renderPlanApprovedEvent,
	renderPlanWidget,
	type PlanApprovedEventData,
} from "../src/widgets.ts";

const STATE_ENTRY_TYPE = "zhcsyncer-plan-mode-state";
export const APPROVED_PLAN_MESSAGE_TYPE = "zhcsyncer-plan-approved";
const PLAN_WIDGET_KEY = "zhcsyncer-plan-mode-document";
const MODE_WIDGET_KEY = "zhcsyncer-plan-mode-indicator";
const MAX_PLAN_BYTES = 256 * 1024;
const APPROVE_CHOICE = "Approve Plan";
const KEEP_PLANNING_CHOICE = "Keep planning";
const CANCEL_REVIEW_CHOICE = "Cancel review";

export const PLAN_MODE_SHORTCUT = "ctrl+alt+p";
export const PLAN_STEPS_SHORTCUT = "ctrl+alt+o";

interface ToolDetails {
	kind: string;
	planId?: string;
	revision?: number;
	planPath?: string;
	approvedHash?: string;
}

interface ApprovedPlanMessageDetails extends PlanApprovedEventData {
	title: string;
	revision: number;
	stepCount: number;
	planId: string;
	approvedHash: string;
	planPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseSessionState(value: unknown): PlanSessionState | undefined {
	if (!isRecord(value) || value.version !== SESSION_STATE_VERSION) return undefined;
	if (value.mode !== "normal" && value.mode !== "planning") return undefined;
	if (!Array.isArray(value.normalTools) || !value.normalTools.every((tool) => typeof tool === "string")) return undefined;
	if (value.planId !== undefined && (typeof value.planId !== "string" || !isValidPlanId(value.planId))) return undefined;
	if (value.revision !== undefined && (typeof value.revision !== "number" || !Number.isInteger(value.revision) || value.revision < 1)) {
		return undefined;
	}
	if ((value.planId === undefined) !== (value.revision === undefined)) return undefined;
	return value as unknown as PlanSessionState;
}

function findLatestSessionState(ctx: ExtensionContext): PlanSessionState | undefined {
	let latest: PlanSessionState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const parsed = parseSessionState(entry.data);
		if (parsed) latest = parsed;
	}
	return latest;
}

function textResult(text: string, details: ToolDetails, terminate = false) {
	return {
		content: [{ type: "text" as const, text }],
		details,
		...(terminate ? { terminate: true } : {}),
	};
}

function normalizeMarkdown(markdown: string): string {
	return markdown.endsWith("\n") ? markdown : `${markdown}\n`;
}

export function isPersistentSession(ctx: Pick<ExtensionContext, "sessionManager">): boolean {
	return ctx.sessionManager.getSessionFile() !== undefined;
}

export default function planModeExtension(pi: ExtensionAPI): void {
	pi.registerFlag("plan", {
		description: "Start in strict read-only Plan Mode",
		type: "boolean",
		default: false,
	});

	pi.registerMessageRenderer<ApprovedPlanMessageDetails>(APPROVED_PLAN_MESSAGE_TYPE, (message, _options, theme) => {
		const details: Record<string, unknown> = isRecord(message.details) ? message.details : {};
		const eventData: PlanApprovedEventData = {
			...(typeof details.title === "string" ? { title: details.title } : {}),
			...(typeof details.revision === "number" ? { revision: details.revision } : {}),
			...(typeof details.stepCount === "number" ? { stepCount: details.stepCount } : {}),
		};
		return {
			render: (width) => renderPlanApprovedEvent(eventData, width, theme),
			invalidate() {},
		};
	});

	let tuiEnabled = false;
	let toolsRegistered = false;
	let mode: PlanMode = "normal";
	let planId: string | undefined;
	let currentRevision: number | undefined;
	let currentMetadata: PlanMetadata | undefined;
	let planRoot: string | undefined;
	let normalTools: string[] = [];
	let temporaryRoot: string | undefined;
	let disabledReason: string | undefined;
	let stepsExpanded = false;
	let contentLanguage: PlanContentLanguage = DEFAULT_PLAN_MODE_CONFIG.contentLanguage;
	let planConfigPath = getPlanModeConfigPath();

	function persistState(ctx: ExtensionContext): void {
		if (!isPersistentSession(ctx)) return;
		const data: PlanSessionState = {
			version: SESSION_STATE_VERSION,
			mode,
			planId,
			revision: currentRevision,
			normalTools,
		};
		pi.appendEntry(STATE_ENTRY_TYPE, data);
	}

	function applyNormalTools(fallback?: string[]): void {
		const restore = normalTools.length > 0 ? normalTools : fallback ?? withoutManagedTools(pi.getActiveTools());
		normalTools = withoutManagedTools(restore);
		pi.setActiveTools(normalTools);
	}

	function applyPlanningTools(): void {
		pi.setActiveTools(getPlanningTools(normalTools));
	}

	function refreshWidgets(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		const revision = currentRevisionMetadata();
		if (planId && currentMetadata && revision && planRoot) {
			const planPath = getPlanPaths(planRoot, planId, revision.revision, revision.basedOn).plan;
			ctx.ui.setWidget(
				PLAN_WIDGET_KEY,
				(tui, theme) => ({
					render: (width) => renderPlanWidget({
						title: currentMetadata?.title ?? "Plan",
						status: revision.status,
						revision: revision.revision,
						planPath,
						steps: revision.steps,
						expanded: stepsExpanded,
						terminalRows: tui.terminal.rows,
					}, width, theme),
					invalidate() {},
				}),
				{ placement: "aboveEditor" },
			);
		} else {
			ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
		}

		if (tuiEnabled && mode === "planning") {
			ctx.ui.setWidget(
				MODE_WIDGET_KEY,
				(_tui, theme) => ({
					render: (width) => renderModeWidget(width, theme),
					invalidate() {},
				}),
				{ placement: "belowEditor" },
			);
		} else {
			ctx.ui.setWidget(MODE_WIDGET_KEY, undefined);
		}
	}

	function clearWidgets(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		ctx.ui.setWidget(PLAN_WIDGET_KEY, undefined);
		ctx.ui.setWidget(MODE_WIDGET_KEY, undefined);
	}

	async function ensurePlanRoot(ctx: ExtensionContext): Promise<{ root: string; storage: PlanStorageMode }> {
		if (isPersistentSession(ctx)) {
			const root = await ensurePersistentPlanRoot(path.join(getAgentDir(), "plans"));
			planRoot = root;
			return { root, storage: "persistent" };
		}
		if (!temporaryRoot) temporaryRoot = await createTemporaryPlanRoot();
		planRoot = temporaryRoot;
		return { root: temporaryRoot, storage: "temporary" };
	}

	function setMode(ctx: ExtensionContext, nextMode: PlanMode, notify = true): void {
		if (nextMode === mode) {
			if (notify) ctx.ui.notify(`Plan Mode is already ${mode === "planning" ? "on" : "off"}.`, "info");
			return;
		}
		if (nextMode === "planning") {
			normalTools = withoutManagedTools(pi.getActiveTools());
			mode = "planning";
			applyPlanningTools();
			persistState(ctx);
			refreshWidgets(ctx);
			if (notify) ctx.ui.notify("Plan Mode enabled. Tools are restricted to read-only exploration and submit_plan.", "info");
			return;
		}
		applyNormalTools();
		mode = "normal";
		persistState(ctx);
		refreshWidgets(ctx);
		if (notify) ctx.ui.notify("Plan Mode disabled. Normal tools restored.", "info");
	}

	function currentRevisionMetadata() {
		if (!currentMetadata || currentRevision === undefined) return undefined;
		return currentMetadata.revisions[currentRevision - 1];
	}

	function showPlanStatus(ctx: ExtensionContext): void {
		const lines = [
			`Plan Mode: ${mode === "planning" ? "on" : "off"}`,
			"Usage: /plan on|off",
			`Plan content language: ${contentLanguage}`,
			`Config: ${planConfigPath}`,
		];
		const revision = currentRevisionMetadata();
		if (planId && currentMetadata && revision && planRoot) {
			lines.push(
				`Current Plan: ${currentMetadata.title}`,
				`Document: ${revision.status.toUpperCase()} · r${revision.revision}`,
				`Path: ${getPlanPaths(planRoot, planId, revision.revision, revision.basedOn).plan}`,
			);
		}
		ctx.ui.notify(lines.join("\n"), "info");
	}

	function ensureCommandAvailable(ctx: ExtensionContext): boolean {
		if (ctx.mode !== "tui") return false;
		if (tuiEnabled) return true;
		if (disabledReason) ctx.ui.notify(disabledReason, "warning");
		return false;
	}

	function registerTools(): void {
		if (toolsRegistered) return;
		toolsRegistered = true;

		pi.registerTool({
			name: SUBMIT_PLAN_TOOL,
			label: "Submit Plan",
			description: "Persist a complete Plan revision and open revdiff for explicit user review. Re-submit the full Plan after feedback.",
			promptSnippet: "Submit a complete Plan revision for terminal review",
			promptGuidelines: [
				"Use submit_plan only in Plan Mode after repository exploration is complete.",
				"Call submit_plan with the entire Plan, never a delta, and as the only tool in its tool-call batch.",
				"Pass the current planId when revising the same Plan; omit planId only when starting a different Plan.",
			],
			parameters: Type.Object({
				planId: Type.Optional(Type.String({ description: "Current Plan ID when submitting another revision of the same Plan." })),
				title: Type.String({ minLength: 1, maxLength: 160, description: "Concise Plan title." }),
				markdown: Type.String({ minLength: 1, description: "Complete decision-ready Markdown Plan." }),
			}),
			executionMode: "sequential",
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!tuiEnabled || ctx.mode !== "tui" || mode !== "planning") {
					return textResult("submit_plan is available only while TUI Plan Mode is on.", { kind: "unavailable" }, true);
				}

				const title = params.title.trim();
				const markdown = normalizeMarkdown(params.markdown);
				const requestedPlanId = params.planId?.trim() || undefined;
				if (!title || !markdown.trim()) {
					return textResult("Plan title and Markdown body must not be empty.", { kind: "invalid" }, true);
				}
				if (Buffer.byteLength(markdown, "utf8") > MAX_PLAN_BYTES) {
					return textResult(`Plan exceeds the ${MAX_PLAN_BYTES} byte limit.`, { kind: "invalid" }, true);
				}
				if (requestedPlanId && (!isValidPlanId(requestedPlanId) || requestedPlanId !== planId)) {
					return textResult(
						"planId must match the current Session branch Plan. Omit it to create a new Plan.",
						{ kind: "invalid_plan_id" },
						true,
					);
				}

				const storage = await ensurePlanRoot(ctx);
				const activePlanId = requestedPlanId ?? generatePlanId(title);
				const manifestPath = getPlanPaths(storage.root, activePlanId).manifest;
				let submitted;
				try {
					submitted = await withFileMutationQueue(manifestPath, () =>
						saveSubmittedPlan({
							root: storage.root,
							planId: activePlanId,
							title,
							markdown,
							storage: storage.storage,
							sessionId: ctx.sessionManager.getSessionId(),
							cwd: ctx.cwd,
							...(requestedPlanId && currentRevision ? { basedOn: currentRevision } : {}),
						}),
					);
				} catch (error) {
					return textResult(
						`Plan revision was not saved: ${error instanceof Error ? error.message : String(error)}`,
						{ kind: "storage_error", planId: activePlanId },
						true,
					);
				}

				planId = activePlanId;
				currentRevision = submitted.revision.revision;
				currentMetadata = submitted.metadata;
				stepsExpanded = false;
				persistState(ctx);
				refreshWidgets(ctx);

				const review = await reviewPlanWithRevdiff(ctx, {
					paths: submitted.paths,
					hasPrevious: submitted.hasPrevious,
					cwd: ctx.cwd,
				});

				if (review.kind === "changes_requested") {
					await writeReviewAnnotations(submitted.paths, review.annotations);
					currentMetadata = await updatePlanStatus(storage.root, activePlanId, "changes_requested");
					persistState(ctx);
					refreshWidgets(ctx);
					return textResult(buildReviewFeedback(activePlanId, submitted.revision.revision, review.annotations), {
						kind: review.kind,
						planId: activePlanId,
						revision: submitted.revision.revision,
						planPath: submitted.paths.plan,
					});
				}

				if (review.kind === "cancelled" || review.kind === "error") {
					currentMetadata = await updatePlanStatus(storage.root, activePlanId, "draft");
					persistState(ctx);
					refreshWidgets(ctx);
					return textResult(
						review.kind === "cancelled" ? `Plan review was cancelled: ${review.message}` : `Plan review failed: ${review.message}`,
						{
							kind: review.kind,
							planId: activePlanId,
							revision: submitted.revision.revision,
							planPath: submitted.paths.plan,
						},
						true,
					);
				}

				const decision = await ctx.ui.select("Plan review finished. Choose an explicit decision:", [
					APPROVE_CHOICE,
					KEEP_PLANNING_CHOICE,
					CANCEL_REVIEW_CHOICE,
				]);
				if (decision !== APPROVE_CHOICE) {
					currentMetadata = await updatePlanStatus(storage.root, activePlanId, "draft");
					persistState(ctx);
					refreshWidgets(ctx);
					const keepPlanning = decision === KEEP_PLANNING_CHOICE;
					return textResult(
						keepPlanning
							? "The user kept Plan Mode on. Continue planning or wait for further direction."
							: "The user cancelled this approval. The revision remains a draft and Plan Mode stays on.",
						{
							kind: keepPlanning ? "keep_planning" : "cancelled",
							planId: activePlanId,
							revision: submitted.revision.revision,
							planPath: submitted.paths.plan,
						},
						true,
					);
				}

				let approved: PlanMetadata;
				try {
					approved = await withFileMutationQueue(manifestPath, () =>
						approvePlan(storage.root, activePlanId, submitted.revision.revision, submitted.submittedHash),
					);
				} catch (error) {
					currentMetadata = await readPlanMetadata(storage.root, activePlanId);
					refreshWidgets(ctx);
					return textResult(
						`Approval was not recorded: ${error instanceof Error ? error.message : String(error)}. Submit the current Plan for review again.`,
						{
							kind: "integrity_error",
							planId: activePlanId,
							revision: submitted.revision.revision,
							planPath: submitted.paths.plan,
						},
						true,
					);
				}

				currentMetadata = approved;
				currentRevision = submitted.revision.revision;
				await cleanupReviewWorkspace(storage.root, activePlanId);
				setMode(ctx, "normal", false);
				const approvedHash = approved.approvedHash;
				if (!approvedHash) throw new Error("Approval did not produce an approved hash");
				pi.sendMessage<ApprovedPlanMessageDetails>(
					{
						customType: APPROVED_PLAN_MESSAGE_TYPE,
						content: buildImplementationHandoff({
							planId: activePlanId,
							title: approved.title,
							revision: submitted.revision.revision,
							approvedHash,
							planPath: submitted.paths.plan,
							markdown,
						}),
						display: true,
						details: {
							title: approved.title,
							revision: submitted.revision.revision,
							stepCount: submitted.revision.steps.length,
							planId: activePlanId,
							approvedHash,
							planPath: submitted.paths.plan,
						},
					},
					{ triggerTurn: true, deliverAs: "followUp" },
				);
				ctx.ui.notify(`Plan approved: ${approved.title} · r${submitted.revision.revision}`, "info");
				return textResult(
					`The user approved ${activePlanId} r${submitted.revision.revision}. Plan Mode is off and normal implementation will start next.`,
					{
						kind: "approved",
						planId: activePlanId,
						revision: submitted.revision.revision,
						planPath: submitted.paths.plan,
						approvedHash,
					},
					true,
				);
			},
		});
	}

	async function restoreState(ctx: ExtensionContext): Promise<void> {
		const fallbackTools = normalTools.length > 0 ? normalTools : withoutManagedTools(pi.getActiveTools());
		const restored = findLatestSessionState(ctx);
		if (!restored) {
			mode = "normal";
			planId = undefined;
			currentRevision = undefined;
			currentMetadata = undefined;
			planRoot = undefined;
			normalTools = fallbackTools;
			applyNormalTools(fallbackTools);
			refreshWidgets(ctx);
			return;
		}

		normalTools = withoutManagedTools(restored.normalTools.length > 0 ? restored.normalTools : fallbackTools);
		mode = restored.mode;
		planId = restored.planId;
		currentRevision = restored.revision;
		currentMetadata = undefined;
		planRoot = undefined;

		if (planId && currentRevision) {
			const root = await ensurePersistentPlanRoot(path.join(getAgentDir(), "plans"));
			const metadata = await readPlanMetadata(root, planId);
			const revision = metadata?.revisions[currentRevision - 1];
			if (metadata && revision && metadata.sessionId === ctx.sessionManager.getSessionId()) {
				planRoot = root;
				currentMetadata = metadata;
			} else {
				planId = undefined;
				currentRevision = undefined;
			}
		}

		if (mode === "planning") applyPlanningTools();
		else applyNormalTools(fallbackTools);
		refreshWidgets(ctx);
	}

	pi.on("session_start", async (event, ctx) => {
		if (ctx.mode !== "tui") return;
		stepsExpanded = false;
		const loadedConfig = await loadPlanModeConfig();
		contentLanguage = loadedConfig.config.contentLanguage;
		planConfigPath = loadedConfig.path;
		if (loadedConfig.warning) ctx.ui.notify(loadedConfig.warning, "warning");
		if (!resolveRevdiffBinary()) {
			tuiEnabled = false;
			disabledReason = "Plan Mode is disabled because revdiff is not installed. Install it, then restart Pi. macOS: brew install umputun/apps/revdiff";
			if (toolsRegistered) pi.setActiveTools(withoutManagedTools(pi.getActiveTools()));
			clearWidgets(ctx);
			ctx.ui.notify(disabledReason, "warning");
			return;
		}
		disabledReason = undefined;
		tuiEnabled = true;
		registerTools();
		await restoreState(ctx);
		if (event.reason === "startup" && pi.getFlag("plan") === true && mode === "normal") {
			setMode(ctx, "planning", false);
		}
	});

	pi.on("session_tree", async (_event, ctx) => {
		if (!tuiEnabled || ctx.mode !== "tui") return;
		stepsExpanded = false;
		await restoreState(ctx);
	});

	pi.on("session_shutdown", async (_event, ctx) => {
		clearWidgets(ctx);
		tuiEnabled = false;
		await removeTemporaryPlanRoot(temporaryRoot).catch(() => undefined);
		temporaryRoot = undefined;
		if (!isPersistentSession(ctx)) {
			mode = "normal";
			planId = undefined;
			currentRevision = undefined;
			currentMetadata = undefined;
			planRoot = undefined;
			normalTools = [];
		}
	});

	pi.on("tool_call", async (event, ctx) => {
		if (!tuiEnabled || ctx.mode !== "tui" || mode !== "planning") return;
		if (isPlanningToolAllowed(event.toolName)) return;
		const reason = `Plan Mode blocked non-read-only tool: ${event.toolName}`;
		ctx.ui.notify(reason, "warning");
		return { block: true, reason };
	});

	pi.on("before_agent_start", async (event, ctx) => {
		if (!tuiEnabled || ctx.mode !== "tui" || mode !== "planning") return;
		const revision = currentRevisionMetadata();
		if (!planRoot || !planId || !currentMetadata || !revision) {
			return { systemPrompt: appendPlanningPrompt(event.systemPrompt, undefined, contentLanguage) };
		}
		return {
			systemPrompt: appendPlanningPrompt(event.systemPrompt, {
				planId,
				title: currentMetadata.title,
				revision: revision.revision,
				status: revision.status,
				planPath: getPlanPaths(planRoot, planId, revision.revision, revision.basedOn).plan,
			}, contentLanguage),
		};
	});

	pi.registerCommand("plan", {
		description: "Turn strict read-only Plan Mode on or off",
		getArgumentCompletions: (argumentPrefix) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			const options = [
				{ value: "on", label: "on", description: "Enable read-only Plan Mode" },
				{ value: "off", label: "off", description: "Disable Plan Mode and restore normal tools" },
			];
			return options.filter((option) => option.value.startsWith(prefix));
		},
		handler: async (args, ctx) => {
			if (!ensureCommandAvailable(ctx)) return;
			const action = args.trim().toLowerCase();
			if (!action) {
				showPlanStatus(ctx);
				return;
			}
			if (action !== "on" && action !== "off") {
				ctx.ui.notify("Usage: /plan on|off", "warning");
				return;
			}
			setMode(ctx, action === "on" ? "planning" : "normal");
		},
	});

	pi.registerShortcut(PLAN_MODE_SHORTCUT, {
		description: "Toggle Plan Mode",
		handler: (ctx) => {
			if (!ensureCommandAvailable(ctx)) return;
			setMode(ctx, mode === "planning" ? "normal" : "planning");
		},
	});

	pi.registerShortcut(PLAN_STEPS_SHORTCUT, {
		description: "Expand or collapse current Plan steps",
		handler: (ctx) => {
			if (!ensureCommandAvailable(ctx)) return;
			if (!currentRevisionMetadata()) {
				ctx.ui.notify("No current Plan.", "info");
				return;
			}
			stepsExpanded = !stepsExpanded;
			refreshWidgets(ctx);
		},
	});
}
