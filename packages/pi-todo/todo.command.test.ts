import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { Component } from "@earendil-works/pi-tui";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TodoVisualConfig } from "./config.js";

vi.mock("@earendil-works/pi-coding-agent", async (importOriginal) => {
	const actual = await importOriginal<typeof import("@earendil-works/pi-coding-agent")>();
	return {
		...actual,
		getSettingsListTheme: () => ({
			label: (text: string) => text,
			value: (text: string) => text,
			description: (text: string) => text,
			cursor: ">",
			hint: (text: string) => text,
		}),
	};
});
import { createMockCtx, createMockPi, makeTheme } from "./test-fixtures.js";
import { registerTodoCommand } from "./todo.js";

const DEFAULT_VISUAL_CONFIG: TodoVisualConfig = {
	statusIcons: "ascii",
	maxWidgetLines: 13,
};

function setup(
	updateConfig: (config: TodoVisualConfig) => void = vi.fn(),
	initialConfig: TodoVisualConfig = DEFAULT_VISUAL_CONFIG,
) {
	const { pi, captured } = createMockPi();
	let config = initialConfig;
	registerTodoCommand(pi, {
		getConfig: () => config,
		updateConfig: (next) => {
			updateConfig(next);
			config = next;
		},
	});
	const registered = captured.commands.get("todo");
	if (!registered) throw new Error("/todo command not registered");
	const command = registered as unknown as {
		description?: string;
		handler: (args: string, ctx: ExtensionContext) => Promise<void>;
	};
	return { captured, command, getConfig: () => config };
}

function runCustomUI(ctx: ExtensionContext, onComponent: (component: Component) => void): void {
	const custom = ctx.ui.custom as unknown as ReturnType<typeof vi.fn>;
	custom.mockImplementation(async (factory: (...args: unknown[]) => Component) => {
		const component = factory(
			{ requestRender: vi.fn() },
			makeTheme(),
			{},
			vi.fn(),
		);
		onComponent(component);
		return undefined;
	});
}

afterEach(() => {
	vi.restoreAllMocks();
});

describe("/todo command", () => {
	it("registers /todo without retaining /todos", () => {
		const { captured, command } = setup();
		expect(command.description).toContain("widget");
		expect(captured.commands.has("todo")).toBe(true);
		expect(captured.commands.has("todos")).toBe(false);
	});

	it.each(["rpc", "json", "print"] as const)("rejects %s mode without opening custom UI", async (mode) => {
		const { command } = setup();
		const ctx = createMockCtx({ hasUI: true, mode });

		await command.handler("", ctx);

		expect(ctx.ui.custom).not.toHaveBeenCalled();
		expect(ctx.ui.notify).toHaveBeenCalledWith("/todo requires TUI mode", "error");
	});

	it("cycles a visual setting and saves the new runtime config", async () => {
		const save = vi.fn();
		const { command, getConfig } = setup(save);
		const ctx = createMockCtx({ hasUI: true, mode: "tui" });
		runCustomUI(ctx, (component) => component.handleInput?.("\r"));

		await command.handler("", ctx);

		expect(save).toHaveBeenCalledWith({ statusIcons: "unicode", maxWidgetLines: 13 });
		expect(getConfig()).toEqual({ statusIcons: "unicode", maxWidgetLines: 13 });
		expect(ctx.ui.notify).not.toHaveBeenCalled();
	});

	it("cycles maxWidgetLines independently from the icon preset", async () => {
		const save = vi.fn();
		const { command } = setup(save);
		const ctx = createMockCtx({ hasUI: true, mode: "tui" });
		runCustomUI(ctx, (component) => {
			component.handleInput?.("\x1b[B");
			component.handleInput?.("\r");
		});

		await command.handler("", ctx);

		expect(save).toHaveBeenCalledWith({ statusIcons: "ascii", maxWidgetLines: 20 });
	});

	it("keeps a legal custom maxWidgetLines value in the TUI choices", async () => {
		const { command } = setup(vi.fn(), { statusIcons: "ascii", maxWidgetLines: 17 });
		const ctx = createMockCtx({ hasUI: true, mode: "tui" });
		let rendered = "";
		runCustomUI(ctx, (component) => {
			rendered = component.render(100).join("\n");
		});

		await command.handler("", ctx);

		expect(rendered).toContain("17");
	});

	it("restores the displayed value and keeps runtime config when saving fails", async () => {
		const save = vi.fn(() => {
			throw new Error("disk full");
		});
		const { command, getConfig } = setup(save);
		const ctx = createMockCtx({ hasUI: true, mode: "tui" });
		let rendered = "";
		runCustomUI(ctx, (component) => {
			component.handleInput?.("\r");
			rendered = component.render(100).join("\n");
		});

		await command.handler("", ctx);

		expect(getConfig()).toEqual(DEFAULT_VISUAL_CONFIG);
		expect(rendered).toContain("ascii");
		expect(rendered).not.toContain("unicode");
		expect(ctx.ui.notify).toHaveBeenCalledWith("Failed to save Todo settings: disk full", "error");
	});
});
