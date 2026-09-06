import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it, vi } from "vitest";
import { ConsultStatusDashboard, type ConsultStatusData } from "../src/dashboard.ts";
import type { ConsultEvent } from "../src/types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
};

function event(overrides: Partial<ConsultEvent> = {}): ConsultEvent {
	return {
		ts: "2026-09-01T12:34:56.000Z",
		session: "sess-1",
		toolCallId: "consult-1",
		trigger: "onDemand",
		why: "check the approach",
		models: ["cursor/fable-5.1"],
		outcome: "completed",
		verdict: "revise",
		adopted: true,
		adoptionEffect: "changed",
		tokensIn: 100,
		tokensOut: 20,
		cacheRead: 300,
		cacheWrite: 0,
		costUsd: 0.125,
		...overrides,
	};
}

function data(overrides: Partial<ConsultStatusData> = {}): ConsultStatusData {
	return {
		panel: [
			{ model: "cursor/fable-5.1", effort: "high" },
			{ model: "cursor/opus-5", effort: "xhigh" },
		],
		fanout: true,
		watchdog: 3,
		budgetRemaining: "2/3 run, 7/8 session",
		recent: [event()],
		...overrides,
	};
}

describe("consult status dashboard", () => {
	it("renders panel, gates, budget, and recent usage without overflowing", () => {
		const dashboard = new ConsultStatusDashboard(data(), theme);
		const lines = dashboard.render(56);
		const output = lines.join("\n");
		expect(output).toContain("pi-consult — status");
		expect(output).toContain("cursor/fable-5.1");
		expect(output).toContain("fanout on  •  watchdog 3");
		expect(output).toContain("2/3 run, 7/8 session");
		expect(output).toContain("revise  changed");
		expect(output).toContain("in 400  •  out 20  •  total 420");
		expect(output).not.toContain("cache");
		expect(output).not.toContain("$");
		expect(lines.every((line) => visibleWidth(line) <= 56)).toBe(true);
	});

	it("shows newest events first and closes with q or escape", () => {
		const dashboard = new ConsultStatusDashboard(
			data({
				recent: [
					event({ ts: "2026-09-01T12:34:56.000Z" }),
					event({ ts: "2026-09-02T12:34:56.000Z", verdict: "recommend" }),
				],
			}),
			theme,
		);
		const output = dashboard.render(100).join("\n");
		expect(output.indexOf("09-02 12:34")).toBeLessThan(output.indexOf("09-01 12:34"));
		const done = vi.fn();
		dashboard.onDone = done;
		dashboard.handleInput("q");
		dashboard.handleInput("\u001b");
		expect(done).toHaveBeenCalledTimes(2);
	});

	it("renders empty and unavailable log states inside the dashboard", () => {
		const empty = new ConsultStatusDashboard(data({ panel: [], recent: [] }), theme).render(80).join("\n");
		expect(empty).toContain("No advisor configured");
		expect(empty).toContain("No consult events yet");
		const unavailable = new ConsultStatusDashboard(
			data({ recent: [], recentError: "Recent consult log is unavailable." }),
			theme,
		).render(80).join("\n");
		expect(unavailable).toContain("Recent consult log is unavailable.");
	});
});
