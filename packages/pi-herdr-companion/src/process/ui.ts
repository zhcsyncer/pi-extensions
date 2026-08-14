import type { Theme } from "@earendil-works/pi-coding-agent";
import {
	Editor,
	isKeyRelease,
	Key,
	matchesKey,
	truncateToWidth,
	visibleWidth,
} from "@earendil-works/pi-tui";
import type {
	ProcessListResult,
	ProcessManager,
	ProcessPaneState,
	ProcessRuntimeState,
} from "./manager.ts";
import type { ProcessEntry } from "./registry.ts";
import {
	claimTuiNavigation,
	releaseTuiNavigation,
	tuiNavigationOwnedByOther,
} from "./navigation-owner.ts";
import { formatProcessLocation, sanitizeProcessDisplayText } from "./render.ts";

const PROCESS_WIDGET_KEY = "herdr-processes";
const PROCESS_NAVIGATION_OWNER = "herdr-processes";
const MAX_PROCESS_ROWS = 5;
const REFRESH_MS = 2_000;

export interface ProcessUICtx {
	setWidget(
		key: string,
		content: undefined | ((tui: any, theme: Theme) => {
			render(width: number): string[];
			invalidate(): void;
			dispose?(): void;
		}),
		options?: { placement?: "aboveEditor" | "belowEditor" },
	): void;
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined): () => void;
	getEditorText(): string;
	notify(message: string, type?: "info" | "warning" | "error"): void;
	confirm(title: string, message: string): Promise<boolean>;
}

export type ProcessUIManager = Pick<ProcessManager, "list" | "stop" | "onChange">;

function processIdentity(entry: ProcessEntry): string {
	return entry.terminalId && entry.serverScope
		? `${entry.serverScope}:${entry.terminalId}`
		: `${entry.ownerSessionId}:${entry.ownerPaneId}:${entry.createdAt}:${entry.paneId}`;
}

function compact(value: string): string {
	return sanitizeProcessDisplayText(value).replace(/\s+/gu, " ").trim();
}

function rightAlign(left: string, right: string, width: number): string {
	const rightWidth = visibleWidth(right);
	const maxLeft = Math.max(0, width - rightWidth - 1);
	const clampedLeft = truncateToWidth(left, maxLeft, "…");
	const gap = Math.max(1, width - visibleWidth(clampedLeft) - rightWidth);
	return truncateToWidth(`${clampedLeft}${" ".repeat(gap)}${right}`, width, "…");
}

function stateIcon(state: ProcessRuntimeState, theme: Theme): string {
	switch (state) {
		case "running": return theme.fg("success", "●");
		case "starting": return theme.fg("warning", "◐");
		case "exited": return theme.fg("muted", "✓");
		case "unknown": return theme.fg("warning", "?");
	}
}

function agentLabel(pane: ProcessPaneState | undefined, theme: Theme): string {
	if (!pane?.agent && !pane?.hasAgentSession) return "";
	const agent = compact(pane.agent ?? "agent") || "agent";
	const status = pane.agentStatus ? `:${compact(pane.agentStatus)}` : "";
	return theme.fg("accent", ` ◆ ${agent}${status}`);
}

export class ProcessWidgetController {
	private ui: ProcessUICtx | undefined;
	private tui: any | undefined;
	private inputUnsubscribe: (() => void) | undefined;
	private managerUnsubscribe: (() => void) | undefined;
	private timer: ReturnType<typeof setInterval> | undefined;
	private widgetRegistered = false;
	private active = false;
	private selectedIndex = 0;
	private dialogOpen = false;
	private busy = false;
	private listed: ProcessListResult = { entries: [], stale: [], states: {}, panes: {} };
	private refreshPromise: Promise<void> | undefined;
	private refreshAgain = false;
	private lastRefreshError: string | undefined;

	constructor(private readonly manager: ProcessUIManager) {}

	setUICtx(ui: ProcessUICtx): void {
		if (ui === this.ui) return;
		this.detachUi();
		this.ui = ui;
		this.inputUnsubscribe = ui.onTerminalInput((data) => this.handleKey(data));
		this.managerUnsubscribe ??= this.manager.onChange(() => { void this.refresh(); });
		void this.refresh();
	}

