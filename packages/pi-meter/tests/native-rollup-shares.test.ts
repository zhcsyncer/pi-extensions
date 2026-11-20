import { describe, expect, it } from "vitest";
import { parseSession, usageFromToolResultMessage } from "../src/ledger/session-parser.ts";

const usage = (scale = 1) => ({
	input: 10 * scale, output: 2 * scale, cacheRead: 3 * scale, cacheWrite: 4 * scale, totalTokens: 19 * scale,
	cost: { input: 0.01 * scale, output: 0.02 * scale, cacheRead: 0.005 * scale, cacheWrite: 0.015 * scale, total: 0.05 * scale },
});
const marker = (reportedUsage: unknown = usage()) => ({
	version: 1, agentId: "child", cumulative: { input: 10000, cost: 100 }, reportedUsage,
});
const message = (shares: unknown[], parentUsage: unknown = usage(2)) => ({
	role: "toolResult", toolName: "codemode", toolCallId: "root-call", timestamp: 1000,
	usage: parentUsage, details: { subagentUsageRollups: shares },
});
const meta = { sid: "parent", cwd: "/offline" };
const records = (value: unknown) => usageFromToolResultMessage(value, meta);

describe("native parent usage shares", () => {
	it("subtracts exact child delta fields while preserving parent work, entry identity and original JSON", () => {
		const value = message([marker(usage()), { ...marker(usage()), agentId: "child-b" }], usage(3));
		const before = JSON.stringify(value);
		const source = JSON.stringify({ type: "message", id: "entry-1", parentId: null, message: value });
		const [result] = parseSession(source, meta.sid).records;
		expect(result).toMatchObject({ entryId: "entry-1", sourceId: "root-call", model: "tool/codemode",
			in: 10, out: 2, cR: 3, cW: 4, tot: 19, costKnown: true });
		expect(result.cost).toBeCloseTo(0.05, 12);
		expect(JSON.stringify(value)).toBe(before);
	});

	it("uses only a resumed claim's delta, not its larger cumulative watermark", () => {
		const delta = usage();
		const [result] = records(message([marker(delta)], delta));
		expect(result).toMatchObject({ in: 0, out: 0, cR: 0, cW: 0, tot: 0, cost: 0, costKnown: true });
	});

	it.each([
		{ version: 1, agentId: "child", cumulative: { cost: 100 } },
		marker(null), marker({}), marker({ ...usage(), input: -1 }),
		marker({ ...usage(), totalTokens: Infinity }),
		marker({ ...usage(), cost: { ...usage().cost, total: NaN } }),
		marker({ ...usage(), cost: { total: 0.05 } }),
		{ ...marker(), version: 2 }, { ...marker(), agentId: "" },
	])("does not guess missing or malformed delta receipts (%#)", receipt => {
		expect(records(message([receipt]))).toEqual(records(message([])));
	});

	it("deducts a valid receipt without interpreting an unsupported sibling", () => {
		const valid = records(message([marker()]));
		expect(records(message([marker(), marker(null)]))).toEqual(valid);
	});

	it.each([
		undefined, { output: 0.02 }, { ...usage().cost, total: undefined },
		{ ...usage().cost, total: -1 }, { ...usage().cost, total: NaN },
	])("preserves unknown parent pricing rather than manufacturing known zero (%#)", cost => {
		const parent = { ...usage(), cost };
		const [result] = records(message([marker()], parent));
		expect(result).toEqual(records(message([], parent))[0]);
		expect(result.costKnown).toBe(false);
	});

	it.each([
		{ ...usage(), input: 21 },
		{ ...usage(), cost: { ...usage().cost, total: 1 } },
	])("does not subtract shares larger than their parent (%#)", share => {
		expect(records(message([marker(share)]))).toEqual(records(message([])));
	});

	it("does not create a negative cost from floating point addition dust", () => {
		const priced = (total: number) => ({ ...usage(0), cost: { input: 0, output: total, cacheRead: 0, cacheWrite: 0, total } });
		const [result] = records(message([marker(priced(0.1)), marker(priced(0.2))], priced(0.3)));
		expect(result.cost).toBe(0);
		expect(result.costKnown).toBe(true);
	});
});
