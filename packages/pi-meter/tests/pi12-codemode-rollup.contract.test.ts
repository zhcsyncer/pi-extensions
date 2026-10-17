import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseSession, usageRecordsFromSessionEntry } from "../src/ledger/session-parser.ts";
import { FileLedgerStore } from "../src/ledger/store.ts";
import type { UsageRecord } from "../src/ledger/types.ts";
import { getMeterPaths } from "../src/paths.ts";

// Independent public R2 protocol oracle. No producer/consumer implementation,
// implementer tests or SDK-to-ledger probes were consulted. Fixtures are separate
// from the producer contract so a shared producer mistake cannot define the oracle.
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });
const cwd = "/fixture/project";
const timestamp = "2026-01-02T03:04:05.000Z";
const time = Date.parse(timestamp);
function usage(units: number, dollars: number) {
  return { input: 10 * units, output: 2 * units, cacheRead: 3 * units, cacheWrite: units, totalTokens: 16 * units,
    cost: { input: dollars, output: 0, cacheRead: 0, cacheWrite: 0, total: dollars } };
}
function receipt(agentId: string, deltaUnits: number, deltaCost: number, lifetimeUnits = deltaUnits, lifetimeCost = deltaCost) {
  const lifetime = usage(lifetimeUnits, lifetimeCost);
  return { version: 1, agentId, cumulative: { input: lifetime.input, output: lifetime.output, cacheRead: lifetime.cacheRead,
    cacheWrite: lifetime.cacheWrite, cost: lifetimeCost,
    costBreakdown: { input: lifetimeCost, output: 0, cacheRead: 0, cacheWrite: 0 } },
    reportedUsage: usage(deltaUnits, deltaCost) };
}
function tool(id: string, nativeUsage: unknown, receipts?: unknown[]) {
  return { type: "message", id, parentId: null, timestamp, message: {
    role: "toolResult", toolCallId: `call-${id}`, toolName: "codemode", timestamp: time,
    content: [{ type: "text", text: "Script completed" }], isError: false, usage: nativeUsage,
    details: receipts === undefined ? {} : { subagentUsageRollups: receipts },
  } };
}
function standalone(id: string, units: number, dollars: number) {
  return { type: "usage", id, parentId: null, timestamp, kind: "contract-standalone", provider: "contract", model: "offline",
    usage: usage(units, dollars) };
}
function childTool(id: string, units: number, dollars: number) {
  const entry = tool(id, usage(units, dollars));
  entry.message.toolName = "charged_tool";
  return entry;
}
function parsed(sid: string, entries: Array<{ id: string; parentId: string | null }>) {
  const model = { type: "model_change", id: "model", parentId: null, timestamp, provider: "contract", modelId: "offline" };
  const linked = entries.map((entry, i) => ({ ...entry, parentId: i === 0 ? model.id : entries[i - 1].id }));
  const content = [{ type: "session", version: 3, id: sid, timestamp, cwd }, model, ...linked].map(e => JSON.stringify(e)).join("\n") + "\n";
  const before = structuredClone(entries);
  const backfill = parseSession(content, sid);
  const live = linked.flatMap(entry => usageRecordsFromSessionEntry(entry, { sid, cwd }, "contract/offline"));
  expect(backfill.cwd).toBe(cwd); expect(backfill.sid).toBe(sid);
  expect(live, "live and backfill must use the same finalized-entry protocol").toEqual(backfill.records);
  expect(entries, "parsing must not edit SDK usage/details").toEqual(before);
  expect(content).toBe([{ type: "session", version: 3, id: sid, timestamp, cwd }, model, ...linked].map(e => JSON.stringify(e)).join("\n") + "\n");
  for (const row of live) {
    expect(row.sid).toBe(sid); expect(row.cwd).toBe(cwd);
    expect(entries.map(e => e.id)).toContain(row.entryId);
    for (const value of [row.in, row.out, row.cR, row.cW, row.tot, row.cost]) expect(value).toBeGreaterThanOrEqual(0);
  }
  return backfill.records;
}
const sum = (rows: UsageRecord[]) => rows.reduce((total, row) => total + row.cost, 0);
function ledger() {
  const root = mkdtempSync(join(tmpdir(), "pi12-meter-contract-")); roots.push(root);
  const paths = getMeterPaths(root);
  return { paths, store: new FileLedgerStore(paths) };
}
async function append(store: FileLedgerStore, records: UsageRecord[]) {
  for (const row of records) expect(await store.append(row)).toBe(true);
}
function expectParentRemainder(rows: UsageRecord[], id: string) {
  expect(rows).toHaveLength(1);
  expect.soft(rows[0]).toMatchObject({ sid: "parent", cwd, entryId: id, in: 20, out: 4, cR: 6, cW: 2, tot: 32, costKnown: true });
  expect.soft(rows[0].cost).toBeCloseTo(0.02, 12);
}

