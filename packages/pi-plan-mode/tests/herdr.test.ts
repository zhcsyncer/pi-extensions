import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { HERDR_BLOCKED_EVENT, emitHerdrBlocked, withHerdrBlocked } from "../src/herdr.ts";

function eventApi(onEmit: (event: string, data: unknown) => void): Pick<ExtensionAPI, "events"> {
	return {
		events: { emit: onEmit } as unknown as ExtensionAPI["events"],
	};
}

describe("Herdr blocked event adapter", () => {
	it("balances active state around a successful user interaction", async () => {
		const events: Array<{ event: string; data: unknown }> = [];
		const result = await withHerdrBlocked(
			eventApi((event, data) => events.push({ event, data })),
			"plan review",
			async () => "approved",
		);
		expect(result).toBe("approved");
		expect(events).toEqual([
			{ event: HERDR_BLOCKED_EVENT, data: { active: true, label: "plan review" } },
			{ event: HERDR_BLOCKED_EVENT, data: { active: false } },
		]);
	});

	it("always clears blocked state when the interaction fails", async () => {
		const events: Array<{ event: string; data: unknown }> = [];
		await expect(withHerdrBlocked(
			eventApi((event, data) => events.push({ event, data })),
			"plan approval",
			async () => {
				throw new Error("dialog failed");
			},
		)).rejects.toThrow("dialog failed");
		expect(events.at(-1)).toEqual({ event: HERDR_BLOCKED_EVENT, data: { active: false } });
	});

	it("does not let an optional Herdr listener break Plan behavior", async () => {
		const api = eventApi(() => {
			throw new Error("listener failed");
		});
		expect(() => emitHerdrBlocked(api, true, "plan review")).not.toThrow();
		await expect(withHerdrBlocked(api, "plan approval", async () => 42)).resolves.toBe(42);
	});
});
