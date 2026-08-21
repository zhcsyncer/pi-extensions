import { describe, expect, it } from "vitest";
import { visibleWidth } from "@earendil-works/pi-tui";
import { aggregate, sumRows } from "../src/ledger/aggregate.ts";
import { budgetKey, statusForLimit } from "../src/ledger/budget.ts";
import { collapseDuplicateRecords, diffRecords, parseSession, usageFromAssistantMessage } from "../src/ledger/session-parser.ts";
import { parseUsageLine, serializeUsageRecord } from "../src/ledger/store.ts";
import { parseMeterConfig } from "../src/config.ts";
import { sessionIdFrom } from "../src/ledger/time.ts";
import type { UsageRecord } from "../src/ledger/types.ts";

const rec = (over: Partial<UsageRecord> = {}): UsageRecord => ({
	ts: Date.UTC(2026, 7, 15, 12),
	sid: "sess-1",
	cwd: "/tmp/project",
	model: "xai/grok-4",
	in: 100,
	out: 20,
	cR: 80,
	cW: 10,
	tot: 210,
	cost: 0.18,
	costKnown: true,
	...over,
});

describe("usage capture", () => {
	it("maps message_end usage into a local ledger record with cache split", () => {
		const record = usageFromAssistantMessage({
			role: "assistant",
			provider: "xai",
			model: "grok-4",
			timestamp: 1000,
			usage: {
				input: 12,
				output: 3,
				cacheRead: 80,
				cacheWrite: 4,
				totalTokens: 99,
				cost: { total: 0.02 },
			},
		}, { sid: "ephemeral", cwd: "/work" });
		expect(record).toEqual({
			ts: 1000,
			sid: "ephemeral",
			cwd: "/work",
			model: "xai/grok-4",
			in: 12,
			out: 3,
			cR: 80,
			cW: 4,
			tot: 99,
			cost: 0.02,
			costKnown: true,
		});
	});

	it("skips assistant usage without message.timestamp instead of inventing a clock", () => {
		expect(usageFromAssistantMessage({
			role: "assistant",
			provider: "xai",
			model: "grok-4",
			usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { total: 0 } },
		}, { sid: "sess", cwd: "/work" })).toBeUndefined();
	});

	it("treats missing session files as ephemeral so --no-session still records", () => {
		expect(sessionIdFrom(undefined)).toBe("ephemeral");
		expect(sessionIdFrom("/tmp/abc.jsonl")).toBe("abc");
	});
});

describe("aggregation", () => {
	it("counts rolling windows from now and calendar windows from local midnights", () => {
		const now = new Date(2026, 7, 15, 18, 0, 0);
		const yesterdayEvening = rec({ ts: new Date(2026, 7, 14, 20, 0, 0).getTime(), tot: 100, cost: 0.5 });
		const thisMorning = rec({ ts: new Date(2026, 7, 15, 10, 0, 0).getTime(), tot: 50, cost: 0.2 });
		const lastWeek = rec({ ts: new Date(2026, 7, 10, 12, 0, 0).getTime(), tot: 200, cost: 0.1 });
		const records = [yesterdayEvening, thisMorning, lastWeek];
		expect(sumRows(aggregate(records, "today", "model", now, "rolling")).tokens).toBe(150);
		expect(sumRows(aggregate(records, "today", "model", now, "calendar")).tokens).toBe(50);
	});

	it("keeps input / output / cache read / cache write instead of only total", () => {
		const rows = aggregate([
			rec(),
			rec({ model: "anthropic/claude", in: 50, out: 5, cR: 10, cW: 1, tot: 66, cost: 0.01 }),
		], "all", "model", new Date("2026-08-15T18:00:00Z"));
		expect(rows).toHaveLength(2);
		const grok = rows.find((row) => row.key === "xai/grok-4")!;
		expect(grok).toMatchObject({ input: 100, output: 20, cacheRead: 80, cacheWrite: 10, tokens: 210, turns: 1 });
		const total = sumRows(rows);
		expect(total.tokens).toBe(276);
		expect(total.input).toBe(150);
		expect(total.output).toBe(25);
		expect(total.cacheRead).toBe(90);
		expect(total.cacheWrite).toBe(11);
	});
});

