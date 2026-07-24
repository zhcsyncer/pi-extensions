export type RuntimeEventKind =
	| "session_info_changed"
	| "model_select"
	| "thinking_level_select"
	| "turn_start"
	| "tool_execution_end"
	| "session_tree"
	| "session_compact"
	| "message_end"
	| "turn_end"
	| "agent_end"
	| "config_save_success"
	| "editor_thinking_cycle";

export type RuntimeSnapshotMode = "none" | "reliable" | "lifecycle" | "message" | "thinking" | "compact";
export type RuntimeGitRefreshMode = "never" | "onWorkspaceChange" | "immediate";
export type RuntimeContextPlan = "none" | "refresh" | "clear";

export interface RuntimeRefreshPlan {
	ensureConfig: boolean;
	ensureState: boolean;
	snapshot: RuntimeSnapshotMode;
	refreshWorkspace: boolean;
	refreshModel: boolean;
	refreshUsageTotals: boolean;
	context: RuntimeContextPlan;
	git: RuntimeGitRefreshMode;
	render: boolean;
}

export interface RuntimeEventFacts {
	messageRole?: string;
}

const ENSURE_ONLY_PLAN: RuntimeRefreshPlan = {
	ensureConfig: true,
	ensureState: true,
	snapshot: "none",
	refreshWorkspace: false,
	refreshModel: false,
	refreshUsageTotals: false,
	context: "none",
	git: "never",
	render: false,
};

const LIFECYCLE_WITH_MODEL_IMMEDIATE_PLAN: RuntimeRefreshPlan = {
	ensureConfig: true,
	ensureState: true,
	snapshot: "lifecycle",
	refreshWorkspace: true,
	refreshModel: true,
	refreshUsageTotals: false,
	context: "refresh",
	git: "immediate",
	render: true,
};

const LIFECYCLE_WITH_MODEL_ON_WORKSPACE_CHANGE_PLAN: RuntimeRefreshPlan = {
	ensureConfig: true,
	ensureState: true,
	snapshot: "lifecycle",
	refreshWorkspace: true,
	refreshModel: true,
	refreshUsageTotals: false,
	context: "refresh",
	git: "onWorkspaceChange",
	render: true,
};

const RELIABLE_WITH_MODEL_IMMEDIATE_PLAN: RuntimeRefreshPlan = {
	ensureConfig: true,
	ensureState: true,
	snapshot: "reliable",
	refreshWorkspace: true,
	refreshModel: true,
	refreshUsageTotals: true,
	context: "refresh",
	git: "immediate",
	render: true,
};

const TURN_END_PLAN: RuntimeRefreshPlan = {
	ensureConfig: true,
	ensureState: true,
	snapshot: "lifecycle",
	refreshWorkspace: true,
	refreshModel: false,
	refreshUsageTotals: false,
	context: "refresh",
	git: "onWorkspaceChange",
	render: true,
};

const AGENT_END_PLAN: RuntimeRefreshPlan = {
	ensureConfig: true,
	ensureState: true,
	snapshot: "lifecycle",
	refreshWorkspace: true,
	refreshModel: false,
	refreshUsageTotals: false,
	context: "refresh",
	git: "onWorkspaceChange",
	render: true,
};

const TOOL_EXECUTION_END_PLAN: RuntimeRefreshPlan = {
	ensureConfig: true,
	ensureState: true,
	snapshot: "lifecycle",
	refreshWorkspace: true,
	refreshModel: false,
	refreshUsageTotals: false,
	context: "refresh",
	git: "immediate",
	render: true,
};

const ASSISTANT_MESSAGE_END_PLAN: RuntimeRefreshPlan = {
	ensureConfig: true,
	ensureState: true,
	snapshot: "message",
	refreshWorkspace: true,
	refreshModel: false,
	refreshUsageTotals: false,
	context: "refresh",
	git: "onWorkspaceChange",
	render: true,
};

const SESSION_COMPACT_PLAN: RuntimeRefreshPlan = {
	ensureConfig: true,
	ensureState: true,
	snapshot: "compact",
	refreshWorkspace: true,
	refreshModel: true,
	refreshUsageTotals: true,
	context: "clear",
	git: "immediate",
	render: true,
};

const THINKING_LEVEL_SELECT_PLAN: RuntimeRefreshPlan = {
	ensureConfig: true,
	ensureState: true,
	snapshot: "thinking",
	refreshWorkspace: false,
	refreshModel: true,
	refreshUsageTotals: false,
	context: "none",
	git: "never",
	render: true,
};

const EDITOR_THINKING_CYCLE_PLAN: RuntimeRefreshPlan = {
	ensureConfig: false,
	ensureState: false,
	snapshot: "thinking",
	refreshWorkspace: false,
	refreshModel: true,
	refreshUsageTotals: false,
	context: "none",
	git: "never",
	render: true,
};

const CONFIG_SAVE_SUCCESS_PLAN: RuntimeRefreshPlan = {
	ensureConfig: false,
	ensureState: false,
	snapshot: "reliable",
	refreshWorkspace: true,
	refreshModel: true,
	refreshUsageTotals: true,
	context: "refresh",
	git: "immediate",
	render: true,
};

function clonePlan(plan: RuntimeRefreshPlan): RuntimeRefreshPlan {
	return { ...plan };
}

export function runtimePlanFor(kind: RuntimeEventKind, facts: RuntimeEventFacts = {}): RuntimeRefreshPlan {
	switch (kind) {
		case "session_info_changed":
			return clonePlan(LIFECYCLE_WITH_MODEL_ON_WORKSPACE_CHANGE_PLAN);
		case "model_select":
			return clonePlan(LIFECYCLE_WITH_MODEL_IMMEDIATE_PLAN);
		case "session_tree":
			return clonePlan(RELIABLE_WITH_MODEL_IMMEDIATE_PLAN);
		case "turn_start":
			return clonePlan(LIFECYCLE_WITH_MODEL_ON_WORKSPACE_CHANGE_PLAN);
		case "tool_execution_end":
			return clonePlan(TOOL_EXECUTION_END_PLAN);
		case "session_compact":
			return clonePlan(SESSION_COMPACT_PLAN);
		case "message_end":
			return facts.messageRole === "assistant" || facts.messageRole === "toolResult"
				? clonePlan(ASSISTANT_MESSAGE_END_PLAN)
				: clonePlan(ENSURE_ONLY_PLAN);
		case "turn_end":
			return clonePlan(TURN_END_PLAN);
		case "agent_end":
			return clonePlan(AGENT_END_PLAN);
		case "thinking_level_select":
			return clonePlan(THINKING_LEVEL_SELECT_PLAN);
		case "editor_thinking_cycle":
			return clonePlan(EDITOR_THINKING_CYCLE_PLAN);
		case "config_save_success":
			return clonePlan(CONFIG_SAVE_SUCCESS_PLAN);
	}
}
