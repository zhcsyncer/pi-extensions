import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { displayedPercent, formatResetLong, formatResetShort, formatSnapshotAge, quotaTone, renderQuotaBar } from "../src/chrome/format.ts";
import { FooterSettingsDashboard } from "../src/chrome/footer-settings.ts";
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
		expect(plain).toBe("· 24h 12.4k $0.18 · xai week left ██░░░ 34% (3d)");
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
		expect(plain).toContain("24h 12.4k $0.18");
		expect(plain).toContain("xai week used");
		expect(plain).toContain("66%");
	});

	it("can restore the tracker today-tokens footer without losing quota", () => {
		const now = new Date(2026, 7, 15, 18, 0, 0);
		const stats = computeFooterStats([
			{ ts: now.getTime(), sid: "s", cwd: "/p", model: "xai/grok-4", in: 12400, out: 0, cR: 0, cW: 0, tot: 12400, cost: 0.18, costKnown: true },
		], [], now);
		const local = renderLocalFooter("today-tokens", stats);
		expect(local).toBe("24h 12.4k");
		const plain = strip(renderStatusText({
			local,
			quota,
			polarity: "remaining",
			now: new Date("2026-08-15T12:00:00Z"),
		}, theme));
		expect(plain).toBe("· 24h 12.4k · xai week left ██░░░ 34% (3d)");
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
		expect(plain).toBe("· 24h 12.4k $0.18 · ollama 5h left █░░░░ 28%");
		expect(plain).not.toContain("(");
	});

	it("names an unsupported provider instead of a foreign quota bar", () => {
		const local = renderLocalFooter("today-spend", { today, todayTurns: 3, topModel: "ollama/llama", budget: null });
		const plain = strip(renderStatusText({
			local,
			quotaHint: { label: "ollama", value: "no quota window" },
			polarity: "remaining",
		}, theme));
		expect(plain).toBe("· 24h 12.4k $0.18 · ollama · no quota window");
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
		expect(plain).toBe("· 24h 12.4k $0.18 · quota n/a · no quota window");
	});

	it("prefixes the quota bar with the short brand", () => {
		const local = renderLocalFooter("today-spend", { today, todayTurns: 3, topModel: "openai-codex/gpt", budget: null });
		const plain = strip(renderStatusText({
			local,
			quota: {
				provider: "codex",
				stale: false,
				window: { id: "week", label: "Week limit", usedPercent: 90, resetsAt: "2026-08-17T12:00:00Z" },
			},
			polarity: "remaining",
			now: new Date("2026-08-15T12:00:00Z"),
		}, theme));
		expect(plain).toBe("· 24h 12.4k $0.18 · openai week left █░░░░ 10% (2d)");
		expect(plain).not.toContain("stale");
	});

	it("adds Codex reset credits only on the Codex footer row", () => {
		const local = renderLocalFooter("today-spend", { today, todayTurns: 3, topModel: "openai-codex/gpt", budget: null });
		const now = new Date("2026-08-15T12:00:00Z");
		const withItems = strip(renderStatusText({
			local,
			quota: {
				provider: "codex",
				stale: false,
				window: { id: "week", label: "Week limit", usedPercent: 90, resetsAt: "2026-08-17T12:00:00Z" },
				resets: {
					availableCount: 2,
					items: [
						{ expiresAt: "2026-08-27T12:00:00Z", title: "Full reset (Weekly + 5h)" },
						{ expiresAt: "2026-09-05T12:00:00Z", title: "Full reset (Weekly + 5h)" },
					],
				},
			},
			polarity: "remaining",
			now,
		}, theme));
		expect(withItems).toBe("· 24h 12.4k $0.18 · openai week left █░░░░ 10% (2d) · 2 resets 12d");

		const countOnly = strip(renderStatusText({
			local,
			quota: {
				provider: "codex",
				stale: false,
				window: { id: "week", label: "Week limit", usedPercent: 90, resetsAt: "2026-08-17T12:00:00Z" },
				resets: { availableCount: 2 },
			},
			polarity: "remaining",
			now,
		}, theme));
		expect(countOnly).toBe("· 24h 12.4k $0.18 · openai week left █░░░░ 10% (2d) · 2 resets");
		expect(countOnly).not.toMatch(/2 resets \d/);

		const none = strip(renderStatusText({
			local,
			quota: {
				provider: "codex",
				stale: false,
				window: { id: "week", label: "Week limit", usedPercent: 90, resetsAt: "2026-08-17T12:00:00Z" },
				resets: { availableCount: 0 },
			},
			polarity: "remaining",
			now,
		}, theme));
		expect(none).toBe("· 24h 12.4k $0.18 · openai week left █░░░░ 10% (2d)");
		expect(none).not.toContain("reset");
	});

	it("does not borrow Codex resets onto another vendor's footer", () => {
		const local = renderLocalFooter("today-spend", { today, todayTurns: 3, topModel: "xai/grok-4", budget: null });
		const plain = strip(renderStatusText({
			local,
			quota: {
				provider: "supergrok",
				stale: false,
				window: { id: "weekly", label: "Weekly credits", usedPercent: 66, resetsAt: "2026-08-18T12:00:00Z" },
			},
			polarity: "remaining",
			now: new Date("2026-08-15T12:00:00Z"),
		}, theme));
		expect(plain).toBe("· 24h 12.4k $0.18 · xai week left ██░░░ 34% (3d)");
		expect(plain).not.toContain("reset");
	});

	it("shows snapshot age on the footer only when the snapshot is past TTL", () => {
		const local = renderLocalFooter("today-spend", { today, todayTurns: 3, topModel: "xai/grok-4", budget: null });
		const now = new Date("2026-08-15T12:00:00Z");
		const stale = strip(renderStatusText({
			local,
			quota: {
				provider: "supergrok",
				stale: true,
				fetchedAt: Date.parse("2026-08-15T11:48:00Z"),
				window: { id: "weekly", label: "Weekly credits", usedPercent: 66, resetsAt: "2026-08-18T12:00:00Z" },
			},
			polarity: "remaining",
			now,
		}, theme));
		expect(stale).toBe("· 24h 12.4k $0.18 · xai week left ██░░░ 34% (3d) 12m ago");
		expect(stale).not.toContain("stale");

		const fresh = strip(renderStatusText({
			local,
			quota: {
				provider: "supergrok",
				stale: false,
				fetchedAt: Date.parse("2026-08-15T11:48:00Z"),
				window: { id: "weekly", label: "Weekly credits", usedPercent: 66, resetsAt: "2026-08-18T12:00:00Z" },
			},
			polarity: "remaining",
			now,
		}, theme));
		expect(fresh).toBe("· 24h 12.4k $0.18 · xai week left ██░░░ 34% (3d)");
		expect(fresh).not.toContain("ago");
		expect(fresh).not.toContain("stale");
	});

	it("keeps SuperGrok failure on xai instead of drawing a Codex bar", () => {
		const local = renderLocalFooter("today-spend", { today, todayTurns: 3, topModel: "xai/grok-4", budget: null });
		const plain = strip(renderStatusText({
			local,
			quotaHint: { label: "xai", value: "unavailable" },
			polarity: "remaining",
		}, theme));
		expect(plain).toBe("· 24h 12.4k $0.18 · xai · unavailable");
		expect(plain).not.toContain("week left");
		expect(plain).not.toContain("█");
	});
});

