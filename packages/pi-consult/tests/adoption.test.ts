import type { SessionEntry } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { ConsultAdoptionStore, resolveConsultAdoptions } from "../src/adoption.ts";

let nextId = 0;

function entry(message: unknown): SessionEntry {
	nextId += 1;
	return {
		type: "message",
		id: `entry-${nextId}`,
		parentId: nextId === 1 ? null : `entry-${nextId - 1}`,
		timestamp: "2026-09-02T00:00:00.000Z",
		message,
	} as SessionEntry;
}

function consultResult(toolCallId: string, overrides: Record<string, unknown> = {}): SessionEntry {
	return entry({
		role: "toolResult",
		toolCallId,
		toolName: "consult",
		content: [{ type: "text", text: "CONSULT-LOG: adopt | changed: <reason>" }],
		isError: false,
		details: { envelope: { verdict: "confirm", summary: "continue", raw: [] } },
		...overrides,
	});
}

function assistant(text: string): SessionEntry {
	return entry({ role: "assistant", content: [{ type: "text", text }] });
}

function user(text = "next"): SessionEntry {
	return entry({ role: "user", content: [{ type: "text", text }] });
}

describe("consult adoption history", () => {
	it("binds an assistant CONSULT-LOG to the preceding consult result", () => {
		const resolved = resolveConsultAdoptions([
			consultResult("consult-1"),
			assistant("CONSULT-LOG: adopt | changed: matches the evidence\n\nContinuing."),
		]);
		expect(resolved.adoptions.get("consult-1")).toEqual({
			adopted: true,
			effect: "changed",
			reason: "matches the evidence",
		});
		expect(resolved.pendingToolCallId).toBeUndefined();
	});

	it("never parses the format hint embedded in the consult tool result", () => {
		const resolved = resolveConsultAdoptions([consultResult("consult-1")]);
		expect(resolved.adoptions.size).toBe(0);
		expect(resolved.pendingToolCallId).toBe("consult-1");
	});

	it("binds only the latest consult instead of falling back to an older pending call", () => {
		const resolved = resolveConsultAdoptions([
			consultResult("consult-1"),
			consultResult("consult-2"),
			assistant("CONSULT-LOG: reject | primary evidence disagrees"),
		]);
		expect(resolved.adoptions.has("consult-1")).toBe(false);
		expect(resolved.adoptions.get("consult-2")).toEqual({
			adopted: false,
			effect: "rejected",
			reason: "primary evidence disagrees",
		});
	});

	it("does not carry an unresolved decision across a later user message", () => {
		const resolved = resolveConsultAdoptions([
			consultResult("consult-1"),
			user(),
			assistant("CONSULT-LOG: adopt | confirmed: unrelated later declaration"),
		]);
		expect(resolved.adoptions.size).toBe(0);
	});

	it("skips failed and error-envelope consult results", () => {
		const failed = consultResult("consult-failed", { isError: true });
		const errorEnvelope = consultResult("consult-error", {
			details: { envelope: { verdict: "recommend", summary: "failed", error: "no model", raw: [] } },
		});
		const resolved = resolveConsultAdoptions([
			failed,
			assistant("CONSULT-LOG: adopt | confirmed: should not bind"),
			errorEnvelope,
			assistant("CONSULT-LOG: reject | should not bind either"),
		]);
		expect(resolved.adoptions.size).toBe(0);
		expect(resolved.pendingToolCallId).toBeUndefined();
	});

	it("restores decisions and invalidates a watched row on live updates", () => {
		const store = new ConsultAdoptionStore();
		store.restore([
			consultResult("consult-restored"),
			assistant("CONSULT-LOG: adopt | confirmed: restored reason"),
		]);
		expect(store.get("consult-restored")).toEqual({
			adopted: true,
			effect: "confirmed",
			reason: "restored reason",
		});

		const invalidate = vi.fn();
		store.watch("consult-live", invalidate);
		store.markConsult("consult-live");
		expect(store.recordLatest({ adopted: false, effect: "rejected", reason: "live reason" })).toBe("consult-live");
		expect(store.get("consult-live")).toEqual({ adopted: false, effect: "rejected", reason: "live reason" });
		expect(invalidate).toHaveBeenCalledOnce();
	});
});
