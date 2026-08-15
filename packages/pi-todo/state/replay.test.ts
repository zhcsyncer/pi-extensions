import { describe, expect, it } from "vitest";
import { buildSessionEntries, createMockCtx, makeTodoToolResult, makeUserMessage } from "../test-fixtures.js";
import type {
	MutationDetailsV2,
	ResetDetailsV2,
	Task,
	TaskDetailsV1,
} from "../tool/types.js";
import {
	isResetDetailsV2,
	isTaskDetails,
	replayFromBranch,
	TODO_STATE_CUSTOM_TYPE,
} from "./replay.js";
import type { TaskState } from "./state.js";

function buildBranch(details: unknown[]) {
	const messages = details.map((snapshot) => makeTodoToolResult(snapshot));
	return buildSessionEntries([makeUserMessage("hi"), ...messages]);
}

const taskFixture = (id: number, subject: string, extra: Partial<Task> = {}): Task => ({
	id,
	subject,
	status: "pending",
	...extra,
});

function v1(tasks: Task[], nextId: number, action: TaskDetailsV1["action"] = "create"): TaskDetailsV1 {
	return { schemaVersion: 1, action, params: {}, tasks, nextId };
}

function state(
	tasks: Task[],
	nextId: number,
	generation = 1,
	revision = 0,
): TaskState {
	return { tasks, nextId, generation, revision };
}

function checkpoint(liveState: TaskState): MutationDetailsV2 {
	return {
		schemaVersion: 2,
		kind: "checkpoint",
		action: "create",
		params: {},
		state: liveState,
	};
}

function customReset(liveState: TaskState) {
	const data: ResetDetailsV2 = {
		schemaVersion: 2,
		kind: "checkpoint",
		action: "reset",
		state: liveState,
	};
	return { type: "custom", customType: TODO_STATE_CUSTOM_TYPE, data } as never;
}

describe("V1/V2 replay envelope guards", () => {
	it("rejects null, primitives, and malformed objects", () => {
		for (const value of [null, undefined, "oops", 42, true, {}, { tasks: "x", nextId: 1 }]) {
			expect(isTaskDetails(value)).toBe(false);
		}
	});

	it("accepts legacy, V1, V2 checkpoint, and V2 query envelopes", () => {
		expect(isTaskDetails({ action: "clear", params: {}, tasks: [], nextId: 1 })).toBe(true);
		expect(isTaskDetails(v1([], 1))).toBe(true);
		expect(isTaskDetails(checkpoint(state([], 4, 2, 8)))).toBe(true);
		expect(isTaskDetails({ schemaVersion: 2, kind: "query", action: "list" })).toBe(true);
	});

	it("rejects unknown versions, actions, and malformed state rows", () => {
		expect(isTaskDetails({ schemaVersion: 3, tasks: [], nextId: 1 })).toBe(false);
		expect(isTaskDetails({ schemaVersion: 2, kind: "query", action: "clear" })).toBe(false);
		expect(
			isTaskDetails({
				schemaVersion: 2,
				kind: "checkpoint",
				action: "create",
				params: {},
				state: { tasks: [], nextId: 2, generation: 0, revision: 1 },
			}),
		).toBe(false);
		expect(isTaskDetails(v1([{ id: 1, subject: "x", status: "unknown" } as never], 2))).toBe(false);
	});

	it("validates the dedicated reset checkpoint shape", () => {
		expect(
			isResetDetailsV2({
				schemaVersion: 2,
				kind: "checkpoint",
				action: "reset",
				state: state([], 7, 3, 9),
			}),
		).toBe(true);
		expect(isResetDetailsV2({ schemaVersion: 2, kind: "query", action: "reset" })).toBe(false);
	});
});

