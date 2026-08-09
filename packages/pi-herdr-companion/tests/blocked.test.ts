import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { DEFAULT_CONFIG, type CompanionConfig } from "../src/config.ts";
import { registerAskUserBlockedAdapter } from "../src/blocked/ask-user.ts";
import {
	ASK_USER_BLOCKED_EVENT,
	BlockedDepthTracker,
	HERDR_BLOCKED_EVENT,
} from "../src/blocked/tracker.ts";

function config(): CompanionConfig {
	return JSON.parse(JSON.stringify(DEFAULT_CONFIG)) as CompanionConfig;
}

describe("BlockedDepthTracker", () => {
	it("balances nested true/false and ignores unknown false", () => {
		const signals: unknown[] = [];
		const tracker = new BlockedDepthTracker("question", (signal) => signals.push(signal));
		tracker.update(false);
		tracker.update(true);
		tracker.update(true);
		tracker.update(false);
		expect(tracker.activeDepth).toBe(1);
		tracker.clear();
		expect(tracker.activeDepth).toBe(0);
		expect(signals).toEqual([
			{ active: true, label: "question" },
			{ active: true, label: "question" },
			{ active: false },
			{ active: false },
		]);
	});
});

describe("ask-user blocked adapter", () => {
	function harness(runtimeInside = true) {
		const eventListeners = new Map<string, Array<(data: unknown) => void>>();
		const lifecycle = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
		const pi = {
			events: {
				on(name: string, listener: (data: unknown) => void) {
					const listeners = eventListeners.get(name) ?? [];
					listeners.push(listener);
					eventListeners.set(name, listeners);
				},
				emit(name: string, data: unknown) {
					for (const listener of eventListeners.get(name) ?? []) listener(data);
				},
			},
			on(name: string, listener: (event: unknown, ctx: unknown) => unknown) {
				const listeners = lifecycle.get(name) ?? [];
				listeners.push(listener);
				lifecycle.set(name, listeners);
			},
		} as unknown as ExtensionAPI;
		const cfg = config();
		const tracker = registerAskUserBlockedAdapter(pi, {
			inside: runtimeInside,
			paneId: runtimeInside ? "w1:p1" : undefined,
			socketPath: runtimeInside ? "/tmp/herdr" : undefined,
		}, () => cfg);
		const ctx = { mode: "tui", isIdle: () => true };
		return {
			pi,
			cfg,
			tracker,
			emit: (name: string, data: unknown) => pi.events.emit(name, data),
			async lifecycle(name: string, event: unknown = {}, override: unknown = ctx) {
				for (const listener of lifecycle.get(name) ?? []) await listener(event, override);
			},
		};
	}

	it("bridges only in a Herdr TUI root session and force-clears on settled/shutdown", async () => {
		const h = harness();
		const signals: unknown[] = [];
		h.pi.events.on(HERDR_BLOCKED_EVENT, (data) => signals.push(data));
		await h.lifecycle("session_start");
		h.emit(ASK_USER_BLOCKED_EVENT, { active: true });
		h.emit(ASK_USER_BLOCKED_EVENT, { active: true, futureField: "ignored" });
		expect(h.tracker.activeDepth).toBe(2);
		await h.lifecycle("agent_settled");
		expect(h.tracker.activeDepth).toBe(0);
		expect(signals).toEqual([
			{ active: true, label: "question" },
			{ active: true, label: "question" },
			{ active: false },
			{ active: false },
		]);
		h.emit(ASK_USER_BLOCKED_EVENT, { active: true });
		await h.lifecycle("session_shutdown");
		expect(signals.at(-1)).toEqual({ active: false });
	});

	it("ignores outside-Herdr, non-TUI, disabled, and malformed sources", async () => {
		for (const [inside, mode, enabled] of [
			[false, "tui", true],
			[true, "rpc", true],
			[true, "tui", false],
		] as const) {
			const h = harness(inside);
			h.cfg.blocked.askUserQuestion = enabled;
			const signals: unknown[] = [];
			h.pi.events.on(HERDR_BLOCKED_EVENT, (data) => signals.push(data));
			await h.lifecycle("session_start", {}, { mode, isIdle: () => true });
			h.emit(ASK_USER_BLOCKED_EVENT, { active: true });
			h.emit(ASK_USER_BLOCKED_EVENT, { active: "yes" });
			expect(signals).toEqual([]);
		}
	});

	it("never lets a failing Herdr listener break the ask-user producer", async () => {
		const h = harness();
		h.pi.events.on(HERDR_BLOCKED_EVENT, () => { throw new Error("reporter failed"); });
		await h.lifecycle("session_start");
		expect(() => h.emit(ASK_USER_BLOCKED_EVENT, { active: true })).not.toThrow();
		expect(() => h.emit(ASK_USER_BLOCKED_EVENT, { active: false })).not.toThrow();
	});

	it("does not proxy Plan Mode's direct herdr:blocked events a second time", async () => {
		const h = harness();
		const signals: unknown[] = [];
		h.pi.events.on(HERDR_BLOCKED_EVENT, (data) => signals.push(data));
		await h.lifecycle("session_start");
		h.emit(HERDR_BLOCKED_EVENT, { active: true, label: "plan review" });
		expect(signals).toEqual([{ active: true, label: "plan review" }]);
	});
});
