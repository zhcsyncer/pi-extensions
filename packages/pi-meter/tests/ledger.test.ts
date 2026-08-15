import { describe, expect, it } from "vitest";
import { aggregate, sumRows } from "../src/ledger/aggregate.ts";
import { budgetKey, statusForLimit } from "../src/ledger/budget.ts";
import { diffRecords, parseSession, usageFromAssistantMessage } from "../src/ledger/session-parser.ts";
import { parseUsageLine, serializeUsageRecord } from "../src/ledger/store.ts";
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
			usage: {
				input: 12,
				output: 3,
				cacheRead: 80,
				cacheWrite: 4,
				totalTokens: 99,
				cost: { total: 0.02 },
			},
		}, { ts: 1000, sid: "ephemeral", cwd: "/work" });
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

	it("treats missing session files as ephemeral so --no-session still records", () => {
		expect(sessionIdFrom(undefined)).toBe("ephemeral");
		expect(sessionIdFrom("/tmp/abc.jsonl")).toBe("abc");
	});
});

describe("aggregation", () => {
	it("keeps input / output / cache read / cache write instead of only total", () => {
		const rows = aggregate([
			rec(),
			rec({ model: "anthropic/claude", in: 50, out: 5, cR: 10, cW: 1, tot: 66, cost: 0.01 }),
		], "all", "model", new Date("2026-08-15T18:00:00Z"));
		expect(rows).toHaveLength(2);
		const grok = rows.find((row) => row.key === "xai/grok-4")!;
		expect(grok).toMatchObject({ input: 100, output: 20, cacheRead: 80, cacheWrite: 10, tokens: 210, turns: 1 });
		const total = sumRows(rows);
		expect(total.input).toBe(150);
		expect(total.output).toBe(25);
		expect(total.cacheRead).toBe(90);
		expect(total.cacheWrite).toBe(11);
	});
});

describe("session import", () => {
	it("parses assistant usage from session JSONL and dedupes by turn", () => {
		const content = [
			JSON.stringify({ type: "session", cwd: "/repo" }),
			JSON.stringify({
				type: "message",
				timestamp: "2026-08-15T12:00:00.000Z",
				message: {
					role: "assistant",
					provider: "anthropic",
					model: "claude",
					usage: { input: 1, output: 2, cacheRead: 3, cacheWrite: 4, totalTokens: 10, cost: { total: 0.1 } },
				},
			}),
		].join("\n");
		const parsed = parseSession(content, "hist");
		expect(parsed.cwd).toBe("/repo");
		expect(parsed.records[0]).toMatchObject({
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
});

describe("ledger serialization", () => {
	it("round-trips compact JSONL rows including costKnown", () => {
		const original = rec({ costKnown: false, cost: 0 });
		const parsed = parseUsageLine(JSON.stringify(serializeUsageRecord(original)));
		expect(parsed).toEqual(original);
	});
});