describe("compact token format", () => {
	it("uses k / M / B for dashboard-scale counts", async () => {
		const { fmtCompactTokens } = await import("../src/ledger/format.ts");
		expect(fmtCompactTokens(34)).toBe("34");
		expect(fmtCompactTokens(34_000)).toBe("34k");
		expect(fmtCompactTokens(4_300_000)).toBe("4.3M");
		expect(fmtCompactTokens(5_350_000_000)).toBe("5.35B");
	});
});

describe("dashboard", () => {
	it("prints compact token counts next to the in/out/cache split", async () => {
		const { Dashboard } = await import("../src/ledger/dashboard.ts");
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const view = new Dashboard({
			records: [rec({ tot: 4_300_000, in: 34_000, out: 210, cR: 5_350_000_000, cW: 80 })],
			budgets: [],
		}, theme, "all");
		const text = view.render(160).join("\n");
		expect(text).toMatch(/tokens/);
		expect(text).toContain("4.3M");
		expect(text).toContain("34k");
		expect(text).toContain("5.35B");
		expect(text).toMatch(/Total/);
	});

	it("keeps cache write visible at typical TUI widths", async () => {
		const { Dashboard } = await import("../src/ledger/dashboard.ts");
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const view = new Dashboard({
			records: [rec({
				model: "anthropic/claude-sonnet-4-5-very-long-id",
				tot: 4_300_000,
				in: 34_000,
				out: 210,
				cR: 5_350_000_000,
				cW: 777_000,
			})],
			budgets: [],
		}, theme, "all");
		for (const width of [80, 100, 160]) {
			const lines = view.render(width);
			const text = lines.join("\n");
			expect(text).toContain("cache w");
			expect(text).toContain("777k");
			for (const line of lines) {
				if (line.includes("cache w") || line.includes("777k")) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(width);
				}
			}
		}
	});

	it("labels rolling windows as last-N, calendar windows as calendar days", async () => {
		const { Dashboard } = await import("../src/ledger/dashboard.ts");
		const theme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
		const data = { records: [rec()], budgets: [] };
		expect(new Dashboard(data, theme, "today", "rolling").render(80).join("\n")).toContain("Last 24h");
		expect(new Dashboard(data, theme, "today", "calendar").render(80).join("\n")).toContain("Today");
	});
});

describe("session import", () => {
	const messageTs = Date.parse("2026-08-15T12:00:00.000Z");
	const entryIso = "2026-08-15T12:00:30.000Z";

	function jsonl(over: { messageTs?: number | null; entry?: string } = {}): string {
		const message: Record<string, unknown> = {
			role: "assistant",
			provider: "anthropic",
			model: "claude",
			usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0.1 } },
		};
		if (over.messageTs !== null) message.timestamp = over.messageTs ?? messageTs;
		return [
			JSON.stringify({ type: "session", cwd: "/repo" }),
			JSON.stringify({
				type: "message",
				timestamp: over.entry ?? entryIso,
				message,
			}),
		].join("\n");
	}

	it("parses assistant usage from session JSONL and dedupes by turn", () => {
		const parsed = parseSession(jsonl(), "hist");
		expect(parsed.cwd).toBe("/repo");
		expect(parsed.skipped).toBe(0);
		expect(parsed.records[0]).toMatchObject({
			ts: messageTs,
			sid: "hist",
			cwd: "/repo",
			model: "anthropic/claude",
			in: 1,
			out: 2,
			cR: 3,
			cW: 4,
		});
		expect(diffRecords(parsed.records, parsed.records)).toEqual([]);
	});

	it("skips JSONL assistant usage that has no message.timestamp", () => {
		const parsed = parseSession(jsonl({ messageTs: null }), "hist");
		expect(parsed.cwd).toBe("/repo");
		expect(parsed.records).toEqual([]);
		expect(parsed.skipped).toBe(1);
	});

	it("uses message.timestamp rather than the later JSONL entry timestamp", () => {
		const parsed = parseSession(jsonl(), "hist");
		expect(parsed.records[0]?.ts).toBe(messageTs);
		expect(parsed.records[0]?.ts).not.toBe(Date.parse(entryIso));
	});

	it("does not import a live-captured turn when the JSONL entry timestamp is later", () => {
		const live = rec({
			ts: messageTs,
			sid: "hist",
			cwd: "/repo",
			model: "anthropic/claude",
			in: 1,
			out: 2,
			cR: 3,
			cW: 4,
			tot: 10,
			cost: 0.1,
		});
		const parsed = parseSession(jsonl(), "hist");
		expect(parsed.records).toHaveLength(1);
		expect(diffRecords([live], parsed.records)).toEqual([]);
	});

	it("treats an old entry-timestamp import as the same turn as a message.timestamp import", () => {
		const oldImport = rec({
			ts: Date.parse(entryIso),
			sid: "hist",
			cwd: "/repo",
			model: "anthropic/claude",
			in: 1,
			out: 2,
			cR: 3,
			cW: 4,
			tot: 10,
			cost: 0.1,
		});
		expect(diffRecords([oldImport], parseSession(jsonl(), "hist").records)).toEqual([]);
	});

	it("collapses already-written duplicates that share sid/model/tokens and keeps the earlier row", () => {
		const live = rec({ ts: messageTs, sid: "hist", model: "anthropic/claude", in: 1, out: 2, cR: 3, cW: 4, tot: 10 });
		const imported = rec({ ts: Date.parse(entryIso), sid: "hist", model: "anthropic/claude", in: 1, out: 2, cR: 3, cW: 4, tot: 10, cwd: "/other" });
		const other = rec({ ts: messageTs + 5_000, sid: "hist", model: "anthropic/claude", in: 9, out: 2, cR: 3, cW: 4, tot: 18 });
		expect(collapseDuplicateRecords([live, imported, other])).toEqual([live, other]);
		expect(collapseDuplicateRecords([imported, live, other])).toEqual([live, other]);
	});
});