describe("reset time", () => {
	it("uses the same remaining duration on the chrome row and in /usage", () => {
		const now = new Date("2026-08-15T17:55:31Z");
		const resetsAt = "2026-08-17T16:55:31.897Z";
		expect(formatResetShort(resetsAt, now)).toBe("1d 23h");
		expect(formatResetLong(resetsAt, now)).toBe("resets in 1d 23h");
		expect(formatSnapshotAge(Date.parse("2026-08-15T17:43:31Z"), now)).toBe("12m ago");
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

describe("footer settings dashboard", () => {
	it("previews and saves all footer settings together", () => {
		const dash = new FooterSettingsDashboard({
			footer: {
				local: "today-spend",
				quota: { visible: true, polarity: "remaining" },
			},
			windowMode: "rolling",
		}, {
			stats: { today, todayTurns: 3, topModel: "ollama-cloud/glm", budget: null },
			quota: {
				provider: "ollama",
				stale: false,
				window: { id: "session", label: "Session (5h)", usedPercent: 72 },
			},
		}, {
			fg: (color, text) => theme.fg(color as never, text),
			bold: (text) => theme.bold(text),
		});
		const initial = strip(dash.render(100).join("\n"));
		expect(initial).toContain("pi-meter — footer settings");
		expect(initial).toContain("24h 12.4k $0.18");
		expect(initial).toContain("ollama 5h left");

		dash.handleInput(" ");
		dash.handleInput("\x1b[B");
		dash.handleInput(" ");
		dash.handleInput("\x1b[B");
		dash.handleInput(" ");
		let saved: ReturnType<typeof dash.settings> | undefined;
		dash.onDone = (value) => { saved = value; };
		dash.handleInput("q");
		expect(saved).toEqual({
			footer: {
				local: "today-tokens",
				quota: { visible: false, polarity: "used" },
			},
			windowMode: "rolling",
		});
		const changed = strip(dash.render(100).join("\n"));
		expect(changed).toContain("24h 12.4k");
		expect(changed).not.toContain("5h used");
	});

	it("can switch the local window mode", () => {
		const dash = new FooterSettingsDashboard({
			footer: {
				local: "today-spend",
				quota: { visible: true, polarity: "remaining" },
			},
			windowMode: "rolling",
		}, {
			stats: { today, todayTurns: 3, topModel: "xai/grok-4", budget: null },
		}, {
			fg: (color, text) => theme.fg(color as never, text),
			bold: (text) => theme.bold(text),
		});
		dash.handleInput("\x1b[B");
		dash.handleInput("\x1b[B");
		dash.handleInput("\x1b[B");
		dash.handleInput(" ");
		expect(dash.settings().windowMode).toBe("calendar");
		const preview = strip(dash.render(100).join("\n"));
		expect(preview).toContain("today 12.4k $0.18");
		expect(preview).not.toContain("24h");
	});
});

describe("quota dashboard", () => {
	it("shows the quota report in a temporary dashboard that closes with q", () => {
		const dash = new QuotaDashboard([snapshot({
			provider: "supergrok",
			title: "SuperGrok",
			primary: { id: "weekly", label: "Weekly credits", usedPercent: 51 },
			windows: [{ id: "weekly", label: "Weekly credits", usedPercent: 51 }],
			fetchedAt: Date.parse("2026-08-15T11:48:00Z"),
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
		expect(panel).toContain("SuperGrok · 12m ago");
		expect(panel).not.toContain("stale");
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
		expect(panel).not.toContain("stale");
	});

	it("shows Codex banked resets with expiry details", () => {
		const panel = renderUsagePanel([snapshot({
			provider: "codex",
			title: "OpenAI Codex (plus)",
			primary: { id: "main-primary", label: "5h limit", usedPercent: 58, resetsAt: "2026-08-15T16:00:00Z" },
			windows: [
				{ id: "main-primary", label: "5h limit", usedPercent: 58, resetsAt: "2026-08-15T16:00:00Z" },
				{ id: "main-secondary", label: "Week limit", usedPercent: 93, resetsAt: "2026-08-21T12:00:00Z" },
			],
			fetchedAt: Date.parse("2026-08-15T11:48:00Z"),
			resets: {
				availableCount: 2,
				items: [
					{ expiresAt: "2026-08-27T12:00:00Z", title: "Full reset (Weekly + 5h)" },
					{ expiresAt: "2026-09-05T08:59:00Z", title: "Full reset (Weekly + 5h)" },
				],
			},
		})], "remaining", new Date("2026-08-15T12:00:00Z"));
		expect(panel).toContain("OpenAI Codex (plus) · 12m ago");
		expect(panel).toContain("5h limit");
		expect(panel).toContain("Week limit");
		expect(panel).toContain("2 available · next 12d");
		expect(panel).toContain("#1 Full reset (Weekly + 5h) · Aug 27 12:00 (12d)");
		expect(panel).toContain("#2 Full reset (Weekly + 5h) · Sep 5 08:59 (20d 20h)");
		expect(panel).not.toContain("stale");
		expect(panel).not.toContain("RateLimitResetCredit_");
	});

	it("keeps Codex reset count without fake expiry when details are missing", () => {
		const panel = renderUsagePanel([snapshot({
			provider: "codex",
			title: "OpenAI Codex (plus)",
			windows: [{ id: "week", label: "Week limit", usedPercent: 20 }],
			resets: { availableCount: 2 },
		})], "remaining", new Date("2026-08-15T12:00:00Z"));
		expect(panel).toContain("2 available");
		expect(panel).not.toContain("next");
		expect(panel).not.toContain("#1");
	});

	it("hides the Codex resets block when count is 0", () => {
		const panel = renderUsagePanel([snapshot({
			provider: "codex",
			title: "OpenAI Codex",
			windows: [{ id: "week", label: "Week limit", usedPercent: 20 }],
			resets: { availableCount: 0 },
		})], "remaining", new Date("2026-08-15T12:00:00Z"));
		expect(panel).toContain("Week limit");
		expect(panel).not.toContain("Resets");
		expect(panel).not.toContain("available");
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
		const failedPanel = renderUsagePanel(failed, "remaining", new Date("2026-08-15T12:00:00Z"));
		expect(failedPanel).toContain("Claude\n  HTTP 500");
		expect(failedPanel).not.toContain("stale");
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
