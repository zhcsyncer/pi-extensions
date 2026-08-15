import type { Component } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";

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
import { buildSessionEntries, createMockCtx, createMockPi, makeTheme, makeTodoToolResult } from "./test-fixtures.js";
import registerTodo from "./index.js";
import { replayFromBranch, TODO_STATE_CUSTOM_TYPE } from "./state/replay.js";
import type { ResetDetailsV2 } from "./tool/types.js";

function runResetUI(ctx: ReturnType<typeof createMockCtx>): void {
	const custom = ctx.ui.custom as unknown as ReturnType<typeof vi.fn>;
	custom.mockImplementation(async (factory: (...args: unknown[]) => Component) => {
		const component = factory({ requestRender: vi.fn() }, makeTheme(), {}, vi.fn());
		component.handleInput?.("\x1b[B");
		component.handleInput?.("\x1b[B");
		component.handleInput?.("\r");
		component.handleInput?.("\x1b[B");
		component.handleInput?.("\r");
	});
}

describe("/todo reset integration", () => {
	it("persists a branch checkpoint, keeps nextId monotonic, and removes the widget immediately", async () => {
		const { pi, captured } = createMockPi();
		registerTodo(pi);
		const tool = captured.tools.get("todo")!;
		const command = captured.commands.get("todo")!;
		const ctx = createMockCtx({ hasUI: true, mode: "tui" });
		await captured.events.get("session_start")?.[0]?.({ reason: "startup" } as never, ctx as never);

		const created = await tool.execute?.(
			"tc",
			{
				action: "batch",
				operations: [
					{ action: "create", subject: "active", status: "in_progress" },
					{ action: "create", subject: "pending" },
				],
			} as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		await captured.events.get("tool_execution_end")?.[0]?.(
			{ toolName: "todo", isError: false } as never,
			ctx as never,
		);
		const setWidget = ctx.ui.setWidget as unknown as ReturnType<typeof vi.fn>;
		expect(setWidget).toHaveBeenCalledTimes(1);

		runResetUI(ctx);
		await command.handler("", ctx as never);

		expect(captured.entries).toHaveLength(1);
		expect(captured.entries[0]?.customType).toBe(TODO_STATE_CUSTOM_TYPE);
		const reset = captured.entries[0]?.data as ResetDetailsV2;
		expect(reset).toEqual({
			schemaVersion: 2,
			kind: "checkpoint",
			action: "reset",
			state: { tasks: [], nextId: 3, generation: 2, revision: 2 },
		});
		expect(setWidget).toHaveBeenCalledTimes(2);
		expect(setWidget.mock.calls[1]).toEqual(["rpiv-todos", undefined]);

		const afterResetCreate = await tool.execute?.(
			"after-reset",
			{
				action: "batch",
				operations: [
					{ action: "create", subject: "new", status: "in_progress" },
					{ action: "create", subject: "follow-up" },
				],
			} as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		expect(afterResetCreate?.content[0]).toMatchObject({ text: expect.stringContaining("Created #3") });

		const branchBeforeReset = buildSessionEntries([makeTodoToolResult(created?.details)]);
		const branchAfterReset = [
			...branchBeforeReset,
			{ type: "custom", customType: TODO_STATE_CUSTOM_TYPE, data: reset } as never,
		];
		expect(replayFromBranch(createMockCtx({ branch: branchBeforeReset })).tasks).toHaveLength(2);
		expect(replayFromBranch(createMockCtx({ branch: branchAfterReset }))).toEqual(reset.state);

		await captured.events.get("session_tree")?.[0]?.(
			{} as never,
			createMockCtx({ branch: branchBeforeReset }) as never,
		);
		const oldBranchList = await tool.execute?.(
			"old",
			{ action: "list" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		expect(oldBranchList?.content[0]).toMatchObject({ text: expect.stringContaining("active") });

		await captured.events.get("session_tree")?.[0]?.(
			{} as never,
			createMockCtx({ branch: branchAfterReset }) as never,
		);
		const resetBranchList = await tool.execute?.(
			"reset",
			{ action: "list" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		expect(resetBranchList?.content[0]).toMatchObject({ text: "No tasks" });
	});

	it("keeps live state and widget intact when the reset checkpoint cannot be persisted", async () => {
		const { pi, captured } = createMockPi();
		registerTodo(pi);
		const tool = captured.tools.get("todo")!;
		const command = captured.commands.get("todo")!;
		const ctx = createMockCtx({ hasUI: true, mode: "tui" });
		await captured.events.get("session_start")?.[0]?.({ reason: "startup" } as never, ctx as never);
		await tool.execute?.(
			"tc",
			{
				action: "batch",
				operations: [
					{ action: "create", subject: "must survive", status: "in_progress" },
					{ action: "create", subject: "keep too" },
				],
			} as never,
			undefined as never,
			undefined as never,
			ctx as never,
		);
		await captured.events.get("tool_execution_end")?.[0]?.(
			{ toolName: "todo", isError: false } as never,
			ctx as never,
		);
		(pi.appendEntry as unknown as ReturnType<typeof vi.fn>).mockImplementation(() => {
			throw new Error("session write failed");
		});

		runResetUI(ctx);
		await command.handler("", ctx as never);

		const listed = await tool.execute?.(
			"list",
			{ action: "list" } as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		expect(listed?.content[0]).toMatchObject({ text: expect.stringContaining("must survive") });
		expect(captured.entries).toEqual([]);
		expect(ctx.ui.setWidget).toHaveBeenCalledTimes(1);
		expect(ctx.ui.notify).toHaveBeenCalledWith(
			"Failed to reset Todo state: session write failed",
			"error",
		);
	});
});
