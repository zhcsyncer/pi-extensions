/**
 * todo tool + /todos command — thin registration shell.
 *
 * Tool/command identity, schema, types, reducer, store, replay, response
 * envelope, selectors, and view formatters live in the layered modules under
 * `tool/`, `state/`, and `view/`. This file is the package-root registration
 * surface — it mirrors `packages/rpiv-ask-user-question/ask-user-question.ts`
 * which keeps the tool registration at the package root.
 *
 * Public re-exports below keep the stable domain helpers while runtime state
 * is explicitly injected through a per-extension `TodoStore`.
 */

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { loadConfig, validateGuidanceFields } from "./config.js";
import { formatStatusLabel, t } from "./state/i18n-bridge.js";
import { replayFromBranch } from "./state/replay.js";
import { selectTasksByStatus, selectTodoCounts, selectVisibleTasks } from "./state/selectors.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import type { TodoStore } from "./state/store.js";
import { buildToolResult } from "./tool/response-envelope.js";
import {
	COMMAND_NAME,
	ERR_REQUIRES_INTERACTIVE,
	MSG_NO_TODOS,
	type TaskMutationParams,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
} from "./tool/types.js";
import { formatCommandTaskLine, renderTodoCall, renderTodoResult } from "./view/format.js";

// English fallbacks for localized /todos section headers — the box-drawing
// decoration is part of the localized string so translators can adjust spacing.
const SECTION_PENDING = "── Pending ──";
const SECTION_IN_PROGRESS = "── In Progress ──";
const SECTION_COMPLETED = "── Completed ──";

// ---------------------------------------------------------------------------
// Public re-exports — pre-refactor consumers (overlay, tests, index.ts) keep
// importing from `./todo.js`. New code may opt into deeper imports.
// ---------------------------------------------------------------------------

export { isTransitionValid } from "./state/invariants.js";
export { applyTaskMutation } from "./state/state-reducer.js";
export { createTodoStore, type TodoStore } from "./state/store.js";
export { deriveBlocks, detectCycle } from "./state/task-graph.js";
export type { Task, TaskAction, TaskDetails, TaskStatus } from "./tool/types.js";
export { TOOL_NAME } from "./tool/types.js";

/**
 * Replay helper for callers that compose the tool manually. The target store
 * is explicit so multiple extension runtimes cannot share session state.
 */
export function reconstructTodoState(ctx: Parameters<typeof replayFromBranch>[0], store: TodoStore): void {
	store.replaceState(replayFromBranch(ctx));
}

// ---------------------------------------------------------------------------
// Tool registration
// ---------------------------------------------------------------------------

export const DEFAULT_PROMPT_SNIPPET = "Manage a task list to track multi-step progress";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` only for work with multiple meaningful stages, an explicit user task list, dependencies, or material verification risk. Do not create a Todo for a single-step, low-risk action or a purely conversational request.",
	"Todo items are independently valuable milestones, not a mirror of every command, file read, or tiny implementation action.",
	"Use `todo` batch to create multiple initial tasks or apply several known create/update/delete operations atomically; if one operation fails, none are committed.",
	"When starting a task, update it to in_progress with activeForm BEFORE beginning work. Mark it completed IMMEDIATELY when done. Exactly one task may be in_progress.",
	"Never mark a task completed if tests are failing, the implementation is partial, or unresolved errors remain. Keep it in_progress while actively resolving; when separate blocker work is needed, re-queue it as pending with blockedBy and start the blocker task.",
	"The normal lifecycle is pending → in_progress → completed, with deleted as a tombstone. An in-progress task may return to pending when re-queued behind a blocker; completed or deleted tasks cannot reopen.",
	"Use blockedBy to express dependencies. A blocked task cannot start until every dependency is completed. On create use blockedBy; on update use addBlockedBy/removeBlockedBy. Cycles are rejected.",
	"list hides tombstoned tasks by default; pass includeDeleted:true to include them or status to filter by one status.",
	"Keep subject short and imperative; use description for durable context and activeForm for the present-continuous in-progress label.",
];

export function registerTodoTool(pi: ExtensionAPI, store: TodoStore): void {
	const guidance = validateGuidanceFields(loadConfig().guidance);
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create, update, list, get, delete, clear, and batch (atomic create/update/delete operations). Status: pending → in_progress → completed, plus deleted tombstone. Use this for meaningful multi-stage work, not single-step tasks.",
		promptSnippet: guidance.promptSnippet ?? DEFAULT_PROMPT_SNIPPET,
		promptGuidelines: guidance.promptGuidelines ?? DEFAULT_PROMPT_GUIDELINES,
		parameters: TodoParamsSchema,
		renderShell: "self",

		async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
			const result = applyTaskMutation(store.getState(), params.action, params as TaskMutationParams);
			if (result.op.kind === "error") throw new Error(result.op.message);
			store.commitState(result.state);
			return buildToolResult(params.action, params as TaskMutationParams, result.state, result.op);
		},

		renderCall(args, theme, context) {
			return renderTodoCall(args as TaskMutationParams, theme, context?.expanded === true);
		},

		renderResult(result, options, theme, context) {
			return renderTodoResult(result, theme, context.isError, options.expanded);
		},
	});
}

// ---------------------------------------------------------------------------
// /todos slash command
// ---------------------------------------------------------------------------

export function registerTodosCommand(pi: ExtensionAPI, store: TodoStore): void {
	pi.registerCommand(COMMAND_NAME, {
		description: "Show all todos on the current branch, grouped by status",
		handler: async (_args, ctx) => {
			if (!ctx.hasUI) {
				ctx.ui.notify(t("command.requires_interactive", ERR_REQUIRES_INTERACTIVE), "error");
				return;
			}
			const state = store.getState();
			const visible = selectVisibleTasks(state);
			if (visible.length === 0) {
				ctx.ui.notify(t("command.no_todos", MSG_NO_TODOS), "info");
				return;
			}
			const groups = selectTasksByStatus(state);
			const counts = selectTodoCounts(state);

			const header: string[] = [];
			if (counts.completed > 0) header.push(`${counts.completed}/${counts.total} ${formatStatusLabel("completed")}`);
			if (counts.inProgress > 0) header.push(`${counts.inProgress} ${formatStatusLabel("in_progress")}`);
			if (counts.pending > 0) header.push(`${counts.pending} ${formatStatusLabel("pending")}`);

			const lines: string[] = [header.join(" · ")];
			if (groups.pending.length > 0) {
				lines.push(t("command.section.pending", SECTION_PENDING));
				for (const task of groups.pending) lines.push(formatCommandTaskLine(task, "○"));
			}
			if (groups.inProgress.length > 0) {
				lines.push(t("command.section.in_progress", SECTION_IN_PROGRESS));
				for (const task of groups.inProgress) lines.push(formatCommandTaskLine(task, "◐"));
			}
			if (groups.completed.length > 0) {
				lines.push(t("command.section.completed", SECTION_COMPLETED));
				for (const task of groups.completed) lines.push(formatCommandTaskLine(task, "✓"));
			}

			ctx.ui.notify(lines.join("\n"), "info");
		},
	});
}
