import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ProcessListResult } from "../src/process/manager.ts";
import { PROCESS_OWNER, type ProcessEntry } from "../src/process/registry.ts";
import {
	ProcessWidgetController,
	type ProcessUICtx,
	type ProcessUIManager,
} from "../src/process/ui.ts";
import { claimTuiNavigation, releaseTuiNavigation } from "../src/process/navigation-owner.ts";

const theme = {
	fg: (_color: string, value: string) => value,
	bold: (value: string) => value,
} as Theme;

const RIGHT = "\u001b[C";
const LEFT = "\u001b[D";
const DOWN = "\u001b[B";
const UP = "\u001b[A";
const ESCAPE = "\u001b";

afterEach(() => {
	releaseTuiNavigation("herdr-processes");
	releaseTuiNavigation("subagents-fleet");
});

function entry(overrides: Partial<ProcessEntry> = {}): ProcessEntry {
	return {
		owner: PROCESS_OWNER,
		paneId: "w1:p2",
		terminalId: "term-dev",
		serverScope: "0123456789abcdef",
		workspaceId: "w1",
		tabId: "w1:t1",
		label: "dev",
		command: "pnpm dev",
		cwd: "/work",
		lifetime: "session",
		createdAt: "2026-08-11T00:00:00.000Z",
		ownerSessionId: "session-1",
		ownerPaneId: "w1:p1",
		shell: "bash",
		...overrides,
	};
}

function listed(entries = [entry()]): ProcessListResult {
	return {
		entries,
		stale: [],
		states: Object.fromEntries(entries.map((item) => [item.paneId, item.label === "dev" ? "running" : "exited"])),
		panes: Object.fromEntries(entries.map((item) => [item.paneId, {
			paneId: item.paneId,
			terminalId: item.terminalId,
			workspaceId: item.workspaceId,
			tabId: item.tabId,
			...(item.label === "dev" ? { agent: "pi", agentStatus: "idle", hasAgentSession: true } : { hasAgentSession: false }),
		}])),
	};
}

class FakeManager implements ProcessUIManager {
	current = listed();
	stopped: string[] = [];
	private listeners = new Set<() => void>();

	async list() { return this.current; }
	async stop(target: string) {
		this.stopped.push(target);
		const found = this.current.entries.find((item) => item.terminalId === target || item.label === target);
		if (!found) throw new Error("missing");
		this.current = listed(this.current.entries.filter((item) => item !== found));
		this.emit();
		return found;
	}
	onChange(listener: () => void) {
		this.listeners.add(listener);
		return () => this.listeners.delete(listener);
	}
	emit() { for (const listener of this.listeners) listener(); }
}

class FakeUI implements ProcessUICtx {
	editorText = "";
	handler: ((data: string) => { consume?: boolean; data?: string } | undefined) | undefined;
	widget: { key: string; content: any; placement?: string } | undefined;
	notifications: Array<{ message: string; type?: string }> = [];
	confirmations: Array<{ title: string; message: string }> = [];
	confirmResult = true;
	unsubscribed = 0;
	renders = 0;
	readonly tui: { focusedComponent?: unknown; requestRender(): void };

	constructor() {
		this.tui = { requestRender: () => { this.renders += 1; } };
	}

	setWidget(key: string, content: any, options?: { placement?: "aboveEditor" | "belowEditor" }) {
		this.widget = content === undefined ? undefined : { key, content, placement: options?.placement };
	}
	onTerminalInput(handler: (data: string) => { consume?: boolean; data?: string } | undefined) {
		this.handler = handler;
		return () => { this.unsubscribed += 1; this.handler = undefined; };
	}
	getEditorText() { return this.editorText; }
	notify(message: string, type?: "info" | "warning" | "error") { this.notifications.push({ message, type }); }
	async confirm(title: string, message: string) {
		this.confirmations.push({ title, message });
		return this.confirmResult;
	}
	render(width = 100): string[] {
		if (!this.widget) return [];
		const component = this.widget.content(this.tui, theme);
		return component.render(width);
	}
}

async function setup(entries?: ProcessEntry[]) {
	const manager = new FakeManager();
	if (entries) manager.current = listed(entries);
	const ui = new FakeUI();
	const controller = new ProcessWidgetController(manager);
	controller.setUICtx(ui);
	await controller.refresh();
	return { manager, ui, controller };
}

