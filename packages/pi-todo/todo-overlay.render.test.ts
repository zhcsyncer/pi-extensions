import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import type { StatusIconPreset } from "./config.js";
import { createMockPi, createMockUI } from "./test-fixtures.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTodoStore, registerTodoTool, type TaskAction } from "./todo.js";
import { TodoOverlay } from "./todo-overlay.js";

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

function completeActions(id: number): Array<{ action: TaskAction; [k: string]: unknown }> {
	return [
		{ action: "update", id, status: "in_progress" },
		{ action: "update", id, status: "completed" },
	];
}

async function setup(
	actions: Array<{ action: TaskAction; [k: string]: unknown }>,
	statusIcons: StatusIconPreset = "ascii",
	maxWidgetLines = 13,
) {
	const { pi, captured } = createMockPi();
	const store = createTodoStore();
	registerTodoTool(pi, store);
	const tool = captured.tools.get("todo")!;
	for (const p of actions) {
		await tool.execute?.("tc", p as never, undefined as never, undefined as never, {} as never);
	}
	const ui = createMockUI() as unknown as ExtensionUIContext;
	const overlay = new TodoOverlay(store, { statusIcons, maxWidgetLines });
	overlay.setUICtx(ui);
	overlay.update();
	const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
	const factory = setWidget.mock.calls[0][1] as (
		tui: { requestRender: () => void },
		theme: typeof identityTheme,
	) => { render: (w: number) => string[]; invalidate: () => void };
	const tui = { requestRender: vi.fn() };
	const widget = factory(tui, identityTheme);
	return { widget, tool, ui, overlay, tui };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("TodoOverlay — heading", () => {
	it("includes 'Todos (completed/total)' count", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			...completeActions(1),
		]);
		const lines = widget.render(200);
		expect(lines[0]).toContain("Todos (1/2)");
	});

	it("uses the static ASCII Todo icon regardless of task status", async () => {
		const pending = await setup([{ action: "create", subject: "pending" }]);
		expect(pending.widget.render(200)[0]).toContain("[T]");
		pending.overlay.dispose();

		const active = await setup([{ action: "create", subject: "active", status: "in_progress" }]);
		expect(active.widget.render(200)[0]).toContain("[T]");
		expect(active.widget.render(200)[0]).not.toContain("[>]");
		active.overlay.dispose();
	});

	it("uses the configured static Nerd Font Todo icon in the heading", async () => {
		const { widget, overlay } = await setup(
			[{ action: "create", subject: "active", status: "in_progress" }],
			"nerd-font",
		);
		expect(widget.render(200)[0]).toContain("󰝖");
		overlay.dispose();
	});
});

describe("TodoOverlay — natural-order rendering (no overflow)", () => {
	it("renders one line per visible task plus heading, last row uses '└─'", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a" },
			{ action: "create", subject: "b" },
			{ action: "create", subject: "c" },
		]);
		const lines = widget.render(200);
		expect(lines).toHaveLength(5); // heading + 3 + trailing spacer
		expect(lines[1]).toContain("├─");
		expect(lines[2]).toContain("├─");
		expect(lines[3]).toContain("└─");
		expect(lines[4]).toBe(""); // trailing spacer below the panel
	});

	it("omits deleted tasks from the rendered output", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "visible" },
			{ action: "create", subject: "gone" },
			{ action: "update", id: 2, status: "deleted" },
		]);
		const out = widget.render(200).join("\n");
		expect(out).toContain("visible");
		expect(out).not.toContain("gone");
	});
});

