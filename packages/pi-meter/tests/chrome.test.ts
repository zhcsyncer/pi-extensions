import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { displayedPercent, formatResetLong, formatResetShort, quotaTone, renderQuotaBar } from "../src/chrome/format.ts";
import { renderUsagePanel } from "../src/chrome/usage-panel.ts";
import { quotaWindowKind, renderStatusText } from "../src/chrome/widget.ts";
import type { AggRow } from "../src/ledger/types.ts";

const theme = {
	fg: (_color: string, text: string) => text,
	bold: (text: string) => text,
} as unknown as Theme;

const today: AggRow = {
	key: "",
	label: "",
	tokens: 12400,
	input: 12400,
	output: 2100,
	cacheRead: 80000,
	cacheWrite: 100,
	cost: 0.18,
	costKnown: true,
	turns: 3,
};

function strip(line: string): string {
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

describe("quota polarity and tone", () => {
	it("reverses the displayed number when switching used/remaining", () => {
		expect(displayedPercent(66, "used")).toBe(66);
		expect(displayedPercent(66, "remaining")).toBe(34);
		expect(renderQuotaBar(66, "used")).not.toBe(renderQuotaBar(66, "remaining"));
	});

	it("colors by remaining, not by the displayed polarity", () => {
		expect(quotaTone(66)).toBe("muted");
		expect(quotaTone(70)).toBe("warning");
		expect(quotaTone(86)).toBe("error");
	});
});

describe("status chrome", () => {
	const quota = {
		provider: "supergrok" as const,
		stale: false,
		window: { id: "weekly", label: "Weekly credits", usedPercent: 66, resetsAt: "2026-08-18T12:00:00Z" },
	};

	it("names today's local spend and the weekly remaining window", () => {
		const plain = strip(renderStatusText({
			today,
			tokenDetails: false,
			quota,
			polarity: "remaining",
			now: new Date("2026-08-15T12:00:00Z"),
		}, theme));
		expect(plain).toBe("· today 12.4k $0.18 · week left ██░░░ 34% (3d)");
	});

	it("keeps the window verb when flipping to used", () => {
		const plain = strip(renderStatusText({
			today,
			tokenDetails: true,
			quota,
			polarity: "used",
			now: new Date("2026-08-15T12:00:00Z"),
		}, theme));
		expect(plain.startsWith("· ")).toBe(true);
		expect(plain).toContain("today ↑12.4k ↓2.1k hit 80k");
		expect(plain).toContain("week used");
		expect(plain).toContain("66%");
	});

	it("labels Claude 5h and Codex week windows", () => {
		expect(quotaWindowKind({ id: "session", label: "Session (5h)" })).toBe("5h");
		expect(quotaWindowKind({ id: "main-primary", label: "Week limit" })).toBe("week");
	});
});

describe("reset time", () => {
	it("uses the same remaining duration on the chrome row and in /usage", () => {
		const now = new Date("2026-08-15T17:55:31Z");
		const resetsAt = "2026-08-17T16:55:31.897Z";
		expect(formatResetShort(resetsAt, now)).toBe("1d 23h");
		expect(formatResetLong(resetsAt, now)).toBe("resets in 1d 23h");
	});
});

describe("usage panel", () => {
	it("shows SuperGrok weekly remaining only", () => {
		const panel = renderUsagePanel([{
			provider: "supergrok",
			title: "SuperGrok",
			primary: { id: "weekly", label: "Weekly credits", usedPercent: 51, resetsAt: "2026-08-17T16:55:31.897Z" },
			windows: [
				{ id: "weekly", label: "Weekly credits", usedPercent: 51, resetsAt: "2026-08-17T16:55:31.897Z" },
			],
			fetchedAt: Date.parse("2026-08-15T12:00:00Z"),
			ok: true,
		}], "remaining", new Date("2026-08-15T17:55:31Z"));
		expect(panel).toContain("SuperGrok");
		expect(panel).toContain("Weekly credits");
		expect(panel).toContain("49%");
		expect(panel).toContain("resets in 1d 23h");
		expect(panel).not.toContain("Build");
		expect(panel).not.toContain("Chat");
	});
});
