import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import { buildSessionEntries, createMockCtx, createMockPi, makeTodoToolResult } from "./test-fixtures.js";
import { replayFromBranch } from "./state/replay.js";
import { createTodoStore, registerTodoTool } from "./todo.js";
import type {
	MutationDetailsV2,
	QueryDetailsV2,
	Task,
	TaskDetailsV1,
} from "./tool/types.js";

interface CapturedResult {
	content: unknown;
	details: MutationDetailsV2 | QueryDetailsV2;
}

async function runCycles(cycleCount: number, tasksPerCycle: number): Promise<CapturedResult[]> {
	const { pi, captured } = createMockPi();
	registerTodoTool(pi, createTodoStore(), {});
	const tool = captured.tools.get("todo")!;
	const results: CapturedResult[] = [];
	const call = async (params: Record<string, unknown>) => {
		const result = await tool.execute?.(
			"fixture",
			params as never,
			undefined as never,
			undefined as never,
			{} as never,
		);
		results.push(result as CapturedResult);
		return result as CapturedResult;
	};

	for (let cycle = 0; cycle < cycleCount; cycle++) {
		const created = await call({
			action: "batch",
			operations: Array.from({ length: tasksPerCycle }, (_, index) => ({
				action: "create",
				subject: `cycle-${cycle + 1}-task-${index + 1}`,
				...(index === 0 ? { status: "in_progress" } : {}),
			})),
		});
		const ids = (created.details as MutationDetailsV2).state.tasks.map((task) => task.id);
		await call({ action: "list" });
		for (const id of ids) await call({ action: "get", id });

		for (const [index, id] of ids.entries()) {
			if (index + 1 < ids.length) {
				await call({
					action: "batch",
					operations: [
						{ action: "update", id, status: "completed" },
						{ action: "update", id: ids[index + 1], status: "in_progress" },
					],
				});
			} else {
				await call({ action: "update", id, status: "completed" });
			}
			await call({ action: "list" });
		}
	}
	return results;
}

function v1Baseline(results: readonly CapturedResult[]): CapturedResult[] {
	const retained = new Map<number, Task>();
	let nextId = 1;
	return results.map((result) => {
		const details = result.details;
		if (details.kind === "checkpoint") {
			for (const task of details.state.tasks) retained.set(task.id, structuredClone(task));
			nextId = details.state.nextId;
		}
		const legacy: TaskDetailsV1 = {
			schemaVersion: 1,
			action: details.action,
			params: details.kind === "checkpoint" ? details.params : {},
			tasks: [...retained.values()],
			nextId,
		};
		return { content: result.content, details: legacy as never };
	});
}

function serializedBytes(results: readonly CapturedResult[]) {
	let detailsBytes = 0;
	let jsonlBytes = 0;
	for (const result of results) {
		const details = JSON.stringify(result.details);
		detailsBytes += Buffer.byteLength(details);
		jsonlBytes += Buffer.byteLength(
			`${JSON.stringify({
				type: "message",
				message: {
					role: "toolResult",
					toolName: "todo",
					content: result.content,
					details: result.details,
				},
			})}\n`,
		);
	}
	return { detailsBytes, jsonlBytes, detailsShare: detailsBytes / jsonlBytes };
}

function replayMilliseconds(results: readonly CapturedResult[], iterations: number): number {
	const branch = buildSessionEntries(results.map((result) => makeTodoToolResult(result.details)));
	const ctx = createMockCtx({ branch });
	const started = performance.now();
	for (let index = 0; index < iterations; index++) replayFromBranch(ctx);
	return performance.now() - started;
}

describe("bounded-state value fixture", () => {
	it("measures mutation-only checkpoints across repeated five-task cycles", async () => {
		const v2 = await runCycles(6, 5);
		const v1 = v1Baseline(v2);
		const v2Bytes = serializedBytes(v2);
		const v1Bytes = serializedBytes(v1);
		const iterations = 300;
		const metrics = {
			cycles: 6,
			tasksPerCycle: 5,
			results: v2.length,
			v1: { ...v1Bytes, replayMs: replayMilliseconds(v1, iterations) },
			v2: { ...v2Bytes, replayMs: replayMilliseconds(v2, iterations) },
		};

		expect(v2Bytes.detailsBytes).toBeLessThan(v1Bytes.detailsBytes);
		expect(v2Bytes.jsonlBytes).toBeLessThan(v1Bytes.jsonlBytes);
		expect(v2Bytes.detailsShare).toBeLessThan(v1Bytes.detailsShare);
		expect(metrics.v1.replayMs).toBeGreaterThanOrEqual(0);
		expect(metrics.v2.replayMs).toBeGreaterThanOrEqual(0);
		console.info(`[pi-todo bounded-state fixture] ${JSON.stringify(metrics)}`);
	});
});