describe("TodoOverlay — per-task formatting", () => {
	it("pending task uses the default ASCII icon", async () => {
		const { widget } = await setup([{ action: "create", subject: "pending-task" }]);
		expect(widget.render(200)[1]).toContain("[ ]");
		expect(widget.render(200)[1]).toContain("pending-task");
	});

	it("in_progress task uses the default ASCII icon without duplicate text", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "do it" },
			{ action: "update", id: 1, status: "in_progress" },
		]);
		const line = widget.render(200)[1];
		expect(line).toContain("[>]");
		expect(line).toContain("do it");
	});

	it("uses the configured Unicode symbols", async () => {
		const { widget, overlay } = await setup(
			[{ action: "create", subject: "unicode", status: "in_progress" }],
			"unicode",
		);
		expect(widget.render(200)[1]).toContain("◉");
		overlay.dispose();
	});

	it("animates Nerd Font progress frames while a task is in progress", async () => {
		vi.useFakeTimers();
		try {
			const { widget, overlay, tui, tool } = await setup(
				[{ action: "create", subject: "animated", status: "in_progress" }],
				"nerd-font",
			);
			expect(widget.render(200)[1]).toContain("󰪞");
			vi.advanceTimersByTime(299);
			expect(tui.requestRender).not.toHaveBeenCalled();
			vi.advanceTimersByTime(1);
			expect(tui.requestRender).toHaveBeenCalled();
			expect(widget.render(200)[1]).toContain("󰪟");
			await tool.execute?.(
				"tc",
				{ action: "update", id: 1, status: "completed" } as never,
				undefined as never,
				undefined as never,
				{} as never,
			);
			overlay.update();
			expect(vi.getTimerCount()).toBe(0);
			overlay.dispose();
		} finally {
			vi.useRealTimers();
		}
	});

	it("stops and restarts icon animation when presets change", async () => {
		vi.useFakeTimers();
		try {
			const { overlay } = await setup(
				[{ action: "create", subject: "active", status: "in_progress" }],
				"ascii",
			);
			expect(vi.getTimerCount()).toBe(0);

			overlay.setConfig({ statusIcons: "nerd-font", maxWidgetLines: 13 });
			expect(vi.getTimerCount()).toBe(1);
			overlay.setConfig({ statusIcons: "unicode", maxWidgetLines: 13 });
			expect(vi.getTimerCount()).toBe(0);
			overlay.setConfig({ statusIcons: "nerd-font", maxWidgetLines: 13 });
			expect(vi.getTimerCount()).toBe(1);

			overlay.dispose();
			expect(vi.getTimerCount()).toBe(0);
		} finally {
			vi.useRealTimers();
		}
	});

	it("completed task stays visible until the next agent turn starts", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "done" },
			...completeActions(1),
		]);
		const firstRender = widget.render(200);
		expect(firstRender[1]).toContain("[x]");
		expect(firstRender[1]).toContain("done");
		expect(widget.render(200)[1]).toContain("done");
		overlay.hideCompletedTasksFromPreviousTurn();
		expect(widget.render(200)).toEqual([]);
	});

	it("does not reset completed-task hiding when visual config changes", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "done" },
			...completeActions(1),
		]);
		expect(widget.render(200).join("\n")).toContain("done");
		overlay.hideCompletedTasksFromPreviousTurn();
		expect(widget.render(200)).toEqual([]);

		overlay.setConfig({ statusIcons: "unicode", maxWidgetLines: 4 });

		expect(widget.render(200)).toEqual([]);
	});
});

describe("TodoOverlay — ordered task rows", () => {
	it("renders subjects in store order without dependency or id chrome", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "first" },
			{ action: "create", subject: "second" },
		]);
		const out = widget.render(200).join("\n");
		expect(out.indexOf("first")).toBeLessThan(out.indexOf("second"));
		expect(out).not.toMatch(/#\d/);
		expect(out).not.toContain("⛓");
	});
});

