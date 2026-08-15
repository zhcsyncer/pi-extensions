import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { displayedPercent, quotaTone, renderQuotaBar } from "../src/chrome/format.ts";
import { renderUsagePanel } from "../src/chrome/usage-panel.ts";
import { renderChromeLine } from "../src/chrome/widget.ts";
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

describe("chrome row", () => {
	const quota = {
		provider: "supergrok" as const,
		stale: false,
		window: { id: "weekly", label: "Weekly credits", usedPercent: 66, resetsAt: "2026-08-18T12:00:00Z" },
	};

	it("defaults to compact tokens/cost and keeps the quota bar on the right", () => {
		const [line] = renderChromeLine({
			today,
			tokenDetails: false,
			quota,
			polarity: "remaining",
			now: new Date("2026-08-15T12:00:00Z"),
		}, 80, theme);
		const plain = strip(line);
		expect(plain).toContain("12.4k");
		expect(plain).toContain("$0.18");
		expect(plain).toContain("34%");
		expect(plain).not.toContain("↑");
		expect(plain).toMatch(/╶.*╴/);
	});

	it("shows input / output / cache hit only when details are on", () => {
		const [line] = renderChromeLine({
			today,
			tokenDetails: true,
			quota,
			polarity: "used",
			now: new Date("2026-08-15T12:00:00Z"),
		}, 80, theme);
		const plain = strip(line);
		expect(plain).toContain("↑12.4k");
		expect(plain).toContain("↓2.1k");
		expect(plain).toContain("hit 80k");
		expect(plain).toContain("66%");
	});

	it("drops token details first, then totals, and never exceeds width", () => {
		const wide = strip(renderChromeLine({ today, tokenDetails: true, quota, polarity: "remaining", now: new Date("2026-08-15T12:00:00Z") }, 80, theme)[0]!);
		expect(wide).toContain("↑");
		const mid = strip(renderChromeLine({ today, tokenDetails: true, quota, polarity: "remaining", now: new Date("2026-08-15T12:00:00Z") }, 36, theme)[0]!);
		expect(mid).not.toContain("↑");
		expect(mid).toMatch(/%/);
		const narrow = strip(renderChromeLine({ today, tokenDetails: true, quota, polarity: "remaining", now: new Date("2026-08-15T12:00:00Z") }, 18, theme)[0]!);
		expect(narrow).toMatch(/%|—|╶/);
		for (const width of [12, 18, 36, 80]) {
			for (const line of renderChromeLine({ today, tokenDetails: true, quota, polarity: "remaining", now: new Date("2026-08-15T12:00:00Z") }, width, theme)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});
});

describe("usage panel", () => {
	it("keeps SuperGrok product split in /usage, not the chrome row", () => {
		const panel = renderUsagePanel([{
			provider: "supergrok",
			title: "SuperGrok",
			primary: { id: "weekly", label: "Weekly credits", usedPercent: 66, resetsAt: "2026-08-18T12:00:00Z" },
			windows: [
				{ id: "weekly", label: "Weekly credits", usedPercent: 66, resetsAt: "2026-08-18T12:00:00Z" },
				{ id: "GrokBuild", label: "Build", usedPercent: 10 },
				{ id: "GrokChat", label: "Chat", usedPercent: 80 },
			],
			fetchedAt: Date.parse("2026-08-15T12:00:00Z"),
			ok: true,
		}], "remaining", new Date("2026-08-15T12:00:00Z"));
		expect(panel).toContain("SuperGrok");
		expect(panel).toContain("Weekly credits");
		expect(panel).toContain("Build");
		expect(panel).toContain("Chat");
		expect(panel).toContain("34%");
	});
});
