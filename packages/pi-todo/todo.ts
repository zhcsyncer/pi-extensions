/**
 * Todo tool + visual settings command — thin registration shell.
 *
 * Tool identity, schema, types, reducer, store, replay, response envelope,
 * selectors, and view formatters live in the layered modules under `tool/`,
 * `state/`, and `view/`. Runtime state is explicitly injected through a
 * per-extension `TodoStore`.
 */

import { getSettingsListTheme, type ExtensionAPI, type Theme } from "@earendil-works/pi-coding-agent";
import {
	Container,
	type SelectItem,
	SelectList,
	type SettingItem,
	SettingsList,
	Text,
} from "@earendil-works/pi-tui";
import {
	loadConfig,
	resolveMaxWidgetLines,
	type TodoConfig,
	type TodoVisualConfig,
	validateGuidanceFields,
} from "./config.js";
import { replayFromBranch } from "./state/replay.js";
import { applyTaskMutation } from "./state/state-reducer.js";
import type { TaskState } from "./state/state.js";
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

export const DEFAULT_PROMPT_SNIPPET = "Manage a multi-item execution plan for meaningful multi-stage work";
export const DEFAULT_PROMPT_GUIDELINES: string[] = [
	"Use `todo` only when you can name at least two independently valuable milestones before the first call. Never start a one-task Todo cycle, regardless of risk, duration, importance, or expected tool count. Execute one-milestone work directly. Split a combined subject only when it contains genuinely distinct outcomes; never split a tightly coupled edit-test loop or invent filler merely to reach two tasks.",
	"Todo items are independently valuable milestones, not a mirror of every command, file read, or tiny implementation action. The initial batch order is the default serial sequence; the single in_progress task is the current focus when later interrupting work changes that sequence. Prefer 3–7 items and aggregate lists that grow beyond roughly 12.",
	"Start every fresh Todo cycle with one atomic `batch` containing at least two create operations: set the first to in_progress and leave the rest pending in intended execution order. Runtime rejects a top-level create or a one-create batch on an empty or terminal cycle. Use top-level create only to append a newly discovered milestone to an already active multi-item cycle. Each batch operation sees prior results, and any failure rolls back the whole batch.",
	"A cycle may later have only one unfinished or visible task after other tasks finish; do not add filler to keep the count above one. For handoff, complete or re-queue the active task before updating the next pending task to in_progress. Exactly one task may be in_progress.",
	"Never mark a task completed if tests are failing, the implementation is partial, or unresolved errors remain. Keep it in_progress while actively resolving. If separate work interrupts the current milestone, atomically re-queue the current task and create the interrupting task in_progress; after it completes, resume the original task.",
	"The normal lifecycle is pending → in_progress → completed, with deleted as a tombstone. A pending task may move directly to completed only to reconcile work already finished before its status was updated. An in-progress task may return to pending; completed or deleted tasks cannot reopen.",
	"By default, `todo` list returns only pending and in_progress tasks and reports hidden completed tasks. With no status filter, includeDeleted:true returns all live-state statuses; an explicit status filter can query completed or deleted directly.",
	"When all current tasks are terminal, start the next cycle with the required multi-create batch; rollover happens automatically before that batch. Previous-cycle tasks leave live state and cannot be retrieved with list/get; use the transcript or session tree for history. Task ids remain monotonic. User-confirmed reset is available only in the `/todo` TUI.",
	"Treat the per-run `Current Todo state` system-prompt section, and any later `Current Todo state update`, as live-state truth; the latest update wins. If a new goal arrives while active tasks remain, continue, re-queue, delete, or ask according to user intent instead of silently discarding them.",
	"Keep subject short and imperative; use description only for durable context, task boundaries, or acceptance criteria that the subject cannot express. owner and metadata are compatibility fields, not default planning structure.",
];

