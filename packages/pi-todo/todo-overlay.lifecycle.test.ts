import type { ExtensionUIContext } from "@earendil-works/pi-coding-agent";
import { createMockPi, createMockUI, startCycle } from "./test-fixtures.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createTodoStore, registerTodoTool } from "./todo.js";
import { TodoOverlay } from "./todo-overlay.js";

const WIDGET_KEY = "rpiv-todos";

const identityTheme = {
	fg: (_c: string, s: string) => s,
	bg: (_c: string, s: string) => s,
	bold: (s: string) => s,
	strikethrough: (s: string) => s,
};

// Register the todo tool and seed its isolated store via real execute();
// this exercises the same mutation path production uses.
async function seed(captured: ReturnType<typeof createMockPi>["captured"], actions: unknown[]) {
	const tool = captured.tools.get("todo");
	if (!tool) throw new Error("todo tool not registered");
	for (const p of actions) {
		await tool.execute?.("tc", p as never, undefined as never, undefined as never, {} as never);
	}
	return tool;
}

function makeCtx() {
	return createMockUI() as unknown as ExtensionUIContext;
}

function registerTool() {
	const { pi, captured } = createMockPi();
	const store = createTodoStore();
	registerTodoTool(pi, store);
	return { captured, store };
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("TodoOverlay — lifecycle", () => {
	it("update() with no UI ctx bound is a no-op", () => {
		const store = createTodoStore();
		const overlay = new TodoOverlay(store);
		expect(() => overlay.update()).not.toThrow();
	});

	it("update() with empty todos does not register a widget", () => {
		const store = createTodoStore();
		const overlay = new TodoOverlay(store);
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		expect(ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});

	it("first update() with non-empty todos registers the widget exactly once", async () => {
		const { captured, store } = registerTool();
		await seed(captured, [startCycle(["a"])]);
		const overlay = new TodoOverlay(store);
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		expect(setWidget).toHaveBeenCalledTimes(1);
		expect(setWidget.mock.calls[0][0]).toBe(WIDGET_KEY);
		expect(typeof setWidget.mock.calls[0][1]).toBe("function");
		expect(setWidget.mock.calls[0][2]).toEqual({ placement: "aboveEditor" });
	});

	it("second update() after registration calls tui.requestRender instead of re-registering", async () => {
		const { captured, store } = registerTool();
		await seed(captured, [startCycle(["a"])]);
		const overlay = new TodoOverlay(store);
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		// Invoke the captured factory so overlay's internal `tui` ref is populated.
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0][1] as (
			tui: { requestRender: () => void },
			theme: typeof identityTheme,
		) => { render: (w: number) => string[]; invalidate: () => void };
		const tui = { requestRender: vi.fn() };
		factory(tui, identityTheme);
		overlay.update();
		expect(setWidget).toHaveBeenCalledTimes(1);
		expect(tui.requestRender).toHaveBeenCalledTimes(1);
	});

	it("transition non-empty → empty unregisters the widget", async () => {
		const { captured, store } = registerTool();
		const tool = await seed(captured, [startCycle(["a"])]);
		const overlay = new TodoOverlay(store);
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		await tool.execute?.("tc", { action: "delete", id: 1 } as never, undefined as never, undefined as never, {} as never);
		await tool.execute?.("tc", { action: "delete", id: 2 } as never, undefined as never, undefined as never, {} as never);
		overlay.update();
		expect(setWidget).toHaveBeenCalledTimes(2);
		expect(setWidget.mock.calls[1]).toEqual([WIDGET_KEY, undefined]);
	});

	it("empty → non-empty after empty transition re-registers", async () => {
		const { captured, store } = registerTool();
		const tool = await seed(captured, [startCycle(["a"])]);
		const overlay = new TodoOverlay(store);
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		await tool.execute?.("tc", { action: "delete", id: 1 } as never, undefined as never, undefined as never, {} as never);
		await tool.execute?.("tc", { action: "delete", id: 2 } as never, undefined as never, undefined as never, {} as never);
		overlay.update();
		await tool.execute?.(
			"tc",
			startCycle(["b"]) as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		overlay.update();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		// calls: register, unregister, re-register
		expect(setWidget).toHaveBeenCalledTimes(3);
		expect(typeof setWidget.mock.calls[2][1]).toBe("function");
	});

	it("setUICtx(same ctx) is idempotent", async () => {
		const { captured, store } = registerTool();
		await seed(captured, [startCycle(["a"])]);
		const overlay = new TodoOverlay(store);
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		expect(setWidget).toHaveBeenCalledTimes(1);
	});

	it("setUICtx(different ctx) resets cached registration; next update re-registers under the new ctx", async () => {
		const { captured, store } = registerTool();
		await seed(captured, [startCycle(["a"])]);
		const overlay = new TodoOverlay(store);
		const ui1 = makeCtx();
		overlay.setUICtx(ui1);
		overlay.update();
		const ui2 = makeCtx();
		overlay.setUICtx(ui2);
		overlay.update();
		expect(ui1.setWidget as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
		expect(ui2.setWidget as ReturnType<typeof vi.fn>).toHaveBeenCalledTimes(1);
	});

	it("dispose() unregisters the widget and clears ctx; later update() without setUICtx is a no-op", async () => {
		const { captured, store } = registerTool();
		await seed(captured, [startCycle(["a"])]);
		const overlay = new TodoOverlay(store);
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		overlay.dispose();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		expect(setWidget).toHaveBeenCalledTimes(2);
		expect(setWidget.mock.calls[1]).toEqual([WIDGET_KEY, undefined]);
		// Further updates without rebinding should not touch the mock.
		overlay.update();
		expect(setWidget).toHaveBeenCalledTimes(2);
	});

	it("factory invalidate() forces re-registration on next update()", async () => {
		const { captured, store } = registerTool();
		await seed(captured, [startCycle(["a"])]);
		const overlay = new TodoOverlay(store);
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0][1] as (
			tui: { requestRender: () => void },
			theme: typeof identityTheme,
		) => { render: (w: number) => string[]; invalidate: () => void };
		const widget = factory({ requestRender: vi.fn() }, identityTheme);
		widget.invalidate();
		overlay.update();
		expect(setWidget).toHaveBeenCalledTimes(2);
		expect(typeof setWidget.mock.calls[1][1]).toBe("function");
	});

	it("resetCompletedDisplayState() lets replayed completed tasks be shown once again", async () => {
		const { captured, store } = registerTool();
		await seed(captured, [
			startCycle(["done"]),
			{ action: "delete", id: 2 },
			{ action: "update", id: 1, status: "completed" },
		]);
		const overlay = new TodoOverlay(store);
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		const setWidget = ui.setWidget as ReturnType<typeof vi.fn>;
		const factory = setWidget.mock.calls[0][1] as (
			tui: { requestRender: () => void },
			theme: typeof identityTheme,
		) => { render: (w: number) => string[]; invalidate: () => void };
		const widget = factory({ requestRender: vi.fn() }, identityTheme);
		expect(widget.render(200).join("\n")).toContain("done");
		overlay.hideCompletedTasksFromPreviousTurn();
		expect(widget.render(200)).toEqual([]);
		overlay.resetCompletedDisplayState();
		expect(widget.render(200).join("\n")).toContain("done");
	});

	it("hideCompletedTasksFromPreviousTurn() is a no-op when nothing is pending hide", () => {
		const store = createTodoStore();
		const overlay = new TodoOverlay(store);
		expect(() => overlay.hideCompletedTasksFromPreviousTurn()).not.toThrow();
	});

	it("all-deleted todos count as empty (no widget)", async () => {
		const { captured, store } = registerTool();
		const tool = await seed(captured, [startCycle(["a"])]);
		await tool.execute?.(
			"tc",
			{ action: "update", id: 1, status: "deleted" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		await tool.execute?.(
			"tc",
			{ action: "update", id: 2, status: "deleted" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		const overlay = new TodoOverlay(store);
		const ui = makeCtx();
		overlay.setUICtx(ui);
		overlay.update();
		expect(ui.setWidget as ReturnType<typeof vi.fn>).not.toHaveBeenCalled();
	});
});
