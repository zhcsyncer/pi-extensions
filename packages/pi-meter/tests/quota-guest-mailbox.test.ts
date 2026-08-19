import { afterEach, describe, expect, it, vi } from "vitest";

const KEY = Symbol.for("@zhcsyncer/pi-meter/quota-adapters");

afterEach(async () => {
	try {
		const { resetQuotaAdapters } = await import("../src/quota/guest.ts");
		resetQuotaAdapters();
	} catch {
		// Module may not have loaded if the test failed first.
	}
	vi.resetModules();
	delete (globalThis as unknown as Record<symbol, unknown>)[KEY];
});

describe("guest mailbox", () => {
	it("keeps an adapter that registered before meter started", async () => {
		(globalThis as unknown as Record<symbol, unknown>)[KEY] = {
			mailbox: [{
				id: "cursor",
				title: "Cursor",
				matchProvider: (provider: string) => provider === "cursor",
				fetch: async () => ({
					provider: "cursor",
					title: "Cursor",
					windows: [],
					fetchedAt: 1,
					ok: false,
				}),
			}],
		};
		const { listQuotaAdapters } = await import("../src/quota/guest.ts");
		const { preferredProvider } = await import("../src/quota/refresh.ts");
		expect(listQuotaAdapters().map((adapter) => adapter.id)).toEqual(["cursor"]);
		expect(preferredProvider({ provider: "cursor" })).toBe("cursor");
		expect(preferredProvider({ provider: "xai" })).toBe("supergrok");
	});
});
