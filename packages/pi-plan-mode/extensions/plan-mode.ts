import { Buffer } from "node:buffer";
import path from "node:path";
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
import { withHerdrBlocked } from "../src/herdr.ts";
import {
	closePlanWork,
	createImplementingWork,
	isCompletableWork,
	migrateStoredPlanSessionState,
	parseStoredPlanSessionState,
	type StoredPlanSessionState,
} from "../src/lifecycle.ts";
import {
	COMPLETE_PLAN_TOOL,
	SUBMIT_PLAN_TOOL,
	getNormalTools,
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
	verifyApprovedPlan,
	writeReviewAnnotations,
} from "../src/storage.ts";
import {
	renderCompletePlanCall,
	renderCompletePlanResult,
	renderSubmitPlanCall,
	renderSubmitPlanResult,
	type PlanToolDetails,
} from "../src/tool-display.ts";
import {
	SESSION_STATE_VERSION,
	type PlanMetadata,
	type PlanMode,
	type PlanReference,
	type PlanSessionState,
	type PlanStorageMode,
	type PlanWorkReference,
} from "../src/types.ts";
import {
	renderModeWidget,
	renderPlanApprovedEvent,
	renderPlanLifecycleEvent,
	renderPlanWidget,
	type PlanApprovedEventData,
	type PlanLifecycleEventData,
} from "../src/widgets.ts";

const STATE_ENTRY_TYPE = "zhcsyncer-plan-mode-state";
export const APPROVED_PLAN_MESSAGE_TYPE = "zhcsyncer-plan-approved";
export const PLAN_LIFECYCLE_ENTRY_TYPE = "zhcsyncer-plan-lifecycle";
const PLAN_WIDGET_KEY = "zhcsyncer-plan-mode-document";
const MODE_WIDGET_KEY = "zhcsyncer-plan-mode-indicator";
const MAX_PLAN_BYTES = 256 * 1024;
const APPROVE_CHOICE = "Approve Plan";
const KEEP_PLANNING_CHOICE = "Keep planning";
const CANCEL_REVIEW_CHOICE = "Cancel review";

export const REVISE_WORK_CHOICE = "Revise the current Plan";
export const COMPLETE_AND_NEW_CHOICE = "Mark completed and start a new Plan";
export const ABANDON_AND_NEW_CHOICE = "Abandon and start a new Plan";
export const CANCEL_PLAN_ENTRY_CHOICE = "Cancel";

export const PLAN_MODE_SHORTCUT = "ctrl+alt+p";
export const PLAN_STEPS_SHORTCUT = "ctrl+alt+o";

interface ApprovedPlanMessageDetails extends PlanApprovedEventData {
	title: string;
	revision: number;
	stepCount: number;
	planId: string;
	approvedHash: string;
	planPath: string;
}

