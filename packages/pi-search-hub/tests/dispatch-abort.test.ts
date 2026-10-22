import { describe, expect, it } from "vitest";
import { runTargetedCombine } from "../extensions/dispatch.js";

describe("targeted combine cancellation", () => {
	it("does not start a replacement batch or return partial success after abort", async () => {
		const controller = new AbortController();
		const attempted: string[] = [];
		await expect(runTargetedCombine({
			orderedBackends: ["first", "second", "third", "replacement"],
			query: "fixture", numResults: 6, signal: controller.signal,
			runBackend: async (backend) => {
				attempted.push(backend);
				if (backend === "first") return [{ title: "partial", url: "https://example.com" }];
				controller.abort(new Error("fixture cancellation"));
				throw controller.signal.reason;
			},
		})).rejects.toThrow("fixture cancellation");
		expect(attempted).toEqual(["first", "second", "third"]);
	});

	it("makes no backend request when already cancelled", async () => {
		const signal = AbortSignal.abort(new Error("already cancelled"));
		const attempted: string[] = [];
		await expect(runTargetedCombine({
			orderedBackends: ["first"], query: "fixture", numResults: 1, signal,
			runBackend: async (backend) => { attempted.push(backend); return []; },
		})).rejects.toThrow("already cancelled");
		expect(attempted).toEqual([]);
	});
});
