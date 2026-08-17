import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { displayedPercent, formatResetLong, formatResetShort, quotaTone, renderQuotaBar } from "../src/chrome/format.ts";
import { QuotaDashboard } from "../src/chrome/quota-dashboard.ts";
import { renderUsagePanel, usageSeverity } from "../src/chrome/usage-panel.ts";
import { quotaWindowKind, renderStatusText } from "../src/chrome/widget.ts";
import { computeFooterStats, renderLocalFooter } from "../src/ledger/footer.ts";
import type { AggRow } from "../src/ledger/types.ts";
import { OLLAMA_API_KEY_ERROR } from "../src/quota/auth.ts";
import type { QuotaSnapshot } from "../src/quota/types.ts";

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

function strip(line: string | undefined): string {
	return (line ?? "").replace(/\x1b\[[0-9;]*m/g, "");
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
		const local = renderLocalFooter("today-spend", { today, todayTurns: 3, topModel: "xai/grok-4", budget: null });
		const plain = strip(renderStatusText({
			local,
			quota,
			polarity: "remaining",
			now: new Date("2026-08-15T12:00:00Z"),
		}, theme));
		expect(plain).toBe("· today 12.4k $0.18 · week left ██░░░ 34% (3d)");
	});

	it("keeps the window verb when flipping to used", () => {
		const local = renderLocalFooter("today-spend", { today, todayTurns: 3, topModel: "xai/grok-4", budget: null });
		const plain = strip(renderStatusText({
			local,
			quota,
			polarity: "used",
			now: new Date("2026-08-15T12:00:00Z"),
		}, theme));
		expect(plain.startsWith("· ")).toBe(true);
		expect(plain).toContain("today 12.4k $0.18");
		expect(plain).toContain("week used");
		expect(plain).toContain("66%");
	});

	it("can restore the tracker today-tokens footer without losing quota", () => {
		const now = new Date(2026, 7, 15, 18, 0, 0);
		const stats = computeFooterStats([
			{ ts: now.getTime(), sid: "s", cwd: "/p", model: "xai/grok-4", in: 12400, out: 0, cR: 0, cW: 0, tot: 12400, cost: 0.18, costKnown: true },
		], [], now);
		const local = renderLocalFooter("today-tokens", stats);
		expect(local).toBe("today 12.4k");
		const plain = strip(renderStatusText({
			local,
			quota,
			polarity: "remaining",
			now: new Date("2026-08-15T12:00:00Z"),
		}, theme));
		expect(plain).toBe("· today 12.4k · week left ██░░░ 34% (3d)");
	});

	it("labels Claude 5h and Codex week windows", () => {
		expect(quotaWindowKind({ id: "session", label: "Session (5h)" })).toBe("5h");
		expect(quotaWindowKind({ id: "main-primary", label: "Week limit" })).toBe("week");
	});

	it("renders an Ollama session window without a reset countdown", () => {
		const local = renderLocalFooter("today-spend", { today, todayTurns: 3, topModel: "ollama-cloud/glm", budget: null });
		const plain = strip(renderStatusText({
			local,
			quota: {
				provider: "ollama",
				stale: false,
				window: { id: "session", label: "Session (5h)", usedPercent: 72 },
			},
			polarity: "remaining",
		}, theme));
		expect(plain).toBe("· today 12.4k $0.18 · 5h left █░░░░ 28%");
		expect(plain).not.toContain("(");
	});

	it("names an unsupported provider instead of a foreign quota bar", () => {
		const local = renderLocalFooter("today-spend", { today, todayTurns: 3, topModel: "ollama/llama", budget: null });
		const plain = strip(renderStatusText({
			local,
			quotaHint: { label: "ollama", value: "no quota window" },
			polarity: "remaining",
		}, theme));
		expect(plain).toBe("· today 12.4k $0.18 · ollama · no quota window");
		expect(plain).not.toContain("week left");
		expect(plain).not.toContain("█");
	});

	it("uses quota n/a when the current provider name is empty", () => {
		const local = renderLocalFooter("today-spend", { today, todayTurns: 3, topModel: "xai/grok-4", budget: null });
		const plain = strip(renderStatusText({
			local,
			quotaHint: { label: "quota n/a", value: "no quota window" },
			polarity: "remaining",
		}, theme));
		expect(plain).toBe("· today 12.4k $0.18 · quota n/a · no quota window");
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

function snapshot(over: Partial<QuotaSnapshot> & Pick<QuotaSnapshot, "provider" | "title">): QuotaSnapshot {
	return {
		windows: [],
		fetchedAt: Date.parse("2026-08-15T12:00:00Z"),
		ok: true,
		...over,
	};
}

describe("quota dashboard", () => {
	it("shows the quota report in a temporary dashboard that closes with q", () => {
		const dash = new QuotaDashboard([snapshot({
			provider: "supergrok",
			title: "SuperGrok",
			primary: { id: "weekly", label: "Weekly credits", usedPercent: 51 },
			windows: [{ id: "weekly", label: "Weekly credits", usedPercent: 51 }],
			stale: true,
		})], "remaining", {
			fg: (color, text) => theme.fg(color as never, text),
			bold: (text) => theme.bold(text),
		}, new Date("2026-08-15T12:00:00Z"));
		let closed = false;
		dash.onDone = () => { closed = true; };
		const panel = strip(dash.render(80).join("\n"));
		expect(panel).toContain("pi-meter — subscription quota");
		expect(panel).toContain("display: remaining");
		expect(panel).toContain("SuperGrok (stale)");
		expect(panel).toContain("49%");
		expect(panel).toContain("[q] close");
		dash.handleInput("q");
		expect(closed).toBe(true);
	});
});

describe("usage panel", () => {
	it("shows SuperGrok weekly remaining only", () => {
		const panel = renderUsagePanel([snapshot({
			provider: "supergrok",
			title: "SuperGrok",
			primary: { id: "weekly", label: "Weekly credits", usedPercent: 51, resetsAt: "2026-08-17T16:55:31.897Z" },
			windows: [
				{ id: "weekly", label: "Weekly credits", usedPercent: 51, resetsAt: "2026-08-17T16:55:31.897Z" },
			],
		})], "remaining", new Date("2026-08-15T17:55:31Z"));
		expect(panel).toContain("SuperGrok");
		expect(panel).toContain("Weekly credits");
		expect(panel).toContain("49%");
		expect(panel).toContain("resets in 1d 23h");
		expect(panel).not.toContain("Build");
		expect(panel).not.toContain("Chat");
	});

	it("summarizes unsigned-in providers at the bottom without warning", () => {
		const snapshots = [
			snapshot({
				provider: "claude",
				title: "Claude",
				ok: false,
				error: "no subscription OAuth credentials — run /login",
			}),
			snapshot({
				provider: "codex",
				title: "OpenAI Codex",
				primary: { id: "week", label: "Week limit", usedPercent: 20 },
				windows: [{ id: "week", label: "Week limit", usedPercent: 20 }],
			}),
			snapshot({
				provider: "supergrok",
				title: "SuperGrok",
				ok: false,
				error: "no snapshot yet",
			}),
		];
		const panel = renderUsagePanel(snapshots, "remaining");
		expect(panel).toContain("OpenAI Codex");
		expect(panel).toContain("Week limit");
		expect(panel).toMatch(/OpenAI Codex[\s\S]*Not signed in: Claude, SuperGrok — run \/login$/);
		expect(panel).not.toContain("no subscription OAuth credentials");
		expect(panel).not.toContain("no snapshot yet");
		expect(panel).not.toMatch(/^Claude\n/);
		expect(panel).not.toMatch(/^SuperGrok\n/m);
		expect(usageSeverity(snapshots, "remaining")).toBe("info");
	});

	it("still warns for real refresh errors and low remaining", () => {
		const failed = [
			snapshot({
				provider: "claude",
				title: "Claude",
				ok: false,
				error: "HTTP 500",
			}),
			snapshot({
				provider: "supergrok",
				title: "SuperGrok",
				ok: false,
				error: "no subscription OAuth credentials — run /login",
			}),
		];
		const failedPanel = renderUsagePanel(failed, "remaining");
		expect(failedPanel).toContain("Claude\n  HTTP 500");
		expect(failedPanel.endsWith("Not signed in: SuperGrok — run /login")).toBe(true);
		expect(usageSeverity(failed, "remaining")).toBe("warning");

		const low = [snapshot({
			provider: "claude",
			title: "Claude",
			windows: [{ id: "session", label: "Session (5h)", usedPercent: 70 }],
		})];
		expect(usageSeverity(low, "remaining")).toBe("warning");
	});

	it("treats a missing Ollama Cloud API key as unsigned-in", () => {
		const snapshots = [snapshot({
			provider: "ollama",
			title: "Ollama Cloud",
			ok: false,
			error: OLLAMA_API_KEY_ERROR,
		})];
		const panel = renderUsagePanel(snapshots, "remaining");
		expect(panel).toBe("Not signed in: Ollama Cloud — run /login");
		expect(usageSeverity(snapshots, "remaining")).toBe("info");
	});
});