	dispose(): void {
		this.detachUi();
		this.managerUnsubscribe?.();
		this.managerUnsubscribe = undefined;
	}

	private detachUi(): void {
		if (this.timer) clearInterval(this.timer);
		this.timer = undefined;
		this.inputUnsubscribe?.();
		this.inputUnsubscribe = undefined;
		if (this.ui && this.widgetRegistered) this.ui.setWidget(PROCESS_WIDGET_KEY, undefined);
		this.widgetRegistered = false;
		this.tui = undefined;
		releaseTuiNavigation(PROCESS_NAVIGATION_OWNER);
		this.active = false;
		this.dialogOpen = false;
		this.busy = false;
		this.ui = undefined;
	}

	async refresh(): Promise<void> {
		if (!this.ui) return;
		if (this.refreshPromise) {
			this.refreshAgain = true;
			return this.refreshPromise;
		}
		const selectedIdentity = this.selectedEntry()
			? processIdentity(this.selectedEntry() as ProcessEntry)
			: undefined;
		const run = this.manager.list()
			.then((listed) => {
				this.listed = listed;
				this.lastRefreshError = undefined;
				if (selectedIdentity) {
					const nextIndex = listed.entries.findIndex((entry) => processIdentity(entry) === selectedIdentity);
					if (nextIndex >= 0) this.selectedIndex = nextIndex;
				}
				this.clampSelection();
				this.updateWidget();
			})
			.catch((error: unknown) => {
				this.lastRefreshError = error instanceof Error ? error.message : String(error);
				this.updateWidget();
			});
		this.refreshPromise = run.finally(() => {
			this.refreshPromise = undefined;
			if (this.refreshAgain) {
				this.refreshAgain = false;
				void this.refresh();
			}
		});
		return this.refreshPromise;
	}

	private ensureTimer(): void {
		if (this.timer || this.listed.entries.length === 0) return;
		this.timer = setInterval(() => { void this.refresh(); }, REFRESH_MS);
		this.timer.unref?.();
	}

	private updateWidget(): void {
		if (!this.ui) return;
		const visible = this.listed.entries.length > 0;
		if (!visible) {
			if (this.widgetRegistered) this.ui.setWidget(PROCESS_WIDGET_KEY, undefined);
			this.widgetRegistered = false;
			this.tui = undefined;
			releaseTuiNavigation(PROCESS_NAVIGATION_OWNER);
			this.active = false;
			this.selectedIndex = 0;
			if (this.timer) clearInterval(this.timer);
			this.timer = undefined;
			return;
		}
		this.ensureTimer();
		if (!this.widgetRegistered) {
			this.ui.setWidget(PROCESS_WIDGET_KEY, (tui, theme) => {
				this.tui = tui;
				return {
					render: (width: number) => this.render(width, theme),
					invalidate: () => {},
				};
			}, { placement: "belowEditor" });
			this.widgetRegistered = true;
		} else {
			this.tui?.requestRender();
		}
	}

	private editorHasFocus(): boolean {
		const focused = (this.tui as { focusedComponent?: unknown } | undefined)?.focusedComponent;
		return focused == null || focused instanceof Editor;
	}

	handleKey(data: string): { consume?: boolean; data?: string } | undefined {
		if (!this.ui || isKeyRelease(data) || this.dialogOpen) return undefined;
		if (tuiNavigationOwnedByOther(PROCESS_NAVIGATION_OWNER)) {
			this.deactivate();
			return undefined;
		}
		if (!this.editorHasFocus()) {
			this.deactivate();
			return undefined;
		}
		if (this.ui.getEditorText() !== "") {
			this.deactivate();
			return undefined;
		}
		if (!this.active) {
			if (matchesKey(data, Key.right) && this.listed.entries.length > 0 &&
				claimTuiNavigation(PROCESS_NAVIGATION_OWNER)) {
				this.active = true;
				this.selectedIndex = 0;
				this.updateWidget();
				return { consume: true };
			}
			return undefined;
		}
		if (matchesKey(data, Key.down)) {
			this.selectedIndex = Math.min(this.listed.entries.length - 1, this.selectedIndex + 1);
			this.updateWidget();
			return { consume: true };
		}
		if (matchesKey(data, Key.up)) {
			this.selectedIndex = Math.max(0, this.selectedIndex - 1);
			this.updateWidget();
			return { consume: true };
		}
		if (matchesKey(data, Key.escape)) {
			this.deactivate();
			return { consume: true };
		}
		if (data === "s") {
			void this.stopSelected();
			return { consume: true };
		}
		this.deactivate();
		return undefined;
	}