describe("replayFromBranch", () => {
	it("returns a fresh V2 empty state when branch has no Todo checkpoints", () => {
		const ctx = createMockCtx({ branch: buildSessionEntries([makeUserMessage("hi")]) });
		expect(replayFromBranch(ctx)).toEqual({
			tasks: [],
			nextId: 1,
			generation: 1,
			revision: 0,
		});
	});

	it("normalizes the last V1 snapshot and supports old clear snapshots", () => {
		const ctx = createMockCtx({
			branch: buildBranch([
				v1([taskFixture(1, "old")], 2),
				v1([], 1, "clear"),
			]),
		});
		expect(replayFromBranch(ctx)).toEqual({
			tasks: [],
			nextId: 2,
			generation: 1,
			revision: 0,
		});
	});

	it("keeps nextId above checkpoints on abandoned session branches", () => {
		const activeBranch = buildSessionEntries([makeUserMessage("rewound before todos")]);
		const allEntries = [
			...activeBranch,
			...buildSessionEntries([
				makeTodoToolResult(checkpoint(state([taskFixture(7, "abandoned")], 8, 2, 4))),
			]),
		];
		const replayed = replayFromBranch(createMockCtx({ branch: activeBranch, entries: allEntries }));
		expect(replayed).toEqual({ tasks: [], nextId: 8, generation: 1, revision: 0 });
	});

	it("accepts legacy activeForm snapshots but strips the retired field", () => {
		const legacy = {
			action: "create",
			params: { activeForm: "Working" },
			tasks: [{ id: 1, subject: "legacy", status: "in_progress", activeForm: "Working" }],
			nextId: 2,
		};
		const replayed = replayFromBranch(createMockCtx({ branch: buildBranch([legacy]) }));
		expect(replayed.tasks).toEqual([{ id: 1, subject: "legacy", status: "in_progress" }]);
		expect("activeForm" in replayed.tasks[0]!).toBe(false);
	});

	it("replays V2 mutation checkpoints and ignores later query envelopes", () => {
		const liveState = state([taskFixture(7, "kept")], 8, 3, 12);
		const ctx = createMockCtx({
			branch: buildBranch([
				checkpoint(liveState),
				{ schemaVersion: 2, kind: "query", action: "list" },
				{ schemaVersion: 2, kind: "query", action: "get" },
			]),
		});
		expect(replayFromBranch(ctx)).toEqual(liveState);
	});

	it("orders tool and reset checkpoints together with last valid checkpoint winning", () => {
		const before = checkpoint(state([taskFixture(5, "before")], 6, 2, 4));
		const resetState = state([], 6, 3, 5);
		const after = checkpoint(state([taskFixture(6, "after")], 7, 3, 6));
		const branch = [
			...buildBranch([before]),
			customReset(resetState),
			...buildSessionEntries([makeTodoToolResult({ schemaVersion: 2, kind: "query", action: "list" })]),
		];
		expect(replayFromBranch(createMockCtx({ branch }))).toEqual(resetState);
		branch.push(...buildSessionEntries([makeTodoToolResult(after)]));
		expect(replayFromBranch(createMockCtx({ branch }))).toEqual(after.state);
	});

	it("skips malformed and unknown checkpoint envelopes", () => {
		const good = checkpoint(state([taskFixture(1, "good")], 2, 1, 1));
		const ctx = createMockCtx({
			branch: buildBranch([
				good,
				{ schemaVersion: 2, kind: "checkpoint", action: "create", params: {}, state: { tasks: "bad" } },
				{ schemaVersion: 99, kind: "checkpoint", state: state([], 9) },
			]),
		});
		expect(replayFromBranch(ctx)).toEqual(good.state);
	});

	it("returns a deep-fresh state and drops retired dependency fields", () => {
		const fixture = {
			...taskFixture(1, "original", { metadata: { nested: { value: 1 } } }),
			blockedBy: [2],
		};
		const persisted = state([fixture], 3, 2, 4);
		const replayed = replayFromBranch(createMockCtx({ branch: buildBranch([checkpoint(persisted)]) }));
		expect(replayed).not.toBe(persisted);
		expect(replayed.tasks[0]).not.toBe(fixture);
		expect(replayed.tasks[0]).not.toHaveProperty("blockedBy");
		expect(replayed.tasks[0]!.metadata).not.toBe(fixture.metadata);
		expect((replayed.tasks[0]!.metadata?.nested as object)).not.toBe(fixture.metadata?.nested);
	});

	it("skips unrelated non-message and custom entries", () => {
		const good = checkpoint(state([taskFixture(1, "kept")], 2, 1, 1));
		const branch = [
			{ type: "custom", customType: "other", data: customReset(state([], 9)) } as never,
			{ type: "tool_call", call: { id: "x" } } as never,
			...buildBranch([good]),
		];
		expect(replayFromBranch(createMockCtx({ branch })).tasks[0]?.subject).toBe("kept");
	});
});
