/**
 * todo-overlay.ts — Persistent widget showing todo list above the editor.
 *
 * Lifecycle controller for Pi's `setWidget` contract: factory-form
 * registration in widgetContainerAbove, register-once + requestRender()
 * refresh, configurable collapse-not-scroll line budget (including heading,
 * summary, and trailing spacer), auto-hide when empty.
 *
 * Reads its injected store at render time — NEVER `replayFromBranch` from
 * `tool_execution_end` (branch is stale; `message_end` runs after).
 */

import type { ExtensionUIContext, Theme } from "@earendil-works/pi-coding-agent";
import { type TUI, truncateToWidth } from "@earendil-works/pi-tui";
import {
	loadConfig,
	resolveStatusIcons,
	resolveTodoVisualConfig,
	type StatusIcons,
	type TodoVisualConfig,
} from "./config.js";
import { formatStatusLabel, t } from "./state/i18n-bridge.js";
import { selectHasActive, selectOverlayLayout, selectTodoCounts } from "./state/selectors.js";
import type { TodoStore } from "./state/store.js";
import { formatOverlayTaskLine, statusIcon } from "./view/format.js";

const WIDGET_KEY = "rpiv-todos";
const NERD_FONT_ANIMATION_INTERVAL_MS = 300;

// English fallbacks for localized overlay chrome strings.
const OVERLAY_HEADING = "Todos";
const OVERLAY_MORE = "more";

export class TodoOverlay {
	private uiCtx: ExtensionUIContext | undefined;
	private widgetRegistered = false;
	private tui: TUI | undefined;
	private completedTaskIdsPendingHide = new Set<number>();
	private hiddenCompletedTaskIds = new Set<number>();
	private lastNextId: number | undefined;
	private lastGeneration: number | undefined;
	private animationTimer: ReturnType<typeof setInterval> | undefined;
	private inProgressFrameIndex = 0;
	private statusIcons: StatusIcons;
	private maxWidgetLines: number;

	constructor(
		private readonly store: TodoStore,
		config: TodoVisualConfig = resolveTodoVisualConfig(loadConfig()),
	) {
		const visual = resolveTodoVisualConfig(config);
		this.statusIcons = resolveStatusIcons(visual.statusIcons);
		this.maxWidgetLines = visual.maxWidgetLines;
	}

	setConfig(config: TodoVisualConfig): void {
		const visual = resolveTodoVisualConfig(config);
		const nextStatusIcons = resolveStatusIcons(visual.statusIcons);
		if (nextStatusIcons !== this.statusIcons) this.stopAnimation();
		this.statusIcons = nextStatusIcons;
		this.maxWidgetLines = visual.maxWidgetLines;
		this.update();
	}

	setUICtx(ctx: ExtensionUIContext): void {
		// Identity-compare so repeat session_start handlers are idempotent;
		// on identity change (/reload) invalidate so update() re-registers.
		if (ctx !== this.uiCtx) {
			this.stopAnimation();
			this.uiCtx = ctx;
			this.widgetRegistered = false;
			this.tui = undefined;
		}
	}

