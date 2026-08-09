import type { ExecResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG } from "../src/config.ts";
import { HerdrCommandError } from "../src/herdr-client.ts";
import { focusParentAndCloseChild } from "../src/btw/child.ts";
import { BtwLauncher, type BtwLaunchClient, type BtwLaunchStore } from "../src/btw/launch.ts";
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
		parentThinkingLevel: "high",
		messages: [{ role: "user", content: [{ type: "text", text: "parent" }], timestamp: 0 } as never],
		draftQuestion: "question",
		config: { ...DEFAULT_CONFIG.btw },
		launchId: "abcdef123456",
		capability: "c".repeat(64),
	});
}

const runtime = { inside: true, paneId: "w1:p1", tabId: "w1:t1", workspaceId: "w1", socketPath: "/tmp/herdr" } as const;

class FakeStore implements BtwLaunchStore {
	states: LaunchState[] = [];
	removed: string[] = [];
	async writeLaunchState(_path: string, state: LaunchState) { this.states.push(state); }
	async remove(path: string) { this.removed.push(path); }
}

class FakeClient implements BtwLaunchClient {
	calls: Array<{ name: string; args: unknown[] }> = [];
	panes = [{ paneId: "w1:p1", tabId: "w1:t1", cwd: "/work" }];
	splitError?: Error;
	startError?: Error;
	splitPaneId = "w1:p2";
	async splitPane(options: unknown) {
		this.calls.push({ name: "split", args: [options] });
		if (this.splitError) throw this.splitError;
		this.panes.push({ paneId: this.splitPaneId, tabId: "w1:t1", cwd: "/work" });
		return { paneId: this.splitPaneId };
	}
	async listPanes() {
		this.calls.push({ name: "list", args: [] });
		return [...this.panes];
	}
	async closePane(paneId: string) {
		this.calls.push({ name: "close", args: [paneId] });
		this.panes = this.panes.filter((pane) => pane.paneId !== paneId);
	}
	async startAgent(options: unknown) {
		this.calls.push({ name: "start-agent", args: [options] });
		if (this.startError) throw this.startError;
	}
	async getPane(paneId: string) {
		this.calls.push({ name: "get", args: [paneId] });
		const pane = this.panes.find((candidate) => candidate.paneId === paneId);
		if (!pane) {
			throw new HerdrCommandError(["pane", "get", paneId], {
				stdout: "",
				stderr: JSON.stringify({ error: { code: "pane_not_found", message: "not found" } }),
				code: 1,
				killed: false,
			});
		}
		return pane;
	}
}

function launch(client = new FakeClient(), store = new FakeStore()) {
	return { launcher: new BtwLauncher(client, store, () => new Date("2026-08-09T12:00:01.000Z")), client, store };
}

describe("BTW launch cleanup", () => {
	it("splits focused with a path-only env capability and records child readiness", async () => {
		const { launcher, client, store } = launch();
		const value = payload();
		const launched = await launcher.launch({ payload: value, payloadPath: "/private/launch/payload.json", runtime });
		expect(launched).toEqual({ paneId: "w1:p2", agentName: "btw-sessio-abcdef" });
		expect(client.calls[1]).toMatchObject({
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
		expect(store.removed).toEqual([]);
	});

	it("closes the known owned pane and clears payload when agent startup fails", async () => {
		const client = new FakeClient();
		client.startError = new Error("Pi did not become ready");
		const store = new FakeStore();
		const { launcher } = launch(client, store);
		await expect(launcher.launch({ payload: payload(), payloadPath: "/private/payload.json", runtime })).rejects.toThrow(/did not become ready/);
		expect(client.calls.at(-1)).toEqual({ name: "close", args: ["w1:p2"] });
		expect(store.removed).toEqual(["/private/payload.json"]);
	});

	it("extracts and closes a pane from partial split JSON after timeout", async () => {
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

	it("never closes the caller even if Herdr returns its ID as the split result", async () => {
		const client = new FakeClient();
		client.splitPaneId = "w1:p1";
		const store = new FakeStore();
		const { launcher } = launch(client, store);
		await expect(launcher.launch({ payload: payload(), payloadPath: "/private/payload.json", runtime })).rejects.toThrow(/invalid.*identity/i);
		expect(client.calls.some((call) => call.name === "close" && call.args[0] === "w1:p1")).toBe(false);
		expect(store.removed).toEqual(["/private/payload.json"]);
	});

	it("after accepted ack refocuses the exact parent and closes only the child pane", async () => {
		const calls: string[] = [];
		const client = {
			async focusAgent(target: string) { calls.push(`focus:${target}`); },
			async closePane(target: string) { calls.push(`close:${target}`); },
		};
		expect(await focusParentAndCloseChild(client, { ...runtime, paneId: "w1:p2" }, { parentPaneId: "w1:p1" }))
			.toEqual({ closed: true });
		expect(calls).toEqual(["focus:w1:p1", "close:w1:p2"]);
		calls.length = 0;
		expect(await focusParentAndCloseChild(client, runtime, { parentPaneId: "w1:p1" }))
			.toEqual({ closed: false });
		expect(calls).toEqual(["focus:w1:p1"]);
	});

	it("reports true/false/unknown liveness without treating server failure as stale", async () => {
		const { launcher, client } = launch();
		expect(await launcher.isPaneLive("w1:p1")).toBe(true);
		expect(await launcher.isPaneLive("w1:p9")).toBe(false);
		client.getPane = async () => { throw new Error("socket unavailable"); };
		expect(await launcher.isPaneLive("w1:p1")).toBe("unknown");
	});
});
