import type { PlanContentLanguage } from "./config.ts";

const ENGLISH_PLAN_HEADINGS = [
	"Goal",
	"Non-goals",
	"Current evidence",
	"Decisions and rationale",
	"Proposed changes",
	"Execution steps",
	"Verification",
	"Risks",
	"Assumptions",
] as const;

const CHINESE_PLAN_HEADINGS = [
	"目标",
	"非目标",
	"当前证据",
	"决策与理由",
	"拟议改动",
	"执行步骤",
	"验证",
	"风险",
	"假设",
] as const;

function headingList(headings: readonly string[]): string {
	return headings.map((heading) => `  - ## ${heading}`).join("\n");
}

function planLanguageRules(contentLanguage: PlanContentLanguage): string {
	if (contentLanguage === "en") {
		return `[PLAN CONTENT LANGUAGE]\nConfigured content language: en.\n- Write the Plan title, section headings, prose, and list items in English.\n- Use these required section headings exactly:\n${headingList(ENGLISH_PLAN_HEADINGS)}`;
	}
	if (contentLanguage === "zh-CN") {
		return `[PLAN CONTENT LANGUAGE]\nConfigured content language: zh-CN.\n- Write the Plan title, section headings, prose, and list items in Simplified Chinese.\n- Use these required section headings exactly:\n${headingList(CHINESE_PLAN_HEADINGS)}`;
	}
	return `[PLAN CONTENT LANGUAGE]\nConfigured content language: auto.\n- Follow higher-priority language instructions and any explicit language requested by the user. If neither specifies a language, match the current user's language.\n- When writing the Plan in Simplified Chinese, use these required section headings exactly:\n${headingList(CHINESE_PLAN_HEADINGS)}\n- Otherwise, use these required section headings exactly:\n${headingList(ENGLISH_PLAN_HEADINGS)}`;
}

export function buildPlanningPrompt(contentLanguage: PlanContentLanguage = "auto"): string {
	return `[PLAN MODE ACTIVE]
You are in a strictly read-only planning mode. The harness enforces a fail-closed tool allowlist.

Rules:
- Inspect facts before proposing changes.
- Do not modify source code, project documentation, Git state, dependencies, generated files, or external mutable systems.
- Do not attempt to bypass the tool policy or ask the user to make changes on your behalf.
- Ask only high-impact questions whose answers cannot be discovered from the repository or environment.
- Produce a decision-complete plan, not an implementation.
- The plan must include all nine required sections specified below.
- When ready, call submit_plan with the complete title and complete Markdown body. Do not write a plan file directly.
- Call submit_plan as the only tool call in its tool batch.
- If review feedback is returned, revise the full plan and call submit_plan again with the current planId.

${planLanguageRules(contentLanguage)}

The user must explicitly approve the reviewed content before normal tools are restored.`;
}

export const PLANNING_PROMPT = buildPlanningPrompt();

export interface CurrentPlanReferenceInput {
	planId: string;
	title: string;
	revision: number;
	status: string;
	planPath: string;
}

export function appendPlanningPrompt(
	systemPrompt: string,
	currentPlan?: CurrentPlanReferenceInput,
	contentLanguage: PlanContentLanguage = "auto",
): string {
	const base = `${systemPrompt}\n\n${buildPlanningPrompt(contentLanguage)}`;
	if (!currentPlan) return base;
	return `${base}\n\n[CURRENT PLAN REFERENCE]
A Plan is attached to the current Session branch. Use it as context and inspect the current workspace before deciding whether it still applies. Pass this planId to submit_plan only when revising the same goal; omit planId to create a different Plan.

Plan: ${currentPlan.title}
Plan ID: ${currentPlan.planId}
Revision: r${currentPlan.revision}
Document status: ${currentPlan.status}
Plan path: ${currentPlan.planPath}

Read that revision with the read tool before revising or replacing it.`;
}

export interface ImplementationHandoffInput {
	planId: string;
	title: string;
	revision: number;
	approvedHash: string;
	planPath: string;
	markdown: string;
}

export function buildImplementationHandoff(input: ImplementationHandoffInput): string {
	return `[APPROVED PLAN]
The user approved the exact Plan revision below. Plan Mode is now off and normal tools are restored.

Plan: ${input.title}
Plan ID: ${input.planId}
Revision: r${input.revision}
Approved hash: ${input.approvedHash}
Plan path: ${input.planPath}

Implement the approved Plan using the current workspace as the source of truth. If repository facts invalidate a decision, stop and ask the user rather than silently changing scope.

--- BEGIN APPROVED PLAN ---
${input.markdown}
--- END APPROVED PLAN ---`;
}

export function buildReviewFeedback(planId: string, revision: number, annotations: string): string {
	return `The user reviewed plan ${planId} r${revision} and requested changes. Address every annotation, then submit the complete revised plan with submit_plan and planId ${planId}.\n\n${annotations}`;
}