	update(): void {
		if (!this.uiCtx) return;
		const snapshot = this.getSnapshot();
		const visible = this.selectOverlayTasks(snapshot);

		if (visible.length === 0) {
			this.stopAnimation();
			if (this.widgetRegistered) {
				this.uiCtx.setWidget(WIDGET_KEY, undefined);
				this.widgetRegistered = false;
				this.tui = undefined;
			}
			return;
		}

		this.syncAnimation(visible.some((task) => task.status === "in_progress"));

		if (!this.widgetRegistered) {
			this.uiCtx.setWidget(
				WIDGET_KEY,
				(tui, theme) => {
					this.tui = tui;
					return {
						render: (width: number) => this.renderWidget(theme, width),
						invalidate: () => {
							this.stopAnimation();
							this.widgetRegistered = false;
							this.tui = undefined;
						},
					};
				},
				{ placement: "aboveEditor" },
			);
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	resetCompletedDisplayState(): void {
		this.completedTaskIdsPendingHide.clear();
		this.hiddenCompletedTaskIds.clear();
		this.lastNextId = undefined;
		this.lastGeneration = undefined;
	}

	hideCompletedTasksFromPreviousTurn(): void {
		if (this.completedTaskIdsPendingHide.size === 0) return;
		for (const taskId of this.completedTaskIdsPendingHide) {
			this.hiddenCompletedTaskIds.add(taskId);
		}
		this.completedTaskIdsPendingHide.clear();
		this.tui?.requestRender();
	}

	private getSnapshot() {
		const state = this.store.getState();
		if (
			(this.lastNextId !== undefined && state.nextId < this.lastNextId) ||
			(this.lastGeneration !== undefined && state.generation !== this.lastGeneration)
		) {
			this.resetCompletedDisplayState();
		}
		this.lastNextId = state.nextId;
		this.lastGeneration = state.generation;
		const completedTaskIds = new Set(
			state.tasks.filter((task) => task.status === "completed").map((task) => task.id),
		);
		for (const taskId of this.completedTaskIdsPendingHide) {
			if (!completedTaskIds.has(taskId)) this.completedTaskIdsPendingHide.delete(taskId);
		}
		for (const taskId of this.hiddenCompletedTaskIds) {
			if (!completedTaskIds.has(taskId)) this.hiddenCompletedTaskIds.delete(taskId);
		}
		return { ...state, tasks: [...state.tasks] };
	}

	private selectOverlayTasks(snapshot: ReturnType<TodoOverlay["getSnapshot"]>) {
		return snapshot.tasks.filter((task) => task.status !== "deleted" && !this.shouldHideCompletedTask(task));
	}

	private shouldHideCompletedTask(task: ReturnType<TodoOverlay["getSnapshot"]>["tasks"][number]): boolean {
		return task.status === "completed" && this.hiddenCompletedTaskIds.has(task.id);
	}

	private renderWidget(theme: Theme, width: number): string[] {
		const snapshot = this.getSnapshot();
		const overlayTasks = this.selectOverlayTasks(snapshot);
		if (overlayTasks.length === 0) {
			this.stopAnimation();
			return [];
		}

		const hasInProgress = overlayTasks.some((task) => task.status === "in_progress");
		this.syncAnimation(hasInProgress);
		const inProgressFrame = this.currentInProgressFrame();
		const overlayState = { ...snapshot, tasks: overlayTasks };
		const truncate = (line: string): string => truncateToWidth(line, width, "…");
		const counts = selectTodoCounts(overlayState);
		const hasActive = selectHasActive(overlayState);

		const headingColor = hasActive ? "accent" : "dim";
		const headingIcon = theme.fg(headingColor, this.statusIcons.heading);
		const headingText = `${t("overlay.heading", OVERLAY_HEADING)} (${counts.completed}/${counts.total})`;
		const heading = truncate(`${headingIcon} ${theme.fg(headingColor, headingText)}`);

		const lines: string[] = [heading];
		// Heading and the trailing blank separator consume two rows. The selector
		// reserves one of the remaining rows for an overflow summary when needed.
		const layout = selectOverlayLayout(overlayState, this.maxWidgetLines - 2);
		for (const task of layout.visible) {
			lines.push(
				truncate(
					`${theme.fg("dim", "├─")} ${formatOverlayTaskLine(task, theme, this.statusIcons, inProgressFrame)}`,
				),
			);
		}

		const newlyDisplayedCompletedTaskIds = overlayTasks
			.filter(
				(task) =>
					task.status === "completed" &&
					!this.completedTaskIdsPendingHide.has(task.id) &&
					!this.hiddenCompletedTaskIds.has(task.id),
			)
			.map((task) => task.id);
		for (const taskId of newlyDisplayedCompletedTaskIds) {
			this.completedTaskIdsPendingHide.add(taskId);
		}

		if (layout.hiddenCompleted === 0 && layout.hiddenPending === 0) {
			const last = lines.length - 1;
			lines[last] = lines[last].replace("├─", "└─");
			return this.withTrailingSpacer(lines);
		}

		const totalHidden = layout.hiddenCompleted + layout.hiddenPending;
		const overflowParts: string[] = [];
		if (layout.hiddenCompleted > 0) overflowParts.push(`${layout.hiddenCompleted} ${formatStatusLabel("completed")}`);
		if (layout.hiddenPending > 0) overflowParts.push(`${layout.hiddenPending} ${formatStatusLabel("pending")}`);
		const more = t("overlay.more", OVERLAY_MORE);
		const summary =
			overflowParts.length > 0 ? `+${totalHidden} ${more} (${overflowParts.join(", ")})` : `+${totalHidden} ${more}`;
		lines.push(truncate(`${theme.fg("dim", "└─")} ${theme.fg("dim", summary)}`));
		return this.withTrailingSpacer(lines);
	}

	/**
	 * Append a trailing blank line so the overlay isn't flush against the
	 * editor box. Pi's host adds a leading spacer above the widget but none
	 * below, which leaves the last "└─" row (or the "+N more" summary) glued
	 * to the input box. The empty string gives the "Todos" panel a little
	 * breathing room.
	 */
	private withTrailingSpacer(lines: string[]): string[] {
		if (lines.length === 0) return lines;
		lines.push("");
		return lines;
	}

	private currentInProgressFrame(): string {
		return this.statusIcons.inProgressFrames[this.inProgressFrameIndex % this.statusIcons.inProgressFrames.length]!;
	}

	private syncAnimation(hasInProgress: boolean): void {
		if (!this.tui || !hasInProgress || this.statusIcons.inProgressFrames.length < 2) {
			this.stopAnimation();
			return;
		}
		if (this.animationTimer) return;
		this.animationTimer = setInterval(() => {
			this.inProgressFrameIndex = (this.inProgressFrameIndex + 1) % this.statusIcons.inProgressFrames.length;
			this.tui?.requestRender();
		}, NERD_FONT_ANIMATION_INTERVAL_MS);
		this.animationTimer.unref?.();
	}

	private stopAnimation(): void {
		if (this.animationTimer) clearInterval(this.animationTimer);
		this.animationTimer = undefined;
		this.inProgressFrameIndex = 0;
	}

	dispose(): void {
		this.stopAnimation();
		if (this.uiCtx) this.uiCtx.setWidget(WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		this.uiCtx = undefined;
		this.resetCompletedDisplayState();
	}
}
