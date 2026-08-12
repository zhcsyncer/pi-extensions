import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { Value } from "typebox/value";
import { describe, expect, it, vi } from "vitest";
import type { HerdrAgent, StartAgentOptions } from "../src/herdr-client.ts";
import type { RuntimeSnapshot } from "../src/runtime.ts";
import {
	buildWorkerCallbackContract,
	HERDR_WORKER_REPORT_PREFIX,
	herdrWorkerSchema,
	HerdrWorkerDispatcher,
	isWorkerReportInput,
	parentAgentName,
	registerHerdrWorkerReportInput,
	registerHerdrWorkerTool,
	type HerdrWorkerClient,
} from "../src/worker.ts";

function agent(paneId: string, name?: string): HerdrAgent {
	return { paneId, agent: "pi", status: "working", ...(name ? { name } : {}) };
}

function runtime(): RuntimeSnapshot {
	return {
		inside: true,
		paneId: "w1:p1",
		tabId: "w1:t1",
		workspaceId: "w1",
		socketPath: "/tmp/herdr.sock",
	};
}

function context(sessionId = "019ff67c-0f70-771b-89ae-f62da1bbd8d2"): ExtensionContext {
	return {
		sessionManager: { getSessionId: () => sessionId },
	} as unknown as ExtensionContext;
}

function client(overrides: Partial<HerdrWorkerClient> = {}) {
	const getAgent = overrides.getAgent ?? vi.fn(async (target: string) => agent(target));
	const renameAgent = overrides.renameAgent ?? vi.fn(async (target: string, name: string) => agent(target, name));
	const startAgent = overrides.startAgent ?? vi.fn(async (_options: StartAgentOptions) => undefined);
	const promptAgent = overrides.promptAgent ?? vi.fn(async (target: string) => agent(target));
	return {
		value: { getAgent, renameAgent, startAgent, promptAgent } as HerdrWorkerClient,
		getAgent: vi.mocked(getAgent),
		renameAgent: vi.mocked(renameAgent),
		startAgent: vi.mocked(startAgent),
		promptAgent: vi.mocked(promptAgent),
	};
}

describe("herdr_worker schema and dispatch contract", () => {
	it("accepts only the minimal pane/name/prompt shape and Herdr-valid names", () => {
		expect(Value.Check(herdrWorkerSchema, {
			paneId: "w1:p9",
			name: "review_worker-1",
			prompt: "Review the current diff.",
		})).toBe(true);
		for (const value of [
			{ paneId: "w1:p9", name: "Review", prompt: "task" },
			{ paneId: "w1:p9", name: "1worker", prompt: "task" },
			{ paneId: "w1:p9", name: "worker.with.dot", prompt: "task" },
			{ paneId: "w1:p9", name: `w${"x".repeat(32)}`, prompt: "task" },
			{ paneId: "w1:p9", name: "worker", prompt: "" },
			{ paneId: "", name: "worker", prompt: "task" },
		]) expect(Value.Check(herdrWorkerSchema, value)).toBe(false);
	});

	it("registers one public tool with the exact minimal schema", () => {
		let registered: any;
		const pi = {
			registerTool(tool: unknown) { registered = tool; },
		} as unknown as ExtensionAPI;
		registerHerdrWorkerTool(pi, {} as HerdrWorkerDispatcher);
		expect(registered.name).toBe("herdr_worker");
		expect(Object.keys(registered.parameters.properties)).toEqual(["paneId", "name", "prompt"]);
		expect(registered.executionMode).toBe("sequential");
	});

	it("reuses an existing parent name, appends only the callback contract, then prompts without waiting", async () => {
		const c = client({ getAgent: vi.fn(async () => agent("w1:p1", "coordinator")) });
		const dispatcher = new HerdrWorkerDispatcher(c.value, runtime());
		await expect(dispatcher.dispatch({
			paneId: "w1:p9",
			name: "reviewer",
			prompt: "Review the current diff and report findings.",
		}, context())).resolves.toEqual({
			paneId: "w1:p9",
			workerName: "reviewer",
			parentName: "coordinator",
		});

		expect(c.renameAgent).not.toHaveBeenCalled();
		expect(c.startAgent).toHaveBeenCalledOnce();
		const options = c.startAgent.mock.calls[0]?.[0] as StartAgentOptions;
		expect(options).toMatchObject({ name: "reviewer", kind: "pi", paneId: "w1:p9" });
		expect(options.args).toEqual([
			"--append-system-prompt",
			buildWorkerCallbackContract("coordinator"),
		]);
		expect(options.args[1]).toContain(`herdr agent prompt coordinator "${HERDR_WORKER_REPORT_PREFIX} <final outcome>"`);
		expect(options.args[1]).not.toContain("\n");
		expect(options.args[1]).toContain("final success or confirmed failure");
		expect(options.args[1]).toContain("exactly once");
		expect(options.args[1]).not.toMatch(/subagent|idle|done|status|worktree|cleanup|restart|batch/i);
		expect(c.promptAgent).toHaveBeenCalledWith(
			"reviewer",
			"Review the current diff and report findings.",
			undefined,
		);
		expect(c.startAgent.mock.invocationCallOrder[0]).toBeLessThan(c.promptAgent.mock.invocationCallOrder[0] as number);
	});

	it("lazily generates and confirms one stable parent name on first actual dispatch", async () => {
		const c = client();
		const dispatcher = new HerdrWorkerDispatcher(c.value, runtime());
		const sessionId = "session:UPPER/unsafe/value";
		const expectedParent = parentAgentName(sessionId);
		expect(expectedParent).toMatch(/^[a-z][a-z0-9_-]{0,31}$/);
		expect(expectedParent).toHaveLength(32);
		expect(c.getAgent).not.toHaveBeenCalled();
		expect(c.renameAgent).not.toHaveBeenCalled();

		await dispatcher.dispatch({ paneId: "w1:p8", name: "worker_one", prompt: "first" }, context(sessionId));
		await dispatcher.dispatch({ paneId: "w1:p7", name: "worker_two", prompt: "second" }, context(sessionId));

		expect(c.getAgent).toHaveBeenCalledTimes(1);
		expect(c.getAgent).toHaveBeenCalledWith("w1:p1", undefined);
		expect(c.renameAgent).toHaveBeenCalledTimes(1);
		expect(c.renameAgent).toHaveBeenCalledWith("w1:p1", expectedParent, undefined);
		expect(c.startAgent).toHaveBeenCalledTimes(2);
		expect(c.promptAgent).toHaveBeenCalledTimes(2);
	});

	it("does not prompt when parent naming or Worker startup fails", async () => {
		const namingFailure = new Error("parent rename rejected");
		const naming = client({
			renameAgent: vi.fn(async () => { throw namingFailure; }),
		});
		await expect(new HerdrWorkerDispatcher(naming.value, runtime()).dispatch(
			{ paneId: "w1:p8", name: "worker_one", prompt: "task" },
			context(),
		)).rejects.toBe(namingFailure);
		expect(naming.startAgent).not.toHaveBeenCalled();
		expect(naming.promptAgent).not.toHaveBeenCalled();

		const startupFailure = new Error("pane is busy");
		const startup = client({
			getAgent: vi.fn(async () => agent("w1:p1", "parent")),
			startAgent: vi.fn(async () => { throw startupFailure; }),
		});
		await expect(new HerdrWorkerDispatcher(startup.value, runtime()).dispatch(
			{ paneId: "w1:p8", name: "worker_one", prompt: "task" },
			context(),
		)).rejects.toBe(startupFailure);
		expect(startup.promptAgent).not.toHaveBeenCalled();
	});

	it("surfaces prompt submission failure after a successful start", async () => {
		const promptFailure = new Error("agent prompt rejected");
		const c = client({
			getAgent: vi.fn(async () => agent("w1:p1", "parent")),
			promptAgent: vi.fn(async () => { throw promptFailure; }),
		});
		await expect(new HerdrWorkerDispatcher(c.value, runtime()).dispatch(
			{ paneId: "w1:p8", name: "worker_one", prompt: "task" },
			context(),
		)).rejects.toBe(promptFailure);
		expect(c.startAgent).toHaveBeenCalledOnce();
	});
});