interface WorkRecord {
	metadata: PlanMetadata;
	planPath: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function findLatestStoredSessionState(ctx: ExtensionContext): StoredPlanSessionState | undefined {
	let latest: StoredPlanSessionState | undefined;
	for (const entry of ctx.sessionManager.getBranch()) {
		if (entry.type !== "custom" || entry.customType !== STATE_ENTRY_TYPE) continue;
		const parsed = parseStoredPlanSessionState(entry.data);
		if (parsed) latest = parsed;
	}
	return latest;
}

function textResult(text: string, details: PlanToolDetails, terminate = false) {
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

	pi.registerEntryRenderer<PlanLifecycleEventData>(PLAN_LIFECYCLE_ENTRY_TYPE, (entry, options, theme) => {
		const data = isRecord(entry.data) ? entry.data as PlanLifecycleEventData : {};
		return {
			render: (width) => renderPlanLifecycleEvent(data, width, theme, options.expanded),
			invalidate() {},
		};
	});

	let tuiEnabled = false;
	let toolsRegistered = false;
	let mode: PlanMode = "normal";
	let planning: PlanReference | undefined;
	let work: PlanWorkReference | undefined;
	let planRoot: string | undefined;
	let normalTools: string[] = [];
	let temporaryRoot: string | undefined;
	let disabledReason: string | undefined;
	let stepsExpanded = false;
	let contentLanguage: PlanContentLanguage = DEFAULT_PLAN_MODE_CONFIG.contentLanguage;
	let planConfigPath = getPlanModeConfigPath();
	const metadataByPlanId = new Map<string, PlanMetadata>();

	function persistState(ctx: ExtensionContext): void {
		if (!isPersistentSession(ctx)) return;
		const data: PlanSessionState = {
			version: SESSION_STATE_VERSION,
			mode,
			normalTools,
			...(planning ? { planning } : {}),
			...(work ? { work } : {}),
		};
		pi.appendEntry(STATE_ENTRY_TYPE, data);
	}

	function applyNormalTools(fallback?: string[]): void {
		const restore = normalTools.length > 0 ? normalTools : fallback ?? withoutManagedTools(pi.getActiveTools());
		normalTools = withoutManagedTools(restore);
		pi.setActiveTools(getNormalTools(normalTools, isCompletableWork(work)));
	}

	function applyPlanningTools(): void {
		pi.setActiveTools(getPlanningTools(normalTools));
	}

	function metadataFor(reference: PlanReference | undefined): PlanMetadata | undefined {
		return reference ? metadataByPlanId.get(reference.planId) : undefined;
	}

	function revisionFor(reference: PlanReference | undefined) {
		const metadata = metadataFor(reference);
		return reference && metadata ? metadata.revisions[reference.revision - 1] : undefined;
	}

	function displayReference(): { reference: PlanReference; workRef?: PlanWorkReference } | undefined {
		if (planning) return { reference: planning };
		if (mode === "planning" || !work) return undefined;
		return { reference: work, workRef: work };
	}

	function planPathFor(reference: PlanReference): string | undefined {
		if (!planRoot) return undefined;
		const revision = revisionFor(reference);
		if (!revision) return undefined;
		return getPlanPaths(planRoot, reference.planId, reference.revision, revision.basedOn).plan;
	}

	function refreshWidgets(ctx: ExtensionContext): void {
		if (ctx.mode !== "tui") return;
		const displayed = displayReference();
		const metadata = metadataFor(displayed?.reference);
		const revision = revisionFor(displayed?.reference);
		const planPath = displayed ? planPathFor(displayed.reference) : undefined;
		if (displayed && metadata && revision && planPath) {
			ctx.ui.setWidget(
				PLAN_WIDGET_KEY,
				(tui, theme) => ({
					render: (width) => renderPlanWidget({
						title: metadata.title,
						status: revision.status,
						...(displayed.workRef ? {
							workStatus: displayed.workRef.status,
							approvedHash: displayed.workRef.approvedHash,
						} : {}),
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

	function setNormalMode(ctx: ExtensionContext, notify = true): void {
		if (mode === "normal") {
			if (notify) ctx.ui.notify("Plan Mode is already off.", "info");
			return;
		}
		mode = "normal";
		applyNormalTools();
		persistState(ctx);
		refreshWidgets(ctx);
		if (notify) ctx.ui.notify("Plan Mode disabled. Normal tools restored.", "info");
	}

	function appendLifecycleEvent(ctx: ExtensionContext, data: PlanLifecycleEventData): void {
		if (isPersistentSession(ctx)) pi.appendEntry(PLAN_LIFECYCLE_ENTRY_TYPE, data);
	}

	async function resolveWorkRecord(ctx: ExtensionContext, target: PlanWorkReference): Promise<WorkRecord> {
		const storage = await ensurePlanRoot(ctx);
		const metadata = await readPlanMetadata(storage.root, target.planId);
		const revision = metadata?.revisions[target.revision - 1];
		if (!metadata || metadata.sessionId !== ctx.sessionManager.getSessionId()) {
			throw new Error("Current Plan metadata is missing or belongs to another Session");
		}
		if (!revision || revision.status !== "approved" || revision.hash !== target.approvedHash) {
			throw new Error("Current Plan work does not match an approved revision");
		}
		metadataByPlanId.set(target.planId, metadata);
		return {
			metadata,
			planPath: getPlanPaths(storage.root, target.planId, target.revision, revision.basedOn).plan,
		};
	}

	async function closeCurrentWork(
		ctx: ExtensionContext,
		status: "completed" | "abandoned",
		source: "agent" | "user" | "migration",
		audit: { summary?: string; verification?: string[] } = {},
		notify = true,
	): Promise<PlanLifecycleEventData> {
		if (!work || !isCompletableWork(work)) throw new Error("There is no implementing Plan to close");
		const target = work;
		const record = await resolveWorkRecord(ctx, target);
		if (status === "completed") {
			const integrity = await verifyApprovedPlan(planRoot!, target.planId, target.revision, target.approvedHash);
			if (!integrity.ok) throw new Error(integrity.reason ?? "Approved Plan integrity check failed");
		}
		work = closePlanWork(target, status);
		if (mode === "normal") applyNormalTools();
		persistState(ctx);
		refreshWidgets(ctx);
		const data: PlanLifecycleEventData = {
			kind: status,
			title: record.metadata.title,
			planId: target.planId,
			revision: target.revision,
			planPath: record.planPath,
			approvedHash: target.approvedHash,
			source,
			...(audit.summary?.trim() ? { summary: audit.summary.trim() } : {}),
			...(audit.verification?.length ? { verification: [...audit.verification] } : {}),
		};
		appendLifecycleEvent(ctx, data);
		if (notify) {
			ctx.ui.notify(
				status === "completed"
					? `Plan completed: ${record.metadata.title} · r${target.revision}`
					: `Plan abandoned: ${record.metadata.title} · r${target.revision}`,
				status === "completed" ? "info" : "warning",
			);
		}
		return data;
	}

	async function enterPlanningMode(ctx: ExtensionContext, notify = true): Promise<boolean> {
		if (mode === "planning") {
			if (notify) ctx.ui.notify("Plan Mode is already on.", "info");
			return true;
		}

		if (!planning && isCompletableWork(work)) {
			const metadata = metadataFor(work) ?? (work ? (await resolveWorkRecord(ctx, work)).metadata : undefined);
			const status = work?.status === "unknown" ? "LEGACY APPROVED" : "IMPLEMENTING";
			const choice = await withHerdrBlocked(pi, "plan lifecycle decision", () =>
				ctx.ui.select(
					`Current Plan is ${status}: ${metadata?.title ?? "Plan"} · r${work?.revision}`,
					[REVISE_WORK_CHOICE, COMPLETE_AND_NEW_CHOICE, ABANDON_AND_NEW_CHOICE, CANCEL_PLAN_ENTRY_CHOICE],
				),
			);
			if (choice === REVISE_WORK_CHOICE && work) {
				planning = { planId: work.planId, revision: work.revision };
			} else if (choice === COMPLETE_AND_NEW_CHOICE || choice === ABANDON_AND_NEW_CHOICE) {
				const closingAs = choice === COMPLETE_AND_NEW_CHOICE ? "completed" : "abandoned";
				try {
					await closeCurrentWork(
						ctx,
						closingAs,
						"user",
						{ summary: closingAs === "completed" ? "Marked complete while starting a new Plan." : "Abandoned while starting a new Plan." },
						false,
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
					return false;
				}
				planning = undefined;
			} else {
				if (notify) ctx.ui.notify("Plan Mode entry cancelled.", "info");
				return false;
			}
		}

		normalTools = withoutManagedTools(pi.getActiveTools());
		mode = "planning";
		stepsExpanded = false;
		applyPlanningTools();
		persistState(ctx);
		refreshWidgets(ctx);
		if (notify) {
			ctx.ui.notify(
				planning
					? "Plan Mode enabled for an explicit Plan revision. Tools are restricted to read-only exploration and submit_plan."
					: "Plan Mode enabled for a new Plan. Tools are restricted to read-only exploration and submit_plan.",
				"info",
			);
		}
		return true;
	}

	async function reviseCurrentWork(ctx: ExtensionContext): Promise<void> {
		if (!work) {
			ctx.ui.notify("No approved Plan is available to revise.", "info");
			return;
		}
		if (planning && (planning.planId !== work.planId || planning.revision !== work.revision)) {
			ctx.ui.notify("A different draft Plan is already attached. Finish or leave that revision before revising the approved Plan.", "warning");
			return;
		}
		try {
			await resolveWorkRecord(ctx, work);
		} catch (error) {
			ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
			return;
		}
		planning = { planId: work.planId, revision: work.revision };
		if (mode !== "planning") {
			normalTools = withoutManagedTools(pi.getActiveTools());
			mode = "planning";
		}
		stepsExpanded = false;
		applyPlanningTools();
		persistState(ctx);
		refreshWidgets(ctx);
		ctx.ui.notify(`Plan Mode enabled to revise r${work.revision}.`, "info");
	}

	function showPlanStatus(ctx: ExtensionContext): void {
		const lines = [
			`Plan Mode: ${mode === "planning" ? "on" : "off"}`,
			"Usage: /plan on|off|revise|complete|abandon",
			`Plan content language: ${contentLanguage}`,
			`Config: ${planConfigPath}`,
		];
		if (planning) {
			const metadata = metadataFor(planning);
			const revision = revisionFor(planning);
			const planPath = planPathFor(planning);
			if (metadata && revision && planPath) {
				lines.push(
					`Planning Plan: ${metadata.title}`,
					`Document: ${revision.status.toUpperCase()} · r${revision.revision}`,
					`Path: ${planPath}`,
				);
			}
		}
		if (work) {
			const metadata = metadataFor(work);
			const planPath = planPathFor(work);
			lines.push(
				`Plan work: ${work.status.toUpperCase()}${metadata ? ` · ${metadata.title}` : ""} · r${work.revision}`,
				`Approved hash: ${work.approvedHash}`,
				...(planPath ? [`Path: ${planPath}`] : []),
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
				"Pass the attached planId only when explicitly revising that Plan; omit planId for a new unattached Plan.",
			],
			parameters: Type.Object({
				planId: Type.Optional(Type.String({ description: "Attached Plan ID when submitting another revision of the same Plan." })),
				title: Type.String({ minLength: 1, maxLength: 160, description: "Concise Plan title." }),
				markdown: Type.String({ minLength: 1, description: "Complete decision-ready Markdown Plan." }),
			}),
			executionMode: "sequential",
			renderShell: "self",
			renderCall: renderSubmitPlanCall,
			renderResult: renderSubmitPlanResult,
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
				if (requestedPlanId && !isValidPlanId(requestedPlanId)) {
					return textResult("planId is not valid.", { kind: "invalid_plan_id" }, true);
				}
				if (planning && requestedPlanId !== planning.planId) {
					return textResult(
						"The attached Plan requires its exact planId. Use /plan on for a new Plan only after closing the current workflow.",
						{ kind: "invalid_plan_id", planId: planning.planId, revision: planning.revision },
						true,
					);
				}
				if (!planning && requestedPlanId) {
					return textResult(
						"No Plan is attached for revision. Omit planId to create a new Plan or use /plan revise first.",
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
							...(planning ? { basedOn: planning.revision } : {}),
						}),
					);
				} catch (error) {
					return textResult(
						`Plan revision was not saved: ${error instanceof Error ? error.message : String(error)}`,
						{ kind: "storage_error", planId: activePlanId },
						true,
					);
				}

				planning = { planId: activePlanId, revision: submitted.revision.revision };
				metadataByPlanId.set(activePlanId, submitted.metadata);
				stepsExpanded = false;
				persistState(ctx);
				refreshWidgets(ctx);

				const review = await withHerdrBlocked(pi, "plan review", () =>
					reviewPlanWithRevdiff(ctx, {
						paths: submitted.paths,
						hasPrevious: submitted.hasPrevious,
						cwd: ctx.cwd,
					}),
				);

				if (review.kind === "changes_requested") {
					await writeReviewAnnotations(submitted.paths, review.annotations);
					const metadata = await updatePlanStatus(storage.root, activePlanId, "changes_requested");
					metadataByPlanId.set(activePlanId, metadata);
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
					const metadata = await updatePlanStatus(storage.root, activePlanId, "draft");
					metadataByPlanId.set(activePlanId, metadata);
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

				const decision = await withHerdrBlocked(pi, "plan approval", () =>
					ctx.ui.select("Plan review finished. Choose an explicit decision:", [
						APPROVE_CHOICE,
						KEEP_PLANNING_CHOICE,
						CANCEL_REVIEW_CHOICE,
					]),
				);
				if (decision !== APPROVE_CHOICE) {
					const metadata = await updatePlanStatus(storage.root, activePlanId, "draft");
					metadataByPlanId.set(activePlanId, metadata);
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
					const metadata = await readPlanMetadata(storage.root, activePlanId);
					if (metadata) metadataByPlanId.set(activePlanId, metadata);
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

				metadataByPlanId.set(activePlanId, approved);
				const approvedHash = approved.approvedHash;
				if (!approvedHash) throw new Error("Approval did not produce an approved hash");
				work = createImplementingWork({ planId: activePlanId, revision: submitted.revision.revision }, approvedHash);
				planning = undefined;
				await cleanupReviewWorkspace(storage.root, activePlanId);
				setNormalMode(ctx, false);
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

		pi.registerTool({
			name: COMPLETE_PLAN_TOOL,
			label: "Complete Plan",
			description: "Close the exact approved Plan work only after all approved scope is implemented and necessary verification passes. Never use while work is partial, checks fail, or unresolved errors remain.",
			promptSnippet: "Mark the current approved Plan implementation complete after successful verification",
			promptGuidelines: [
				"Call complete_plan only after every item in the exact approved Plan is implemented and all necessary verification passes.",
				"Never call complete_plan while implementation is partial, tests or checks fail, or unresolved errors remain.",
				"Call complete_plan with the current exact planId and revision as the only and final tool in its batch.",
			],
			parameters: Type.Object({
				planId: Type.String({ description: "Exact current approved Plan ID." }),
				revision: Type.Integer({ minimum: 1, description: "Exact current approved revision." }),
				summary: Type.String({ minLength: 1, maxLength: 2000, description: "Concise summary of the completed implementation." }),
				verification: Type.Array(Type.String({ minLength: 1, maxLength: 500 }), {
					minItems: 1,
					maxItems: 20,
					description: "Checks that completed successfully. Do not include failing or pending checks.",
				}),
			}),
			executionMode: "sequential",
			renderShell: "self",
			renderCall: renderCompletePlanCall,
			renderResult: renderCompletePlanResult,
			async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
				if (!tuiEnabled || ctx.mode !== "tui" || mode !== "normal" || !work || !isCompletableWork(work)) {
					throw new Error("complete_plan is available only for the current implementing Plan in TUI normal mode");
				}
				if (params.planId !== work.planId || params.revision !== work.revision) {
					throw new Error(`complete_plan must target ${work.planId} r${work.revision}`);
				}
				const summary = params.summary.trim();
				const verification = params.verification.map((item) => item.trim()).filter(Boolean);
				if (!summary || verification.length === 0) throw new Error("Completion summary and successful verification checks are required");
				const event = await closeCurrentWork(ctx, "completed", "agent", { summary, verification }, false);
				const completedAt = work.completedAt;
				return textResult(
					`Plan ${params.planId} r${params.revision} is complete.\n\nSummary: ${summary}\n\nVerification:\n${verification.map((item) => `- ${item}`).join("\n")}`,
					{
						kind: "completed",
						planId: params.planId,
						revision: params.revision,
						planPath: event.planPath,
						approvedHash: event.approvedHash,
						title: event.title,
						completedAt,
						summary,
						verification,
					},
					true,
				);
			},
		});
	}

	async function loadMetadataForReference(ctx: ExtensionContext, reference: PlanReference): Promise<PlanMetadata | undefined> {
		const root = await ensurePersistentPlanRoot(path.join(getAgentDir(), "plans"));
		planRoot = root;
		const metadata = await readPlanMetadata(root, reference.planId);
		if (!metadata || metadata.sessionId !== ctx.sessionManager.getSessionId() || !metadata.revisions[reference.revision - 1]) {
			return undefined;
		}
		metadataByPlanId.set(reference.planId, metadata);
		return metadata;
	}

	async function restoreState(ctx: ExtensionContext): Promise<void> {
		const fallbackTools = normalTools.length > 0 ? normalTools : withoutManagedTools(pi.getActiveTools());
		const stored = findLatestStoredSessionState(ctx);
		metadataByPlanId.clear();
		planRoot = undefined;
		planning = undefined;
		work = undefined;
		if (!stored) {
			mode = "normal";
			normalTools = fallbackTools;
			applyNormalTools(fallbackTools);
			refreshWidgets(ctx);
			return;
		}

		let restored: PlanSessionState;
		if (stored.version === SESSION_STATE_VERSION) {
			restored = stored;
		} else {
			let metadata: PlanMetadata | undefined;
			if (stored.planId && stored.revision) {
				metadata = await loadMetadataForReference(ctx, { planId: stored.planId, revision: stored.revision });
			}
			restored = migrateStoredPlanSessionState(stored, metadata);
		}

		normalTools = withoutManagedTools(restored.normalTools.length > 0 ? restored.normalTools : fallbackTools);
		mode = restored.mode;
		planning = restored.planning;
		work = restored.work;

		if (planning && !(await loadMetadataForReference(ctx, planning))) planning = undefined;
		if (work) {
			const metadata = metadataFor(work) ?? await loadMetadataForReference(ctx, work);
			const revision = metadata?.revisions[work.revision - 1];
			if (!metadata || !revision || revision.status !== "approved" || revision.hash !== work.approvedHash) work = undefined;
		}

		if (mode === "planning" && !planning && isCompletableWork(work)) {
			mode = "normal";
			applyNormalTools(fallbackTools);
			refreshWidgets(ctx);
			await enterPlanningMode(ctx, false);
			return;
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
			await enterPlanningMode(ctx, false);
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
			planning = undefined;
			work = undefined;
			metadataByPlanId.clear();
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
		const metadata = metadataFor(planning);
		const revision = revisionFor(planning);
		const planPath = planning ? planPathFor(planning) : undefined;
		if (!planning || !metadata || !revision || !planPath) {
			return { systemPrompt: appendPlanningPrompt(event.systemPrompt, undefined, contentLanguage) };
		}
		return {
			systemPrompt: appendPlanningPrompt(event.systemPrompt, {
				planId: planning.planId,
				title: metadata.title,
				revision: revision.revision,
				status: revision.status,
				planPath,
			}, contentLanguage),
		};
	});

	pi.registerCommand("plan", {
		description: "Manage strict read-only Plan Mode and the approved Plan lifecycle",
		getArgumentCompletions: (argumentPrefix) => {
			const prefix = argumentPrefix.trim().toLowerCase();
			const options = [
				{ value: "on", label: "on", description: "Enable read-only Plan Mode" },
				{ value: "off", label: "off", description: "Disable Plan Mode and restore normal tools" },
				{ value: "revise", label: "revise", description: "Explicitly revise the current approved Plan" },
				{ value: "complete", label: "complete", description: "Mark the current approved Plan work complete" },
				{ value: "abandon", label: "abandon", description: "Abandon the current approved Plan work" },
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
			if (action === "on") {
				await enterPlanningMode(ctx);
				return;
			}
			if (action === "off") {
				setNormalMode(ctx);
				return;
			}
			if (action === "revise") {
				await reviseCurrentWork(ctx);
				return;
			}
			if (action === "complete" || action === "abandon") {
				if (!work || !isCompletableWork(work)) {
					ctx.ui.notify("There is no implementing or legacy approved Plan to close.", "info");
					return;
				}
				if (mode !== "normal") {
					ctx.ui.notify("Turn Plan Mode off before closing implementation work.", "warning");
					return;
				}
				const verb = action === "complete" ? "complete" : "abandon";
				const confirmed = await withHerdrBlocked(
					pi,
					verb === "complete" ? "plan completion confirmation" : "plan abandonment confirmation",
					() => ctx.ui.confirm(
						`${verb === "complete" ? "Complete" : "Abandon"} current Plan?`,
						verb === "complete"
							? "Confirm only if all approved scope is implemented and necessary verification passes."
							: "The approved artifact remains available, but this work will no longer be active.",
					),
				);
				if (!confirmed) return;
				try {
					await closeCurrentWork(
						ctx,
						verb === "complete" ? "completed" : "abandoned",
						"user",
						{ summary: verb === "complete" ? "Marked complete by the user." : "Abandoned by the user." },
					);
				} catch (error) {
					ctx.ui.notify(error instanceof Error ? error.message : String(error), "error");
				}
				return;
			}
			ctx.ui.notify("Usage: /plan on|off|revise|complete|abandon", "warning");
		},
	});

	pi.registerShortcut(PLAN_MODE_SHORTCUT, {
		description: "Toggle Plan Mode",
		handler: async (ctx) => {
			if (!ensureCommandAvailable(ctx)) return;
			if (mode === "planning") setNormalMode(ctx);
			else await enterPlanningMode(ctx);
		},
	});

	pi.registerShortcut(PLAN_STEPS_SHORTCUT, {
		description: "Expand or collapse current Plan steps",
		handler: (ctx) => {
			if (!ensureCommandAvailable(ctx)) return;
			if (!displayReference()) {
				ctx.ui.notify("No current Plan.", "info");
				return;
			}
			stepsExpanded = !stepsExpanded;
			refreshWidgets(ctx);
		},
	});
}