	private deactivate(): void {
		releaseTuiNavigation(PROCESS_NAVIGATION_OWNER);
		if (!this.active) return;
		this.active = false;
		this.updateWidget();
	}

	private clampSelection(): void {
		this.selectedIndex = Math.max(0, Math.min(this.selectedIndex, this.listed.entries.length - 1));
		if (this.listed.entries.length === 0) this.selectedIndex = 0;
	}

	private selectedEntry(): ProcessEntry | undefined {
		return this.listed.entries[this.selectedIndex];
	}

	private async stopSelected(): Promise<void> {
		if (this.busy || !this.ui) return;
		const ui = this.ui;
		this.busy = true;
		this.dialogOpen = true;
		this.updateWidget();
		try {
			await this.refresh();
			if (this.ui !== ui) return;
			const entry = this.selectedEntry();
			if (!entry) return;
			const pane = this.listed.panes[entry.paneId];
			const agentWarning = pane?.agent || pane?.hasAgentSession
				? `\n\nThis pane contains a ${compact(pane.agent ?? "coding")} agent session${pane.agentStatus ? ` (${compact(pane.agentStatus)})` : ""}. Stopping it closes that session.`
				: "";
			const confirmed = await ui.confirm(
				"Stop managed process?",
				`Stop “${compact(entry.label)}” and close owned pane ${formatProcessLocation(entry)}?${agentWarning}`,
			);
			if (!confirmed) return;
			const stopped = await this.manager.stop(entry.terminalId ?? entry.label);
			if (this.ui === ui) ui.notify(`Stopped “${compact(stopped.label)}” and closed ${stopped.paneId}.`, "info");
			await this.refresh();
		} catch (error) {
			this.ui?.notify(`Could not stop managed process: ${error instanceof Error ? error.message : String(error)}`, "error");
		} finally {
			this.dialogOpen = false;
			this.busy = false;
			this.updateWidget();
		}
	}

	private render(width: number, theme: Theme): string[] {
		if (width <= 0 || this.listed.entries.length === 0) return [];
		const hint = this.busy
			? "working…"
			: this.active
				? "↑↓ select · s stop · esc back"
				: "→ manage Herdr processes";
		const lines = [truncateToWidth(`  ${theme.fg("dim", hint)}`, width, "…"), ""];
		const visible = Math.min(MAX_PROCESS_ROWS, this.listed.entries.length);
		const start = this.selectedIndex < visible ? 0 : this.selectedIndex - visible + 1;
		if (start > 0) lines.push(rightAlign("", theme.fg("dim", `↑ ${start} more`), width));
		for (let index = start; index < start + visible; index += 1) {
			const entry = this.listed.entries[index];
			if (!entry) continue;
			const state = this.listed.states[entry.paneId] ?? "unknown";
			const prefix = this.active && index === this.selectedIndex
				? theme.fg("accent", "›")
				: " ";
			const left = `  ${prefix} ${stateIcon(state, theme)} ${theme.fg("muted", compact(entry.label))}${agentLabel(this.listed.panes[entry.paneId], theme)}`;
			const right = theme.fg("dim", `${state} · ${formatProcessLocation(entry)}`);
			lines.push(rightAlign(left, right, width));
		}
		const hiddenBelow = this.listed.entries.length - (start + visible);
		if (hiddenBelow > 0) lines.push(rightAlign("", theme.fg("dim", `↓ ${hiddenBelow} more`), width));
		if (this.lastRefreshError) {
			lines.push(truncateToWidth(theme.fg("warning", `  ? refresh: ${compact(this.lastRefreshError)}`), width, "…"));
		}
		return lines;
	}
}