describe("local budgets", () => {
	it("warns from local totals only", () => {
		const now = new Date(2026, 7, 15, 18, 0, 0);
		const limit = { scope: "global" as const, period: "day" as const, metric: "cost" as const, max: 1, warn: 0.1 };
		const status = statusForLimit([rec({ ts: now.getTime(), cost: 0.2 })], limit, now, "sess-1");
		expect(status.warning).toBe(true);
		expect(status.exceeded).toBe(false);
		expect(budgetKey(limit, now)).toContain("cost");
	});

	it("keeps budget periods on the calendar when the ledger is rolling", () => {
		const now = new Date(2026, 7, 15, 18, 0, 0);
		const yesterday = rec({ ts: new Date(2026, 7, 14, 20, 0, 0).getTime(), cost: 0.5 });
		const today = rec({ ts: now.getTime(), cost: 0.2 });
		const limit = { scope: "global" as const, period: "day" as const, metric: "cost" as const, max: 1 };
		const status = statusForLimit([yesterday, today], limit, now, "sess-1");
		expect(status.current).toBe(0.2);
	});
});

describe("config parsing", () => {
	it("folds legacy footer preferences into the grouped footer config", () => {
		const parsed = parseMeterConfig({
			footer: { quota: false },
			quota: { polarity: "used", snapshotTtlMs: 90_000 },
		}, { footerLocal: "today-tokens" });
		expect(parsed.footer).toEqual({
			local: "today-tokens",
			quota: { visible: false, polarity: "used" },
		});
		expect(parsed.quota).toMatchObject({ snapshotTtlMs: 90_000, minRefreshIntervalMs: 30_000 });
		expect(parseMeterConfig({ footerPreset: "full" }).footer.local).toBe("today-spend");
	});

	it("prefers the grouped footer quota settings over legacy fields", () => {
		const parsed = parseMeterConfig({
			footer: { quota: { visible: true, polarity: "remaining" } },
			quota: { polarity: "used" },
			quotaPolarity: "used",
		});
		expect(parsed.footer.quota).toEqual({ visible: true, polarity: "remaining" });
	});

	it("defaults ledger.windowMode to rolling and accepts calendar", () => {
		expect(parseMeterConfig({}).ledger.windowMode).toBe("rolling");
		expect(parseMeterConfig({ ledger: { windowMode: "calendar" } }).ledger.windowMode).toBe("calendar");
		expect(parseMeterConfig({ ledger: { windowMode: "sideways" } }).ledger.windowMode).toBe("rolling");
	});
});

describe("ledger serialization", () => {
	it("round-trips compact JSONL rows including costKnown", () => {
		const original = rec({ costKnown: false, cost: 0 });
		const parsed = parseUsageLine(JSON.stringify(serializeUsageRecord(original)));
		expect(parsed).toEqual(original);
	});
});