describe("ProcessWidgetController", () => {
	it("registers below the editor and renders live state, location, and agent session markers", async () => {
		const { ui, controller } = await setup();
		try {
			expect(ui.widget).toMatchObject({ key: "herdr-processes", placement: "belowEditor" });
			const lines = ui.render(54);
			const text = lines.join("\n");
			expect(text).toContain("→ manage Herdr processes");
			expect(text).toContain("dev ◆ pi:idle");
			expect(text).toContain("running · w1 · t1 · p2");
			expect(lines.every((line) => visibleWidth(line) <= 54)).toBe(true);
		} finally {
			controller.dispose();
		}
	});

	it("uses only right-arrow activation and never intercepts a non-empty editor or another focused UI", async () => {
		const { ui, controller } = await setup();
		try {
			ui.render();
			ui.editorText = "draft";
			expect(controller.handleKey(RIGHT)).toBeUndefined();
			ui.editorText = "";
			expect(controller.handleKey(LEFT)).toBeUndefined();
			expect(controller.handleKey(DOWN)).toBeUndefined();
			expect(claimTuiNavigation("subagents-fleet")).toBe(true);
			expect(controller.handleKey(RIGHT)).toBeUndefined();
			releaseTuiNavigation("subagents-fleet");
			ui.tui.focusedComponent = {};
			expect(controller.handleKey(RIGHT)).toBeUndefined();
			ui.tui.focusedComponent = undefined;
			expect(controller.handleKey(RIGHT)).toEqual({ consume: true });
			expect(ui.render().join("\n")).toContain("↑↓ select · s stop · esc back");
			expect(controller.handleKey(ESCAPE)).toEqual({ consume: true });
		} finally {
			controller.dispose();
		}
	});

	it("selects managed processes with arrows", async () => {
		const preview = entry({ paneId: "w2:p7", terminalId: "term-preview", workspaceId: "w2", tabId: "w2:t3", label: "preview" });
		const { ui, controller } = await setup([entry(), preview]);
		try {
			ui.render();
			controller.handleKey(RIGHT);
			expect(controller.handleKey(DOWN)).toEqual({ consume: true });
			expect(ui.render().join("\n")).toContain("› ✓ preview");
			expect(controller.handleKey(UP)).toEqual({ consume: true });
			expect(ui.render().join("\n")).toContain("› ● dev");
		} finally {
			controller.dispose();
		}
	});

	it("confirms ownership-safe stop and warns when the pane contains an agent session", async () => {
		const { manager, ui, controller } = await setup();
		try {
			ui.render();
			controller.handleKey(RIGHT);
			expect(controller.handleKey("s")).toEqual({ consume: true });
			await vi.waitFor(() => expect(ui.confirmations).toHaveLength(1));
			expect(ui.confirmations[0]?.message).toContain("contains a pi agent session (idle)");
			await vi.waitFor(() => expect(manager.stopped).toEqual(["term-dev"]));
			expect(ui.notifications.at(-1)).toMatchObject({ type: "info", message: expect.stringContaining("Stopped") });
			await vi.waitFor(() => expect(ui.widget).toBeUndefined());
		} finally {
			controller.dispose();
		}
	});

	it("preserves a selected terminal while refresh updates its workspace, tab, and pane address", async () => {
		const preview = entry({ paneId: "w1:p3", terminalId: "term-preview", label: "preview" });
		const { manager, ui, controller } = await setup([entry(), preview]);
		try {
			ui.render();
			controller.handleKey(RIGHT);
			controller.handleKey(DOWN);
			const moved = { ...preview, paneId: "w9:p4", workspaceId: "w9", tabId: "w9:t8" };
			manager.current = listed([entry(), moved]);
			manager.emit();
			await controller.refresh();
			const text = ui.render().join("\n");
			expect(text).toContain("› ✓ preview");
			expect(text).toContain("exited · w9 · t8 · p4");
		} finally {
			controller.dispose();
		}
	});

	it("cancels stop without changing ownership and disposes input and widget resources", async () => {
		const { manager, ui, controller } = await setup();
		ui.confirmResult = false;
		ui.render();
		controller.handleKey(RIGHT);
		controller.handleKey("s");
		await vi.waitFor(() => expect(ui.confirmations).toHaveLength(1));
		await vi.waitFor(() => expect(ui.render().join("\n")).not.toContain("working…"));
		expect(manager.stopped).toEqual([]);
		controller.dispose();
		expect(ui.unsubscribed).toBe(1);
		expect(ui.widget).toBeUndefined();
	});
});
