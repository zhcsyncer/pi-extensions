import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { HerdrCommandError } from "../src/herdr-client.ts";
import { bindChildSession, focusParentAndCloseChild } from "../src/btw/child.ts";
import {
	BtwLauncher,
	type BtwLaunchClient,
	type BtwLaunchStore,
	type BtwLaunchTiming,
} from "../src/btw/launch.ts";
import { createBtwPayload } from "../src/btw/types.ts";
import type { LaunchState } from "../src/btw/protocol.ts";

function payload() {
	return createBtwPayload({
		createdAt: "2026-08-09T12:00:00.000Z",
		parentSessionId: "session-1",
		parentPaneId: "w1:p1",
		metadata: { generatedAt: "2026-08-09T12:00:00.000Z", cwd: "/work", session: "s", model: "openai/gpt" },
		parentSystemPrompt: "system",
		parentActiveTools: ["read"],
		parentToolSchemaFingerprint: "tools-v1",
		parentThinkingLevel: "high",
		messages: [{ role: "user", content: [{ type: "text", text: "parent" }], timestamp: 0 } as never],
		draftQuestion: "question",
		config: { ...DEFAULT_CONFIG.btw },
		launchId: "abcdef123456",
		capability: "c".repeat(64),
	});
}

const runtime = { inside: true, paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", socketPath: "/tmp/herdr" } as const;

function herdrError(code: string): HerdrCommandError {
	return new HerdrCommandError(["agent", "start"], {
		stdout: "",
		stderr: JSON.stringify({ error: { code, message: "agent start failed" } }),
		code: 1,
		killed: false,
	});
}

class FakeStore implements BtwLaunchStore {
	states: LaunchState[] = [];
	removed: string[] = [];
	async writeLaunchState(_path: string, state: LaunchState) { this.states.push(state); }
	async readLaunchState(_path: string) { return this.states.at(-1); }
	async remove(path: string) { this.removed.push(path); }
}

class FakeTiming implements BtwLaunchTiming {
	elapsedMs = 0;
	waits: number[] = [];
	nowMs() { return this.elapsedMs; }
	async wait(delayMs: number, signal?: AbortSignal) {
		signal?.throwIfAborted();
		this.waits.push(delayMs);
		this.elapsedMs += delayMs;
		signal?.throwIfAborted();
	}
}

class FakeClient implements BtwLaunchClient {
	calls: Array<{ name: string; args: unknown[] }> = [];
	panes = new Set(["w1:p1"]);
	agents = new Map<string, string>();
	splitError?: Error;
	startError?: Error;
	startErrors: Error[] = [];
	splitPaneId = "w1:p2";
	async splitPane(options: unknown) {
		this.calls.push({ name: "split", args: [options] });
		if (this.splitError) throw this.splitError;
		this.panes.add(this.splitPaneId);
		return { paneId: this.splitPaneId };
	}
	async closePane(paneId: string) {
		this.calls.push({ name: "close", args: [paneId] });
		this.panes.delete(paneId);
	}
	async startAgent(options: unknown, signal?: AbortSignal) {
		this.calls.push({ name: "start-agent", args: [options] });
		signal?.throwIfAborted();
		const error = this.startErrors.shift() ?? this.startError;
		if (error) throw error;
		const typed = options as { name: string; paneId: string };
		this.agents.set(typed.name, typed.paneId);
	}
	async getPane(paneId: string) {
		this.calls.push({ name: "get", args: [paneId] });
		if (!this.panes.has(paneId)) {
			throw new HerdrCommandError(["pane", "get", paneId], {
				stdout: "",
				stderr: JSON.stringify({ error: { code: "pane_not_found", message: "not found" } }),
				code: 1,
				killed: false,
			});
		}
		return { paneId };
	}
	async getAgent(target: string) {
		this.calls.push({ name: "get-agent", args: [target] });
		const paneId = this.agents.get(target);
		if (!paneId) throw new Error("agent unavailable");
		return { paneId, name: target };
	}
}

function launch(
	client = new FakeClient(),
	store = new FakeStore(),
	timing: BtwLaunchTiming = new FakeTiming(),
) {
	return {
		launcher: new BtwLauncher(client, store, () => new Date("2026-08-09T12:00:01.000Z"), timing),
		client,
		store,
	};
}

describe("BTW fresh-pane agent startup", () => {
	it("retries typed busy failures and succeeds within one shared deadline", async () => {
		const client = new FakeClient();
		client.startErrors.push(herdrError("agent_pane_busy"), herdrError("agent_pane_busy"));
		const store = new FakeStore();
		const timing = new FakeTiming();
		const { launcher } = launch(client, store, timing);

		await expect(launcher.launch({ payload: payload(), payloadPath: "/private/payload.json", runtime }))
			.resolves.toEqual({ paneId: "w1:p2", agentName: "btw-sessio-abcdef" });
		const starts = client.calls.filter((call) => call.name === "start-agent");
		expect(starts).toHaveLength(3);
		expect(starts.map((call) => (call.args[0] as { timeoutMs: number }).timeoutMs))
			.toEqual([40_000, 39_750, 39_250]);
		expect(timing.waits).toEqual([250, 500]);
		expect(store.states.map((state) => state.status)).toEqual(["pane_created", "child_ready"]);
		expect(store.removed).toEqual([]);
	});

	it("does not retry a typed non-busy Herdr failure", async () => {
		const client = new FakeClient();
		const failure = herdrError("agent_start_failed");
		client.startError = failure;
		const store = new FakeStore();
		const timing = new FakeTiming();
		const { launcher } = launch(client, store, timing);

		await expect(launcher.launch({ payload: payload(), payloadPath: "/private/payload.json", runtime }))
			.rejects.toBe(failure);
		expect(client.calls.filter((call) => call.name === "start-agent")).toHaveLength(1);
		expect(timing.waits).toEqual([]);
		expect(client.calls.filter((call) => call.name === "close"))
			.toEqual([{ name: "close", args: ["w1:p2"] }]);
		expect(store.removed).toEqual(["/private/payload.json"]);
	});

	it("bounds persistent busy retries and clears only the fresh pane state", async () => {
		const client = new FakeClient();
		const failure = herdrError("agent_pane_busy");
		client.startError = failure;
		const store = new FakeStore();
		const timing = new FakeTiming();
		const { launcher } = launch(client, store, timing);

		await expect(launcher.launch({ payload: payload(), payloadPath: "/private/payload.json", runtime }))
			.rejects.toBe(failure);
		const starts = client.calls.filter((call) => call.name === "start-agent");
		expect(starts).toHaveLength(5);
		expect(starts.map((call) => (call.args[0] as { timeoutMs: number }).timeoutMs))
			.toEqual([40_000, 39_750, 39_250, 38_250, 37_250]);
		expect(timing.waits).toEqual([250, 500, 1_000, 1_000]);
		expect(client.calls.filter((call) => call.name === "close"))
			.toEqual([{ name: "close", args: ["w1:p2"] }]);
		expect(store.states.map((state) => state.status)).toEqual(["pane_created"]);
		expect(store.removed).toEqual(["/private/payload.json"]);
	});

	it("aborts during backoff without another start and clears the fresh pane state", async () => {
		const client = new FakeClient();
		client.startError = herdrError("agent_pane_busy");
		const store = new FakeStore();
		const controller = new AbortController();
		let markWaitStarted!: () => void;
		const waitStarted = new Promise<void>((resolve) => { markWaitStarted = resolve; });
		let waitingSignal: AbortSignal | undefined;
		const timing: BtwLaunchTiming = {
			nowMs: () => 0,
			async wait(_delayMs, signal) {
				waitingSignal = signal;
				await new Promise<void>((_resolve, reject) => {
					if (!signal) return reject(new Error("retry wait did not receive AbortSignal"));
					signal.addEventListener("abort", () => reject(signal.reason), { once: true });
					markWaitStarted();
				});
			},
		};
		const { launcher } = launch(client, store, timing);
		const pending = launcher.launch({
			payload: payload(),
			payloadPath: "/private/payload.json",
			runtime,
			signal: controller.signal,
		});

		await waitStarted;
		expect(waitingSignal).toBe(controller.signal);
		const reason = new Error("cancelled while fresh shell was starting");
		controller.abort(reason);
		await expect(pending).rejects.toBe(reason);
		expect(client.calls.filter((call) => call.name === "start-agent")).toHaveLength(1);
		expect(client.calls.filter((call) => call.name === "close"))
			.toEqual([{ name: "close", args: ["w1:p2"] }]);
		expect(store.states.map((state) => state.status)).toEqual(["pane_created"]);
		expect(store.removed).toEqual(["/private/payload.json"]);
	});
});

describe("BTW launch cleanup", () => {
	it("splits focused with a path-only env capability and records durable child identity", async () => {
		const { launcher, client, store } = launch();
		const value = payload();
		const launched = await launcher.launch({ payload: value, payloadPath: "/private/launch/payload.json", runtime });
		expect(launched).toEqual({ paneId: "w1:p2", agentName: "btw-sessio-abcdef" });
		expect(client.calls[0]).toMatchObject({
			name: "split",
			args: [{
				target: "current",
				direction: "down",
				cwd: "/work",
				focus: true,
				environment: { PI_HERDR_COMPANION_BTW_PAYLOAD: "/private/launch/payload.json" },
			}],
		});
		const agent = client.calls.find((call) => call.name === "start-agent")?.args[0] as { args: string[] };
		expect(agent.args.join(" ")).not.toContain(value.capability);
		expect(agent.args.join(" ")).not.toContain(value.draftQuestion);
		expect(store.states.map((state) => state.status)).toEqual(["pane_created", "child_ready"]);
		expect(store.states.every((state) => state.agentName === "btw-sessio-abcdef")).toBe(true);
		expect(store.removed).toEqual([]);
	});

	it("does not retry a busy-shaped untyped startup failure and clears its owned pane", async () => {
		const client = new FakeClient();
		client.startError = Object.assign(new Error("Pi did not become ready"), { herdrCode: "agent_pane_busy" });
		const store = new FakeStore();
		const { launcher } = launch(client, store);
		await expect(launcher.launch({ payload: payload(), payloadPath: "/private/payload.json", runtime })).rejects.toThrow(/did not become ready/);
		expect(client.calls.filter((call) => call.name === "start-agent")).toHaveLength(1);
		expect(client.calls.at(-1)).toEqual({ name: "close", args: ["w1:p2"] });
		expect(store.removed).toEqual(["/private/payload.json"]);
	});

	it("closes only a pane ID explicitly carried by a failed split response", async () => {
		const client = new FakeClient();
		const result: ExecResult = {
			stdout: JSON.stringify({ result: { pane: { pane_id: "w1:p7" } } }),
			stderr: "",
			code: 0,
			killed: true,
		};
		client.splitError = new HerdrCommandError(["pane", "split"], result);
		const store = new FakeStore();
		const { launcher } = launch(client, store);
		await expect(launcher.launch({ payload: payload(), payloadPath: "/private/payload.json", runtime })).rejects.toBeInstanceOf(HerdrCommandError);
		expect(client.calls.some((call) => call.name === "close" && call.args[0] === "w1:p7")).toBe(true);
		expect(store.removed).toEqual(["/private/payload.json"]);
	});

	it("never guesses a same-cwd pane when split failure has no explicit pane ID", async () => {
		const client = new FakeClient();
		client.panes.add("w1:p8");
		client.splitError = new HerdrCommandError(["pane", "split", "--cwd", "/work"], {
			stdout: "",
			stderr: "split timed out",
			code: 1,
			killed: true,
		});
		const store = new FakeStore();
		const { launcher } = launch(client, store);
		await expect(launcher.launch({ payload: payload(), payloadPath: "/private/payload.json", runtime }))
			.rejects.toThrow(/possible orphan pane was left untouched/);
		expect(client.calls.some((call) => call.name === "close")).toBe(false);
		expect(client.panes.has("w1:p8")).toBe(true);
	});

	it("never closes the caller even if Herdr returns its ID as the split result", async () => {
		const client = new FakeClient();
		client.splitPaneId = "w1:p1";
		const store = new FakeStore();
		const { launcher } = launch(client, store);
		await expect(launcher.launch({ payload: payload(), payloadPath: "/private/payload.json", runtime })).rejects.toThrow(/invalid.*identity/i);
		expect(client.calls.some((call) => call.name === "close" && call.args[0] === "w1:p1")).toBe(false);
		expect(store.removed).toEqual(["/private/payload.json"]);
	});
});

describe("BTW child identity and session binding", () => {
	it("reload keeps the first child session binding while a different session is disabled", async () => {
		const store = new FakeStore();
		store.states.push({
			version: 1,
			launchId: "abcdef123456",
			paneId: "w1:p2",
			agentName: "btw-sessio-abcdef",
			status: "child_ready",
			updatedAt: "2026-08-09T12:00:00.000Z",
		});
		const first = await bindChildSession(store, "/private/payload.json", payload(), "child-session-1");
		expect(first.bound).toBe(true);
		expect(store.states.at(-1)?.childSessionId).toBe("child-session-1");
		expect((await bindChildSession(store, "/private/payload.json", payload(), "child-session-1")).bound).toBe(true);
		const unrelated = await bindChildSession(store, "/private/payload.json", payload(), "child-session-2");
		expect(unrelated).toMatchObject({ bound: false, reason: expect.stringContaining("unrelated") });
		expect(store.states.at(-1)?.childSessionId).toBe("child-session-1");
	});

	it("resolves a moved child by agent name before focus and close", async () => {
		const calls: string[] = [];
		const client = {
			async getAgent(target: string) { calls.push(`get:${target}`); return { paneId: "w2:p9" }; },
			async focusAgent(target: string) { calls.push(`focus:${target}`); },
			async closePane(target: string) { calls.push(`close:${target}`); },
		};
		expect(await focusParentAndCloseChild(
			client,
			{ parentPaneId: "w1:p1" },
			{ agentName: "btw-sessio-abcdef" },
		)).toEqual({ closed: true, childPaneId: "w2:p9" });
		expect(calls).toEqual(["get:btw-sessio-abcdef", "focus:w1:p1", "close:w2:p9"]);
	});

	it("keeps the child open when parent focus fails or agent resolution is unreliable", async () => {
		const calls: string[] = [];
		const focusFailure = {
			async getAgent() { return { paneId: "w1:p2" }; },
			async focusAgent() { calls.push("focus"); throw new Error("focus unavailable"); },
			async closePane() { calls.push("close"); },
		};
		expect(await focusParentAndCloseChild(
			focusFailure,
			{ parentPaneId: "w1:p1" },
			{ agentName: "btw" },
		)).toMatchObject({ closed: false, focusError: "focus unavailable" });
		expect(calls).toEqual(["focus"]);

		const unresolved = {
			async getAgent() { throw new Error("agent unavailable"); },
			async focusAgent() { calls.push("unexpected-focus"); },
			async closePane() { calls.push("unexpected-close"); },
		};
		expect(await focusParentAndCloseChild(
			unresolved,
			{ parentPaneId: "w1:p1" },
			{ agentName: "btw" },
		)).toMatchObject({ closed: false, resolutionError: "agent unavailable" });
		expect(calls).toEqual(["focus"]);
	});

	it("treats absent agent identity as unknown and follows the moved agent pane", async () => {
		const { launcher, client } = launch();
		expect(await launcher.isPaneLive("w1:p2")).toBe("unknown");
		client.agents.set("btw", "w2:p9");
		client.panes.add("w2:p9");
		expect(await launcher.isPaneLive("w1:p2", "btw")).toBe(true);
		client.panes.delete("w2:p9");
		expect(await launcher.isPaneLive("w1:p2", "btw")).toBe(false);
		client.getAgent = async () => { throw new Error("socket unavailable"); };
		expect(await launcher.isPaneLive("w1:p2", "btw")).toBe("unknown");
	});
});
