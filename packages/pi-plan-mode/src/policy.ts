export const SUBMIT_PLAN_TOOL = "submit_plan";
export const COMPLETE_PLAN_TOOL = "complete_plan";

const READ_ONLY_PLANNING_TOOLS = new Set([
	"read",
	"grep",
	"find",
	"ls",
	"web_search",
	"web_read",
	"resolve-library-id",
	"query-docs",
	"ask_user_question",
	"questionnaire",
]);

const MANAGED_TOOLS = new Set([SUBMIT_PLAN_TOOL, COMPLETE_PLAN_TOOL]);

export function withoutManagedTools(toolNames: string[]): string[] {
	return [...new Set(toolNames.filter((name) => !MANAGED_TOOLS.has(name)))];
}

export function getPlanningTools(previouslyActive: string[]): string[] {
	return [
		...new Set([
			...previouslyActive.filter((name) => READ_ONLY_PLANNING_TOOLS.has(name)),
			SUBMIT_PLAN_TOOL,
		]),
	];
}

export function getNormalTools(previouslyActive: string[], canCompletePlan: boolean): string[] {
	return [
		...new Set([
			...withoutManagedTools(previouslyActive),
			...(canCompletePlan ? [COMPLETE_PLAN_TOOL] : []),
		]),
	];
}

export function isPlanningToolAllowed(toolName: string): boolean {
	return toolName === SUBMIT_PLAN_TOOL || READ_ONLY_PLANNING_TOOLS.has(toolName);
}
