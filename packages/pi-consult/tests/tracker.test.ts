import { describe, expect, it } from "vitest";
import { DEFAULT_CONSULT_CONFIG } from "../src/config.ts";
import { ConsultTracker } from "../src/tracker.ts";

const budget = DEFAULT_CONSULT_CONFIG.budget;

describe("consult tracker gates", () => {
	it("keeps the watchdog locked until consult ends, then requires fresh evidence", () => {
		const tracker = new ConsultTracker();
		for (let i = 0; i < 3; i++) {
			tracker.onToolStart(String(i), "bash", { command: `probe-${i}` });
			tracker.onToolEnd(String(i), "bash", true);
		}
		expect(tracker.evaluateWatchdog(3, budget)).toEqual({ fire: true, reason: "error" });
		tracker.markWatchdogFired();
		expect(tracker.evaluateWatchdog(3, budget).fire).toBe(false);
		expect(tracker.consumeTrigger()).toBe("watchdog");
		expect(tracker.lock).toBe(true);

		tracker.onToolStart("consult-1", "consult", { why: "review the repeated failures" });
		tracker.onToolEnd("consult-1", "consult", false);
		expect(tracker.lock).toBe(false);
		expect(tracker.evaluateWatchdog(3, budget).fire).toBe(false);

		for (let i = 0; i < 2; i++) {
			tracker.onToolStart(`fresh-${i}`, "bash", { command: `fresh-probe-${i}` });
			tracker.onToolEnd(`fresh-${i}`, "bash", true);
		}
		expect(tracker.evaluateWatchdog(3, budget).fire).toBe(false);
		tracker.onToolStart("fresh-2", "bash", { command: "fresh-probe-2" });
		tracker.onToolEnd("fresh-2", "bash", true);
		expect(tracker.evaluateWatchdog(3, budget)).toEqual({ fire: true, reason: "error" });
	});

	it("an on-demand consult also clears earlier watchdog evidence", () => {
		const tracker = new ConsultTracker();
		tracker.onToolStart("old", "bash", { command: "old-probe" });
		tracker.onToolEnd("old", "bash", true);
		expect(tracker.consumeTrigger()).toBe("onDemand");
		tracker.onToolStart("c", "consult", { why: "x" });
		tracker.onToolEnd("c", "consult", false);
		tracker.onToolStart("1", "bash", { command: "new-probe" });
		tracker.onToolEnd("1", "bash", true);
		expect(tracker.evaluateWatchdog(2, budget).fire).toBe(false);
	});

	it("consult completion clears an unconsumed pending trigger", () => {
		const tracker = new ConsultTracker();
		tracker.markWatchdogFired();
		tracker.onToolEnd("consult-1", "consult", true);
		expect(tracker.lock).toBe(false);
		expect(tracker.pendingTrigger).toBeUndefined();
	});

	it("skips the watchdog when the budget is exhausted", () => {
		const tracker = new ConsultTracker();
		tracker.recordConsult();
		tracker.recordConsult();
		tracker.recordConsult();
		tracker.onToolStart("1", "bash", { command: "ls" });
		tracker.onToolEnd("1", "bash", true);
		tracker.onToolStart("2", "bash", { command: "ls" });
		tracker.onToolEnd("2", "bash", true);
		tracker.onToolStart("3", "bash", { command: "ls" });
		tracker.onToolEnd("3", "bash", true);
		expect(tracker.evaluateWatchdog(3, budget).fire).toBe(false);
	});

	it("resets run state on user input but keeps session spend", () => {
		const tracker = new ConsultTracker();
		tracker.recordConsult();
		tracker.onUserTurn();
		expect(tracker.runCount).toBe(0);
		expect(tracker.sessionCount).toBe(1);
		expect(tracker.lock).toBe(false);
	});
});
