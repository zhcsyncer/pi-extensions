import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import type { Usage } from "@earendil-works/pi-ai";
import { aggregate, sumRows } from "../src/ledger/aggregate.ts";
import { statusForLimit } from "../src/ledger/budget.ts";
import { SessionUsageCapture } from "../src/ledger/capture.ts";
import { parseSession } from "../src/ledger/session-parser.ts";
import { readSessionSource } from "../src/ledger/session-source.ts";
import { createLedgerStore, type FileLedgerStore } from "../src/ledger/store.ts";
import { getMeterPaths } from "../src/paths.ts";

const TS = 1773576000000;
const SID = "consult-session";
const CWD = "/fixture/consult";
// Handwritten pre-entryId ledger arrays (f48a91b8): sourceId used the filtered
// advisor ordinal. Do not derive these bytes by stripping a new parser's output.
const legacyLines = readFileSync(new URL("./fixtures/legacy-consult-usage.jsonl", import.meta.url), "utf8").trimEnd().split("\n");
const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true }); });

function usage(total: number): Usage {
	return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
		cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } };
}
const failed = { model: "fixture/advisor-a", error: "failed before usage" };
const b = { model: "fixture/advisor-b", usage: usage(0.02) };
const c = { model: "fixture/advisor-c", usage: usage(0.03) };
type Advisor = { model: string; usage?: Usage; error?: string };

async function fixture(raw: Advisor[], oldLines: string[], toolCallId = "C") {
	const root = mkdtempSync(join(tmpdir(), "meter-legacy-consult-"));
	roots.push(root);
	const file = join(root, "consult-history.jsonl");
	const timestamp = new Date(TS).toISOString();
	writeFileSync(file, [
		{ type: "session", version: 3, id: SID, timestamp, cwd: CWD },
		{ type: "message", id: "consult-entry", parentId: null, timestamp, message: {
			role: "toolResult", toolCallId, toolName: "consult", timestamp: TS, isError: false,
			content: [{ type: "text", text: "Synthetic consult" }],
			usage: usage(raw.reduce((sum, advisor) => sum + (advisor.usage?.cost.total ?? 0), 0)),
			details: { envelope: { raw } },
		} },
	].map(entry => JSON.stringify(entry)).join("\n") + "\n");
	const manager = SessionManager.open(file);
	const paths = getMeterPaths(root);
	mkdirSync(paths.dataDir, { recursive: true });
	const bytes = oldLines.length ? oldLines.join("\n") + "\n" : "";
	writeFileSync(paths.usageFile, bytes);
	const { store } = await createLedgerStore(root);
	return { root, file, manager, store, bytes, ledger: () => readFileSync(paths.usageFile, "utf8") };
}

async function importFile(file: string, store: FileLedgerStore, legacyMatching = true) {
	const aliases = new Map<string, string>();
	const source = (await readSessionSource(file, aliases))!;
	const parsed = parseSession(source.content, source.sid, { origins: source.origins });
	return store.appendRecords(parsed.records, { legacyMatching, sessionAliases: aliases });
}

async function expectMoney(store: FileLedgerStore, count: number, cost: number) {
	const records = await store.readAll();
	expect.soft(records).toHaveLength(count);
	expect.soft(sumRows(aggregate(records, "all", "model", new Date(TS))).cost).toBeCloseTo(cost, 12);
	expect.soft(statusForLimit(records, { scope: "session", period: "day", metric: "cost", max: 1 }, new Date(TS), SID).current).toBeCloseTo(cost, 12);
}

describe("legacy Consult ledger round trip", () => {
	it.each([
		{ name: "one success after a hole", raw: [failed, b], old: legacyLines.slice(0, 1), total: 0.02 },
		{ name: "two successes after a hole", raw: [failed, b, c], old: legacyLines, total: 0.05 },
	].flatMap(test => (["capture", "import"] as const).map(first => ({ ...test, first }))))(
		"$name: $first first preserves old bytes and budget after reopen", async ({ raw, old, total, first }) => {
			const f = await fixture(raw, old);
			const added = first === "capture"
				? await new SessionUsageCapture().capture(f.manager, f.store) : await importFile(f.file, f.store);
			await expectMoney(f.store, old.length, total);
			expect.soft(added).toEqual([]);
			expect.soft(f.ledger()).toBe(f.bytes);
			const reopened = (await createLedgerStore(f.root)).store;
			expect(await new SessionUsageCapture().capture(SessionManager.open(f.file), reopened)).toEqual([]);
			expect(await importFile(f.file, reopened)).toEqual([]);
			await expectMoney(reopened, old.length, total);
			expect(f.ledger()).toBe(f.bytes);
		},
	);

	it.each([
		{ name: "no hole", raw: [b, c], old: legacyLines, call: "C", addedModels: [], count: 2, total: 0.05 },
		{ name: "only the second successful advisor is in old ledger", raw: [failed, b, c], old: legacyLines.slice(1), call: "C", addedModels: [b.model], count: 2, total: 0.05 },
		{ name: "different toolCallId is new work", raw: [failed, b, c], old: legacyLines, call: "D", addedModels: [b.model, c.model], count: 4, total: 0.10 },
		{ name: "identical model and usage in two slots is two expenses", raw: [failed, b, b], old: [], call: "C", addedModels: [b.model, b.model], count: 2, total: 0.04 },
	])("$name", async ({ raw, old, call, addedModels, count, total }) => {
		const f = await fixture(raw, old, call);
		const added = await new SessionUsageCapture().capture(f.manager, f.store);
		expect(added.map(record => record.model)).toEqual(addedModels);
		await expectMoney(f.store, count, total);
		const bytes = f.ledger();
		expect(bytes.startsWith(f.bytes)).toBe(true);
		const reopened = (await createLedgerStore(f.root)).store;
		expect(await importFile(f.file, reopened)).toEqual([]);
		expect(await new SessionUsageCapture().capture(SessionManager.open(f.file), reopened)).toEqual([]);
		await expectMoney(reopened, count, total);
		expect(f.ledger()).toBe(bytes);
	});

	it("new entryId + original raw part deduplicates even with candidate-era sourceIds", async () => {
		const f = await fixture([failed, b, b], []);
		const records = parseSession(readFileSync(f.file, "utf8"), "consult-history").records;
		expect(records.map(record => record.part)).toEqual(["raw:1", "raw:2"]);
		await f.store.appendRecords(records.map((record, index) => ({ ...record, sourceId: `C:${index + 1}` })));
		const reopened = (await createLedgerStore(f.root)).store;
		const bytes = f.ledger();
		expect(await new SessionUsageCapture().capture(f.manager, reopened)).toEqual([]);
		expect(await importFile(f.file, reopened)).toEqual([]);
		await expectMoney(reopened, 2, 0.04);
		expect(f.ledger()).toBe(bytes);
	});

	it("legacyMatching false never spends old sourceId allowances", async () => {
		const f = await fixture([failed, b, c], legacyLines);
		const added = await importFile(f.file, f.store, false);
		expect(added.map(record => record.part)).toEqual(["raw:1", "raw:2"]);
		await expectMoney(f.store, 4, 0.10);
		expect(f.ledger().startsWith(f.bytes)).toBe(true);
	});
});