describe("Pi 1.2 public mixed codemode rollup protocol", () => {
  it("preserves parent 0.02 plus child 0.05, then subtracts only the new 0.02 delta rather than cumulative 0.07", async () => {
    const { store, paths } = ledger();
    const parent = parsed("parent", [tool("mixed", usage(7, 0.07), [receipt("child", 5, 0.05)])]);
    const child = parsed("child", [childTool("child-tool", 2, 0.02), standalone("child-standalone", 3, 0.03)]);
    // Soft checks keep the ledger observation reachable on the old consumer.
    expect.soft(parent[0]).toMatchObject({ entryId: "mixed", in: 20, out: 4, cR: 6, cW: 2, tot: 32, costKnown: true });
    expect.soft(sum(parent)).toBeCloseTo(0.02, 12);
    await append(store, [...parent, ...child]);
    expect.soft(sum(await store.readAll())).toBeCloseTo(0.07, 12);

    const nextParent = parsed("parent", [tool("continued", usage(2, 0.02), [receipt("child", 2, 0.02, 7, 0.07)])]);
    const nextChild = parsed("child", [childTool("child-next", 2, 0.02)]);
    expect.soft(sum(nextParent)).toBe(0);
    expect.soft(nextParent.reduce((n, row) => n + row.tot, 0)).toBe(0);
    await append(store, [...nextParent, ...nextChild]);
    expect.soft(sum(await store.readAll())).toBeCloseTo(0.09, 12);
    const reopened = new FileLedgerStore(paths);
    for (const row of [...parent, ...child, ...nextParent, ...nextChild]) expect(await reopened.append(row)).toBe(false);
    expect.soft(sum(await reopened.readAll())).toBeCloseTo(0.09, 12);
  });

  it("subtracts multiple child deltas and preserves entry identity across live/backfill ledger replay", async () => {
    const { store, paths } = ledger();
    const original = tool("batch", usage(10, 0.10), [receipt("a", 5, 0.05), receipt("b", 3, 0.03)]);
    const parent = parsed("parent", [original]);
    const children = [...parsed("a", [childTool("a-tool", 2, 0.02), standalone("a-extra", 3, 0.03)]),
      ...parsed("b", [childTool("b-tool", 3, 0.03)])];
    expectParentRemainder(parent, "batch");
    await append(store, [...parent, ...children]);
    expect.soft(sum(await store.readAll())).toBeCloseTo(0.10, 12);
    const backfillAgain = parsed("parent", [original]);
    const reopened = new FileLedgerStore(paths);
    for (const row of [...backfillAgain, ...children]) expect(await reopened.append(row)).toBe(false);
    expect(await reopened.readAll()).toHaveLength(parent.length + children.length);
    expect.soft(sum(await reopened.readAll())).toBeCloseTo(0.10, 12);
  });

  it("does not guess a deduction from a missing, malformed or impossible reported delta", () => {
    const current = receipt("child", 5, 0.05);
    const { reportedUsage: _reported, ...legacy } = current;
    const baseline = parsed("parent", [tool("unchanged", usage(7, 0.07))]);
    expect(baseline).toHaveLength(1); expect(sum(baseline)).toBeCloseTo(0.07, 12);
    for (const marker of [legacy, { ...current, reportedUsage: { cost: { total: 0.05 } } },
      { ...current, reportedUsage: usage(8, 0.08) }, { ...current, reportedUsage: usage(-1, -0.01) }]) {
      expect(parsed("parent", [tool("unchanged", usage(7, 0.07), [marker])])).toEqual(baseline);
    }
  });

  it("never turns unknown parent cost into known zero while processing valid child receipts", async () => {
    const { cost: _cost, ...unknown } = usage(7, 0.07);
    const entry = tool("unknown", unknown, [receipt("child", 5, 0.05)]);
    const records = parsed("parent", [entry]);
    expect(records).toHaveLength(1); expect(records[0].costKnown).toBe(false);
    expect(records[0].entryId).toBe("unknown");
    const { store } = ledger(); await append(store, records);
    expect((await store.readAll())[0].costKnown).toBe(false);
    expect(entry.message.usage).toEqual(unknown);
  });
});