describe("Worker report input adapter", () => {
	function harness(sendFailure?: Error) {
		let handler: ((event: any, ctx: unknown) => unknown) | undefined;
		const sent: Array<{ message: unknown; options: unknown }> = [];
		const notifications: Array<{ message: string; level: string }> = [];
		const pi = {
			on(name: string, value: typeof handler) {
				if (name === "input") handler = value;
			},
			sendMessage(message: unknown, options: unknown) {
				if (sendFailure) throw sendFailure;
				sent.push({ message, options });
			},
		} as unknown as ExtensionAPI;
		registerHerdrWorkerReportInput(pi);
		return {
			invoke: (event: unknown) => handler?.(event, {
				ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
			}),
			sent,
			notifications,
		};
	}

	it("recognizes only the exact reserved prefix at the start of ordinary input", () => {
		expect(isWorkerReportInput(`${HERDR_WORKER_REPORT_PREFIX} success`)).toBe(true);
		expect(isWorkerReportInput(` ${HERDR_WORKER_REPORT_PREFIX} success`)).toBe(false);
		expect(isWorkerReportInput("[pi-herdr-worker-report:v2] success")).toBe(false);
		expect(isWorkerReportInput("normal input")).toBe(false);
	});

	it("converts a reserved report into a triggered follow-up and handles the original input", () => {
		const h = harness();
		const text = `${HERDR_WORKER_REPORT_PREFIX} success: tests pass`;
		expect(h.invoke({ text, source: "interactive", streamingBehavior: "steer" })).toEqual({ action: "handled" });
		expect(h.sent).toEqual([{
			message: { customType: "pi-herdr-worker-report", content: text, display: true },
			options: { deliverAs: "followUp", triggerTurn: true },
		}]);
		expect(h.notifications).toEqual([]);
	});

	it("suppresses the reserved original instead of falling back to steer when follow-up injection fails", () => {
		const h = harness(new Error("runtime unavailable"));
		const text = `${HERDR_WORKER_REPORT_PREFIX} confirmed failure`;
		expect(h.invoke({ text, source: "interactive", streamingBehavior: "steer" })).toEqual({ action: "handled" });
		expect(h.sent).toEqual([]);
		expect(h.notifications).toEqual([{
			message: "Could not queue the Herdr Worker report as a follow-up; the reserved input was suppressed.",
			level: "warning",
		}]);
	});

	it("passes every non-report input through unchanged", () => {
		const h = harness();
		for (const text of [
			"please continue",
			` ${HERDR_WORKER_REPORT_PREFIX} not reserved at start`,
			"[pi-herdr-worker-report:v2] future protocol",
		]) {
			expect(h.invoke({ text, source: "rpc", streamingBehavior: "steer" })).toEqual({ action: "continue" });
		}
		expect(h.sent).toEqual([]);
	});
});
