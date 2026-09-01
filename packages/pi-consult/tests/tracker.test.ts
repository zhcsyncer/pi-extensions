import { describe, expect, it } from "vitest";
import { DEFAULT_CONSULT_CONFIG } from "../src/config.ts";
import { ConsultTracker } from "../src/tracker.ts";

const budget = DEFAULT_CONSULT_CONFIG.budget;

describe("consult tracker gates", () => {
	it("fires loop after N identical calls and then locks", () => {
		const tracker = new ConsultTracker();
		for (let i = 0; i < 3; i++) {
			tracker.onToolStart(String(i), "bash", { command: "ls" });
			tracker.onToolEnd(String(i), "bash", false);
		}
		const decision = tracker.evaluateLoop(3, budget);
		expect(decision).toEqual({ fire: true, reason: "same" });
		tracker.markLoopFired();
		expect(tracker.evaluateLoop(3, budget).fire).toBe(false);
		expect(tracker.consumeTrigger()).toBe("loop");
		expect(tracker.lock).toBe(false);
	});

	it("ignores consult when computing the loop", () => {
		const tracker = new ConsultTracker();
		tracker.onToolStart("c", "consult", { why: "x" });
		tracker.onToolEnd("c", "consult", false);
		tracker.onToolStart("1", "bash", { command: "ls" });
		tracker.onToolEnd("1", "bash", false);
		expect(tracker.evaluateLoop(1, budget).fire).toBe(true);
	});

	it("does not fire done without edit/write", () => {
		const tracker = new ConsultTracker();
		tracker.onToolStart("1", "read", { path: "a" });
		tracker.onToolEnd("1", "read", false);
		expect(tracker.evaluateDone(true, budget).fire).toBe(false);
	});

	it("fires done after substantive output and only once", () => {
		const tracker = new ConsultTracker();
		tracker.onToolStart("1", "write", { path: "a.ts" });
		tracker.onToolEnd("1", "write", false);
		expect(tracker.evaluateDone(true, budget).fire).toBe(true);
		tracker.markDoneFired();
		expect(tracker.evaluateDone(true, budget).fire).toBe(false);
		expect(tracker.consumeTrigger()).toBe("done");
	});

	it("skips done when the loop steer is still pending", () => {
		const tracker = new ConsultTracker();
		tracker.onToolStart("1", "write", { path: "a.ts" });
		tracker.onToolEnd("1", "write", false);
		tracker.markLoopFired();
		expect(tracker.evaluateDone(true, budget).fire).toBe(false);
	});

	it("skips gates when the budget is exhausted", () => {
		const tracker = new ConsultTracker();
		tracker.recordConsult();
		tracker.onToolStart("1", "bash", { command: "ls" });
		tracker.onToolEnd("1", "bash", true);
		tracker.onToolStart("2", "bash", { command: "ls" });
		tracker.onToolEnd("2", "bash", true);
		tracker.onToolStart("3", "bash", { command: "ls" });
		tracker.onToolEnd("3", "bash", true);
		expect(tracker.evaluateLoop(3, budget).fire).toBe(false);
		tracker.onToolStart("4", "edit", { path: "a" });
		tracker.onToolEnd("4", "edit", false);
		expect(tracker.evaluateDone(true, budget).fire).toBe(false);
	});

	it("resets turn state on a user turn but keeps session spend", () => {
		const tracker = new ConsultTracker();
		tracker.recordConsult();
		tracker.onUserTurn();
		expect(tracker.turnCount).toBe(0);
		expect(tracker.sessionCount).toBe(1);
		expect(tracker.lock).toBe(false);
	});
});