export function registerTodoTool(pi: ExtensionAPI, store: TodoStore, config: TodoConfig = loadConfig()): void {
	const guidance = validateGuidanceFields(config.guidance);
	pi.registerTool({
		name: TOOL_NAME,
		label: TOOL_LABEL,
		description:
			"Manage a multi-item execution plan for meaningful multi-stage work. Actions: create, update, list, get, delete, and batch. Never start a one-task Todo cycle, regardless of risk, duration, or importance. A fresh or terminal cycle rejects top-level create and one-create batches; start with an atomic batch of at least two independently valuable create operations. Use top-level create only to add a newly discovered milestone to an active plan. Batch operations run in order and roll back atomically. When the current cycle is terminal, a qualifying batch rolls it over automatically.",
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
type TodoSettingId = TodoVisualSettingId | "resetTodos";

export interface TodoCommandOptions {
	getConfig: () => TodoVisualConfig;
	updateConfig: (config: TodoVisualConfig) => void;
	getState: () => TaskState;
	resetTodos: () => TaskState;
}

function maxWidgetLineValues(current: number): string[] {
	return [...new Set([...MAX_WIDGET_LINE_PRESETS, current])]
		.sort((left, right) => left - right)
		.map(String);
}

function visualSettingValue(config: TodoVisualConfig, id: TodoVisualSettingId): string {
	return id === "statusIcons" ? config.statusIcons : String(config.maxWidgetLines);
}

function taskCountLabel(count: number): string {
	return `${count} ${count === 1 ? "task" : "tasks"}`;
}

function resetConfirmation(
	state: TaskState,
	theme: Theme,
	done: (selectedValue?: string) => void,
) {
	const activeCount = state.tasks.filter(
		(task) => task.status === "pending" || task.status === "in_progress",
	).length;
	const container = new Container();
	container.addChild(
		new Text(
			theme.fg("accent", theme.bold(`Reset ${taskCountLabel(state.tasks.length)}?`)),
			1,
			0,
		),
	);
	if (activeCount > 0) {
		container.addChild(
			new Text(
				theme.fg(
					"warning",
					`Warning: ${taskCountLabel(activeCount)} still pending or in progress will be removed.`,
				),
				1,
				0,
			),
		);
	}
	container.addChild(new Text(theme.fg("dim", "Task IDs remain monotonic and will not be reused."), 1, 0));

	const items: SelectItem[] = [
		{ value: "cancel", label: "Cancel", description: "Keep the current Todo state." },
	];
	if (state.tasks.length > 0) {
		items.push({
			value: "reset",
			label: "Reset current todos",
			description: `Clear ${taskCountLabel(state.tasks.length)} from this branch's live state.`,
		});
	}
	const selectList = new SelectList(items, items.length, {
		selectedPrefix: (text) => theme.fg("accent", text),
		selectedText: (text) => theme.fg("accent", text),
		description: (text) => theme.fg("muted", text),
		scrollInfo: (text) => theme.fg("dim", text),
		noMatch: (text) => theme.fg("warning", text),
	});
	selectList.onSelect = (item) => done(item.value === "reset" ? "confirmed" : undefined);
	selectList.onCancel = () => done(undefined);
	container.addChild(selectList);
	return {
		render: (width: number) => container.render(width),
		invalidate: () => container.invalidate(),
		handleInput: (data: string) => selectList.handleInput(data),
	};
}

function settingItems(config: TodoVisualConfig, options: TodoCommandOptions, theme: Theme): SettingItem[] {
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
		{
			id: "resetTodos",
			label: "Reset current todos",
			description: "Clear live Todo state after an explicit confirmation.",
			currentValue: taskCountLabel(options.getState().tasks.length),
			submenu: (_currentValue, done) => resetConfirmation(options.getState(), theme, done),
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
		description: "Configure the Todo widget or reset current todos",
		handler: async (_args, ctx) => {
			if (ctx.mode !== "tui") {
				ctx.ui.notify("/todo requires TUI mode", "error");
				return;
			}

			await ctx.ui.custom((tui, theme, _keybindings, done) => {
				let current = options.getConfig();
				const container = new Container();
				container.addChild(new Text(theme.fg("accent", theme.bold("Todo Settings")), 1, 0));
				container.addChild(new Text(theme.fg("dim", "Model guidance remains JSON-only."), 1, 0));

				let settingsList: SettingsList;
				settingsList = new SettingsList(
					settingItems(current, options, theme),
					5,
					getSettingsListTheme(),
					(id, newValue) => {
						const settingId = id as TodoSettingId;
						if (settingId === "resetTodos") {
							const count = options.getState().tasks.length;
							try {
								const reset = options.resetTodos();
								settingsList.updateValue(settingId, taskCountLabel(reset.tasks.length));
								ctx.ui.notify(`Reset ${taskCountLabel(count)}.`, "info");
							} catch (error) {
								settingsList.updateValue(settingId, taskCountLabel(count));
								ctx.ui.notify(`Failed to reset Todo state: ${errorMessage(error)}`, "error");
							}
							return;
						}

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
