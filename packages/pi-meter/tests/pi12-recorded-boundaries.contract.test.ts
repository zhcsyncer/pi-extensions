import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SessionManager, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { aggregate, sumToday } from "../src/ledger/aggregate.ts";
import { statusForLimit } from "../src/ledger/budget.ts";
import { SessionUsageCapture } from "../src/ledger/capture.ts";
import { createLedgerStore } from "../src/ledger/store.ts";
import type { BudgetLimit, UsageRecord } from "../src/ledger/types.ts";
import { getMeterPaths } from "../src/paths.ts";

const temporaryDirectories: string[] = [];
const now = new Date(2026, 5, 3, 12);
const timestamp = now.getTime();
const sessionId = "independent-recorded-boundaries";
const costLimit: BudgetLimit = { scope: "global", period: "day", metric: "cost", max: 0.08 };

async function temporaryDirectory() {
	const directory = await mkdtemp(join(tmpdir(), "pi-meter-recorded-boundaries-"));
	temporaryDirectories.push(directory);
	return directory;
}

afterEach(async () => {
	await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

type LegacyFormat = "array" | "object";

// These are independently authored old-format rows, not output from Meter's serializer.
function legacyLines(format: LegacyFormat, cwd: string, cost: number, costKnown: boolean) {
	const rows = format === "array"
		? [
			[timestamp - 1, sessionId, cwd, "synthetic-model", 10, 2, 0, 0, 12, 0.10, 1, "anchor"],
			[timestamp, sessionId, cwd, "synthetic-model", 5, 1, 0, 0, 6, cost, costKnown ? 1 : 0, "candidate"],
		]
		: [
			{ ts: timestamp - 1, sid: sessionId, cwd, model: "synthetic-model", in: 10, out: 2, cR: 0, cW: 0, tot: 12, cost: 0.10, costKnown: true, sourceId: "anchor" },
			{ ts: timestamp, sid: sessionId, cwd, model: "synthetic-model", in: 5, out: 1, cR: 0, cW: 0, tot: 6, cost, costKnown, sourceId: "candidate" },
		];
	return `${rows.map((row) => JSON.stringify(row)).join("\n")}\n`;
}

async function legacyLedger(format: LegacyFormat, cost: number, costKnown: boolean) {
	const directory = await temporaryDirectory();
	const agentDir = join(directory, "agent");
	const paths = getMeterPaths(agentDir);
	const original = Buffer.from(legacyLines(format, directory, cost, costKnown));
	await mkdir(paths.dataDir, { recursive: true });
	await writeFile(paths.usageFile, original);
	const { store } = await createLedgerStore(agentDir);
	return { agentDir, paths, original, store };
}

function expectSubtotal(records: UsageRecord[], cost: number, unknownCosts: number) {
	const total = sumToday(records, now);
	expect.soft(total.cost).toBeCloseTo(cost, 10);
	// The known anchor establishes a known portion; unknownCosts tracks completeness.
	expect.soft(total.costKnown).toBe(true);
	expect.soft(total.unknownCosts ?? 0).toBe(unknownCosts);
	const rows = aggregate(records, "all", "model", now);
	expect(rows).toHaveLength(1);
	expect.soft(rows[0].cost).toBeCloseTo(cost, 10);
	expect.soft(rows[0].costKnown).toBe(true);
	expect.soft(rows[0].unknownCosts ?? 0).toBe(unknownCosts);
	expect.soft(statusForLimit(records, costLimit, now, sessionId).current).toBeCloseTo(cost, 10);
}

describe.each<LegacyFormat>(["array", "object"])("old %s ledger cost boundaries", (format) => {
	it("does not let a negative cost reduce the subtotal or budget, or rewrite the original ledger", async () => {
		const { store, agentDir, paths, original } = await legacyLedger(format, -0.04, true);
		const records = await store.readAll();
		expect(records).toHaveLength(2);
		expect.soft(records[1].cost).toBeCloseTo(0, 10);
		expect.soft(records[1].costKnown).toBe(false);
		expectSubtotal(records, 0.10, 1);
		expect.soft(statusForLimit(records, costLimit, now, sessionId).exceeded).toBe(true);
		expect.soft(await readFile(paths.usageFile)).toEqual(original);

		const reopened = await createLedgerStore(agentDir);
		const reread = await reopened.store.readAll();
		expect(reread).toHaveLength(2);
		expectSubtotal(reread, 0.10, 1);
		expect.soft(await readFile(paths.usageFile)).toEqual(original);
	});

	it.each([
		{ name: "positive known cost", cost: 0.03, costKnown: true, subtotal: 0.13, unknownCosts: 0 },
		{ name: "explicit known zero", cost: 0, costKnown: true, subtotal: 0.10, unknownCosts: 0 },
		{ name: "positive partial cost", cost: 0.04, costKnown: false, subtotal: 0.14, unknownCosts: 1 },
	])("positive control: preserves $name", async ({ cost, costKnown, subtotal, unknownCosts }) => {
		const { store, agentDir, paths, original } = await legacyLedger(format, cost, costKnown);
		const records = await store.readAll();
		expect(records).toHaveLength(2);
		// In particular, a known zero remains known even without the positive anchor.
		const candidate = sumToday([records[1]], now);
		expect.soft(candidate.cost).toBeCloseTo(cost, 10);
		expect.soft(candidate.costKnown).toBe(costKnown);
		expectSubtotal(records, subtotal, unknownCosts);
		const reopened = await createLedgerStore(agentDir);
		expectSubtotal(await reopened.store.readAll(), subtotal, unknownCosts);
		expect.soft(await readFile(paths.usageFile)).toEqual(original);
	});
});

// Deliberately expose exactly the SDK's readonly surface, not the concrete manager's
// extra getEntryCount method. Every operation still runs against the real SDK tree.
function readonlyManager(manager: SessionManager): ExtensionContext["sessionManager"] {
	return Object.freeze({
		getCwd: manager.getCwd.bind(manager),
		getSessionDir: manager.getSessionDir.bind(manager),
		getSessionId: manager.getSessionId.bind(manager),
		getSessionFile: manager.getSessionFile.bind(manager),
		getLeafId: manager.getLeafId.bind(manager),
		getLeafEntry: manager.getLeafEntry.bind(manager),
		getEntry: manager.getEntry.bind(manager),
		getLabel: manager.getLabel.bind(manager),
		getBranch: manager.getBranch.bind(manager),
		buildContextEntries: manager.buildContextEntries.bind(manager),
		buildSessionProjection: manager.buildSessionProjection.bind(manager),
		getHeader: manager.getHeader.bind(manager),
		getEntries: manager.getEntries.bind(manager),
		getTree: manager.getTree.bind(manager),
		getSessionName: manager.getSessionName.bind(manager),
	});
}

function appendAssistant(manager: SessionManager, cost: number) {
	return manager.appendMessage({
		role: "assistant",
		content: [{ type: "text", text: "Synthetic offline accounting fixture" }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "synthetic-model",
		usage: {
			input: 10,
			output: 2,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 12,
			cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
		},
		stopReason: "stop",
		timestamp,
	});
}

function recordedCost(records: UsageRecord[]) {
	return records.reduce((total, record) => total + record.cost, 0);
}

describe("capture through the real SDK readonly session interface", () => {
	it.each(["another existing branch", "the same previously captured leaf", "normal sequential append"] as const)(
		"counts a between-captures append exactly once with %s",
		async (navigation) => {
			const directory = await temporaryDirectory();
			const cwd = join(directory, "project");
			await mkdir(cwd);
			const manager = SessionManager.create(cwd, join(directory, "sessions"));
			const root = manager.appendMessage({ role: "user", content: "Offline branch fixture", timestamp });
			const firstBranch = appendAssistant(manager, 0.10);
			manager.branch(root);
			const otherBranch = appendAssistant(manager, 0.20);
			manager.branch(firstBranch);
			const readonly = readonlyManager(manager);
			expect("getEntryCount" in readonly).toBe(false);
			const { store } = await createLedgerStore(join(directory, "agent"));
			const capture = new SessionUsageCapture();

			const initial = await capture.capture(readonly, store);
			expect(initial).toHaveLength(2);
			expect(recordedCost(initial)).toBeCloseTo(0.30, 10);
			expect(await store.readAll()).toHaveLength(2);

			const lateEntry = appendAssistant(manager, 0.40);
			if (navigation === "another existing branch") manager.branch(otherBranch);
			if (navigation === "the same previously captured leaf") manager.branch(firstBranch);
			// Confirm the SDK preserved the append, including when it is off-branch.
			expect(readonly.getEntries().some((entry) => entry.id === lateEntry)).toBe(true);
			if (navigation !== "normal sequential append") {
				expect(readonly.getBranch().some((entry) => entry.id === lateEntry)).toBe(false);
			}

			const added = await capture.capture(readonly, store);
			expect.soft(added).toHaveLength(1);
			expect.soft(recordedCost(added)).toBeCloseTo(0.40, 10);
			const afterAppend = await store.readAll();
			expect.soft(afterAppend).toHaveLength(3);
			expect.soft(recordedCost(afterAppend)).toBeCloseTo(0.70, 10);

			expect.soft(await capture.capture(readonly, store)).toHaveLength(0);
			// Visiting the appended entry later must not charge for it a second time.
			manager.branch(lateEntry);
			expect.soft(await capture.capture(readonly, store)).toHaveLength(0);
			const final = await store.readAll();
			expect.soft(final).toHaveLength(3);
			expect.soft(recordedCost(final)).toBeCloseTo(0.70, 10);
		},
	);
});
