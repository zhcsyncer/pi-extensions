/**
 * Todo tool + visual settings command — thin registration shell.
 *
 * Tool identity, schema, types, reducer, store, replay, response envelope,
 * selectors, and view formatters live in the layered modules under `tool/`,
 * `state/`, and `view/`. Runtime state is explicitly injected through a
 * per-extension `TodoStore`.
 */

import { getSettingsListTheme, type ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui";
import {
	loadConfig,
	resolveMaxWidgetLines,
	type TodoConfig,
	type TodoVisualConfig,
	validateGuidanceFields,
} from "./config.js";
import { replayFromBranch } from "./state/replay.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import type { TodoStore } from "./state/store.js";
import { buildToolResult } from "./tool/response-envelope.js";
import {
	type TaskMutationParams,
	TOOL_LABEL,
	TOOL_NAME,
	TodoParamsSchema,
} from "./tool/types.js";
import { renderTodoCall, renderTodoResult } from "./view/format.js";

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
	"Use `todo` batch for ordered atomic operations. Each operation sees prior results and all roll back if one fails. Prefer one batch that creates the first task in_progress and the remaining tasks pending; for handoff, complete or re-queue the active task before starting the next.",
	"When starting a task, either create it directly with status in_progress or update it to in_progress BEFORE beginning work. Mark it completed IMMEDIATELY when done. Exactly one task may be in_progress.",
	"Never mark a task completed if tests are failing, the implementation is partial, or unresolved errors remain. Keep it in_progress while actively resolving; when separate blocker work is needed, re-queue it as pending with blockedBy and start the blocker task.",
	"The normal lifecycle is pending → in_progress → completed, with deleted as a tombstone. A pending task may move directly to completed only to reconcile work already finished before its status was updated. An in-progress task may return to pending; completed or deleted tasks cannot reopen.",
	"Use blockedBy to express dependencies. A blocked task cannot start or complete until every dependency is completed. On create use blockedBy; on update use addBlockedBy/removeBlockedBy. Cycles are rejected.",
	"list hides tombstoned tasks by default; pass includeDeleted:true to include them or status to filter by one status.",
	"Keep subject short and imperative; use description only for durable context, task boundaries, or acceptance criteria that the subject cannot express.",
];

export function registerTodoTool(pi: ExtensionAPI, store: TodoStore, config: TodoConfig = loadConfig()): void {
	const guidance = validateGuidanceFields(config.guidance);
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a task list for tracking multi-step progress. Actions: create, update, list, get, delete, clear, and batch. Create defaults to pending or can start directly in_progress. Batch operations run in order and roll back atomically. Complete or re-queue the active task before starting another. Use this for meaningful multi-stage work, not single-step tasks.",
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
// /todo visual settings command
// ---------------------------------------------------------------------------

const MAX_WIDGET_LINE_PRESETS = [4, 8, 13, 20, 30] as const;

type TodoVisualSettingId = "statusIcons" | "maxWidgetLines";

export interface TodoCommandOptions {
	getConfig: () => TodoVisualConfig;
	updateConfig: (config: TodoVisualConfig) => void;
}

function maxWidgetLineValues(current: number): string[] {
	return [...new Set([...MAX_WIDGET_LINE_PRESETS, current])]
		.sort((left, right) => left - right)
		.map(String);
}

function visualSettingValue(config: TodoVisualConfig, id: TodoVisualSettingId): string {
	return id === "statusIcons" ? config.statusIcons : String(config.maxWidgetLines);
}

function visualSettingItems(config: TodoVisualConfig): SettingItem[] {
	return [
		{
			id: "statusIcons",
			label: "Status icons",
			description: "Choose the glyph preset used by the Todo widget.",
			currentValue: config.statusIcons,
			values: ["ascii", "unicode", "nerd-font"],
		},
		{
			id: "maxWidgetLines",
			label: "Maximum widget lines",
			description: "Total height including heading, overflow summary, and blank separator.",
			currentValue: String(config.maxWidgetLines),
			values: maxWidgetLineValues(config.maxWidgetLines),
		},
	];
}

function applyVisualSetting(
	config: TodoVisualConfig,
	id: TodoVisualSettingId,
	newValue: string,
): TodoVisualConfig {
	return id === "statusIcons"
		? { ...config, statusIcons: newValue as TodoVisualConfig["statusIcons"] }
		: { ...config, maxWidgetLines: resolveMaxWidgetLines(Number(newValue)) };
}

function errorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

export function registerTodoCommand(pi: ExtensionAPI, options: TodoCommandOptions): void {
	pi.registerCommand("todo", {
		description: "Configure Todo widget appearance",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todo requires TUI mode", "error");
				return;
			}

			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				let current = options.getConfig();
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("Todo Visual Settings")), 1, 0));
				container.addChild(new Text(theme.fg("dim", "Model guidance remains JSON-only."), 1, 0));

				let settingsList: SettingsList;
				settingsList = new SettingsList(
					visualSettingItems(current),
					4,
					getSettingsListTheme(),
					(id, newValue) => {
						const settingId = id as TodoVisualSettingId;
						const previous = current;
						const next = applyVisualSetting(previous, settingId, newValue);
						try {
							options.updateConfig(next);
							current = next;
						} catch (error) {
							settingsList.updateValue(settingId, visualSettingValue(previous, settingId));
							ctx.ui.notify(`Failed to save Todo settings: ${errorMessage(error)}`, "error");
						}
					},
					() => done(undefined),
				);
				container.addChild(settingsList);

				return {
					render: (width: number) => container.render(width),
					invalidate: () => container.invalidate(),
					handleInput: (data: string) => {
						settingsList.handleInput?.(data);
						tui.requestRender();
					},
				};
			});
		},
	});
}