describe("TodoOverlay — overflow collapse", () => {
	it("drops completed first when dropping is enough", async () => {
		// 12 total = 8 pending + 4 completed. budget=10. All pending fit,
		// plus 2 of the 4 completed (in natural order). 2 completed hidden.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 8; i++) actions.push({ action: "create", subject: `p${i}` });
		for (let i = 9; i <= 12; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push(...completeActions(i));
		}
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		// heading + 10 visible + 1 summary + trailing spacer = 13
		expect(lines).toHaveLength(13);
		// All pending present
		for (let i = 1; i <= 8; i++) expect(lines.join("\n")).toContain(`p${i}`);
		// Last row is the trailing spacer; the summary sits just above it
		expect(lines[lines.length - 1]).toBe("");
		expect(lines[lines.length - 2]).toContain("+2 more");
		expect(lines[lines.length - 2]).toContain("2 completed");
	});

	it("truncates pending tail when dropping all completed isn't enough", async () => {
		// 12 pending tasks → budget=10 → visible first 10, 2 pending truncated.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 12; i++) actions.push({ action: "create", subject: `t${i}` });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		expect(lines[lines.length - 1]).toBe("");
		const summary = lines[lines.length - 2];
		expect(summary).toContain("+2 more");
		expect(summary).toContain("2 pending");
		expect(summary).not.toContain("completed");
	});

	it("summary contains both 'completed' and 'pending' when mixed overflow", async () => {
		// 12 pending + 3 completed = 15 total. A 10-task admission
		// budget keeps the first 10 pending and hides 2 pending + 3 completed.
		// Summary: "+5 more (3 completed, 2 pending)".
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 12; i++) actions.push({ action: "create", subject: `p${i}` });
		for (let i = 13; i <= 15; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push(...completeActions(i));
		}
		const { widget } = await setup(actions);
		// Last line is the trailing spacer, so the summary is the second-to-last.
		const summary = widget.render(200).slice(-2)[0];
		expect(summary).toContain("+5 more");
		expect(summary).toContain("3 completed");
		expect(summary).toContain("2 pending");
	});

	it("hides overflowed completed tasks on the next agent turn too", async () => {
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 11; i++) actions.push({ action: "create", subject: `p${i}` });
		for (let i = 12; i <= 16; i++) {
			actions.push({ action: "create", subject: `c${i}` });
			actions.push(...completeActions(i));
		}
		const { widget, overlay } = await setup(actions);
		const beforeNextTurn = widget.render(200).join("\n");
		expect(beforeNextTurn).toContain("Todos (5/16)");
		expect(beforeNextTurn).toContain("+6 more");
		expect(beforeNextTurn).toContain("5 completed");
		overlay.hideCompletedTasksFromPreviousTurn();
		const afterNextTurn = widget.render(200).join("\n");
		expect(afterNextTurn).toContain("Todos (0/11)");
		expect(afterNextTurn).toContain("p11");
		expect(afterNextTurn).not.toContain("+1 more");
		expect(afterNextTurn).not.toContain("completed");
	});

	it("does not engage overflow at exactly 11 visible tasks", async () => {
		// 11 tasks → all fit (heading + 11 + trailing spacer = 13). No summary row.
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 11; i++) actions.push({ action: "create", subject: `t${i}` });
		const { widget } = await setup(actions);
		const lines = widget.render(200);
		expect(lines).toHaveLength(13);
		// Last row is the trailing spacer; the row above is the last task row
		expect(lines[lines.length - 1]).toBe("");
		expect(lines[lines.length - 2]).not.toContain("+");
		expect(lines[lines.length - 2]).toContain("└─");
	});

	it.each([4, 7, 13])("never renders more than maxWidgetLines=%i", async (maxWidgetLines) => {
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 20; i++) actions.push({ action: "create", subject: `t${i}` });
		const { widget } = await setup(actions, "ascii", maxWidgetLines);

		expect(widget.render(200).length).toBeLessThanOrEqual(maxWidgetLines);
	});

	it("admits a later-created in-progress task before earlier pending tasks", async () => {
		const actions: Array<{ action: TaskAction; [k: string]: unknown }> = [];
		for (let i = 1; i <= 8; i++) actions.push({ action: "create", subject: `pending-${i}` });
		actions.push({ action: "update", id: 8, status: "in_progress" });
		const { widget } = await setup(actions, "ascii", 4);
		const output = widget.render(200).join("\n");

		expect(output).toContain("pending-8");
		expect(output).not.toContain("pending-1");
		expect(output).toContain("7 pending");
	});
});

describe("TodoOverlay — width truncation", () => {
	it("renders without throwing at small widths", async () => {
		const { widget } = await setup([
			{ action: "create", subject: "a very long subject that would overflow a narrow column" },
		]);
		expect(() => widget.render(20)).not.toThrow();
	});

	it("drops completed tasks from counts after the next agent turn starts", async () => {
		const { widget, overlay } = await setup([
			{ action: "create", subject: "done" },
			{ action: "create", subject: "next" },
			...completeActions(1),
		]);
		expect(widget.render(200).join("\n")).toContain("Todos (1/2)");
		const secondRender = widget.render(200).join("\n");
		expect(secondRender).toContain("Todos (1/2)");
		expect(secondRender).toContain("next");
		expect(secondRender).toContain("done");
		overlay.hideCompletedTasksFromPreviousTurn();
		const hiddenRender = widget.render(200).join("\n");
		expect(hiddenRender).toContain("Todos (0/1)");
		expect(hiddenRender).toContain("next");
		expect(hiddenRender).not.toContain("done");
	});

	it("re-renders reflect live state changes without re-registering", async () => {
		const { widget, tool } = await setup([{ action: "create", subject: "first" }]);
		const out1 = widget.render(200).join("\n");
		expect(out1).toContain("first");
		await tool.execute?.(
			"tc",
			{ action: "create", subject: "second" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		const out2 = widget.render(200).join("\n");
		expect(out2).toContain("first");
		expect(out2).toContain("second");
	});
});
