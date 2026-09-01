import { describe, expect, it } from "vitest";
import {
	emptyFingerprintState,
	hadSubstantiveOutput,
	loopGateReason,
	recordToolEvent,
	toolFingerprint,
} from "../src/fingerprint.ts";

describe("tool fingerprint", () => {
	it("normalizes key order so equivalent inputs match", () => {
		expect(toolFingerprint("edit", { path: "a.ts", oldText: "x" })).toBe(
			toolFingerprint("edit", { oldText: "x", path: "a.ts" }),
		);
	});

	it("treats consult events as invisible", () => {
		let state = emptyFingerprintState();
		state = recordToolEvent(state, { name: "consult", input: { why: "x" }, isError: false });
		state = recordToolEvent(state, { name: "read", input: { path: "a" }, isError: false });
		expect(state.recent.map((event) => event.name)).toEqual(["read"]);
	});

	it("fires the same-call loop after N identical fingerprints", () => {
		let state = emptyFingerprintState();
		for (let i = 0; i < 3; i++) {
			state = recordToolEvent(state, { name: "bash", input: { command: "ls" }, isError: false });
		}
		expect(loopGateReason(state, 3)).toBe("same");
		expect(loopGateReason(state, 4)).toBeUndefined();
	});

	it("fires the error loop after N consecutive errors even with different tools", () => {
		let state = emptyFingerprintState();
		state = recordToolEvent(state, { name: "read", input: { path: "a" }, isError: true });
		state = recordToolEvent(state, { name: "bash", input: { command: "x" }, isError: true });
		state = recordToolEvent(state, { name: "edit", input: { path: "b" }, isError: true });
		expect(loopGateReason(state, 3)).toBe("error");
	});

	it("resets both streaks on a different successful call", () => {
		let state = emptyFingerprintState();
		state = recordToolEvent(state, { name: "bash", input: { command: "ls" }, isError: true });
		state = recordToolEvent(state, { name: "bash", input: { command: "ls" }, isError: true });
		state = recordToolEvent(state, { name: "read", input: { path: "ok" }, isError: false });
		expect(loopGateReason(state, 2)).toBeUndefined();
	});

	it("detects edit/write as substantive output", () => {
		let state = emptyFingerprintState();
		state = recordToolEvent(state, { name: "read", input: { path: "a" }, isError: false });
		expect(hadSubstantiveOutput(state)).toBe(false);
		state = recordToolEvent(state, { name: "edit", input: { path: "a" }, isError: false });
		expect(hadSubstantiveOutput(state)).toBe(true);
	});
});
