import { mkdtemp, mkdir, readFile, readdir, copyFile, rm, writeFile } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createAssistantMessageEventStream, type AssistantMessage, type ToolResultMessage, type Usage } from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionFactory, type ExtensionUIContext, type SessionEntry,
} from "@earendil-works/pi-coding-agent";
import meter from "../extensions/meter.ts";
import {
	parseSession, recordKey, diffRecords, collapseDuplicateRecords, usageRecordsFromMessage,
} from "../src/ledger/session-parser.ts";
import { createLedgerStore, FileLedgerStore, serializeUsageRecord, parseUsageLine } from "../src/ledger/store.ts";
import type { UsageRecord } from "../src/ledger/types.ts";

/**
 * Independent oracle: docs/pi-extensions/tasks/m1-recorded-usage-ledger.md.
 * SDK 1.1 session-format.md/message-types.md and exported declarations define fixtures.
 * No product implementation or producer tests are used as an oracle.
 * [T0] = parser/identity/money; [IO] = real store/SDK/extension integration;
 * [fixture] = positive controls for the SDK harness, not M1 acceptance.
 * Run from repository root:
 * PATH=/var/tmp/pi-e0-target/bin:$PATH node scripts/run-isolated.mjs \
 *   pnpm --filter @zhcsyncer/pi-meter exec vitest run tests/pi11-ledger.contract.test.ts
 */
const TS = 1_740_000_000_000;
const PROVIDER = "ledger-fixture";
const MODEL = "deterministic";
const CWD = "/fixture/source-project";
const ISO = new Date(TS).toISOString(); // Persisted SDK format, not a user-visible time.

function usage(cost = 0.01) {
	return {
		input: 10, output: 3, cacheRead: 2, cacheWrite: 1, totalTokens: 16,
		cost: { input: cost, output: 0, cacheRead: 0, cacheWrite: 0, total: cost },
	} satisfies Usage;
}
function assistant(cost = 0.01): AssistantMessage {
	return {
		role: "assistant", content: [{ type: "text", text: "fixture" }],
		api: "openai-completions", provider: PROVIDER, model: MODEL,
		usage: usage(cost), stopReason: "stop", timestamp: TS,
	};
}
function tool(cost = 0.03, toolName = "outer", details?: ToolResultMessage["details"]): ToolResultMessage {
	return {
		role: "toolResult", toolCallId: "call-fixture", toolName,
		content: [{ type: "text", text: "fixture" }], details,
		usage: usage(cost), isError: false, timestamp: TS,
	};
}
function messageEntry(id: string, message: AssistantMessage | ToolResultMessage, parentId: string | null = null): SessionEntry {
	return { type: "message", id, parentId, timestamp: ISO, message };
}
function usageEntry(id = "usage001", cost = 0.02): SessionEntry {
	return { type: "usage", id, parentId: null, timestamp: ISO, kind: "future-unrecognized-operation", provider: PROVIDER, model: MODEL, usage: usage(cost) };
}
function summaryEntry(type: "compaction" | "branch_summary", id = "summary1", cost = 0.04): SessionEntry {
	return type === "compaction"
		? { type, id, parentId: null, timestamp: ISO, summary: "fixture", firstKeptEntryId: id, tokensBefore: 100, usage: usage(cost) }
		: { type, id, parentId: null, timestamp: ISO, summary: "fixture", fromId: "old-leaf", usage: usage(cost) };
}
function jsonl(entries: SessionEntry[], sid = "header-one", cwd = CWD): string {
	return [
		{ type: "session", version: 3, id: sid, timestamp: ISO, cwd },
		{ type: "model_change", id: "model001", parentId: null, timestamp: ISO, provider: PROVIDER, modelId: MODEL },
		...entries,
	].map((entry) => JSON.stringify(entry)).join("\n") + "\n";
}
function records(entries: SessionEntry[], sid = "header-one", alias = "filename-alias"): UsageRecord[] {
	return parseSession(jsonl(entries, sid), alias).records;
}
function knownTotal(rows: readonly UsageRecord[]): number {
	return rows.reduce((sum, row) => sum + (row.costKnown ? row.cost : 0), 0);
}
function expectMoney(rows: readonly UsageRecord[], count: number, dollars: number, soft = false): void {
	const check = soft ? expect.soft : expect;
	check(rows).toHaveLength(count);
	check(knownTotal(rows)).toBeCloseTo(dollars, 12);
}
function legacyRow(overrides: Partial<UsageRecord> = {}): UsageRecord {
	return { ts: TS, sid: "legacy-file", cwd: CWD, model: `${PROVIDER}/${MODEL}`, in: 10, out: 3, cR: 2, cW: 1, tot: 16, cost: 0.01, costKnown: true, ...overrides };
}

let root: string;
let agentDir: string;
const cleanups: Array<() => Promise<void>> = [];
beforeEach(async () => {
	root = await mkdtemp(join(tmpdir(), "pi11-ledger-contract-"));
	agentDir = join(root, "agent");
	await mkdir(agentDir, { recursive: true });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
});
afterEach(async () => {
	try {
		for (const close of cleanups.splice(0).reverse()) await close();
	} finally {
		vi.restoreAllMocks();
		vi.unstubAllEnvs();
		await rm(root, { recursive: true, force: true });
	}
});
function savedSession(name = "source", cwd = CWD, parentSession?: string, sessionDir = join(agentDir, "sessions", name)): SessionManager {
	const manager = SessionManager.create(cwd, sessionDir, { parentSession });
	manager.appendMessage({ role: "user", content: "fixture", timestamp: TS });
	manager.appendModelChange(PROVIDER, MODEL);
	return manager;
}
async function parsedFile(manager: SessionManager): Promise<UsageRecord[]> {
	const path = manager.getSessionFile()!;
	return parseSession(await readFile(path, "utf8"), basename(path, ".jsonl")).records;
}
async function ledgerRows(): Promise<UsageRecord[]> {
	return (await createLedgerStore(agentDir)).store.readAll();
}

// Only the network/model boundary is synthetic. SessionManager, extension runner,
// command dispatch, persistence and meter are real. No product module is mocked.
async function openMeter(manager = savedSession(), extra: ExtensionFactory[] = [], mode: "print" | "rpc" = "print") {
	const errors: string[] = [];
	const notices: string[] = [];
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	const runtime = await ModelRuntime.create({
		authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
		modelsStorePath: join(agentDir, "model-cache"), allowModelNetwork: false, refreshOnCreate: false,
	});
	runtime.registerProvider(PROVIDER, {
		api: "openai-completions", baseUrl: "http://127.0.0.1:1/never-requested", apiKey: "offline-fixture-not-a-credential",
		models: [{ id: MODEL, name: MODEL, reasoning: false, input: ["text"], contextWindow: 100000, maxTokens: 1024, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }],
		streamSimple: () => {
			const stream = createAssistantMessageEventStream();
			const final = assistant();
			stream.push({ type: "start", partial: { ...final, stopReason: "pending", content: [] } });
			stream.push({ type: "text_start", contentIndex: 0, partial: final });
			stream.push({ type: "text_delta", contentIndex: 0, delta: "fixture", partial: final });
			stream.push({ type: "text_end", contentIndex: 0, content: "fixture", partial: final });
			stream.push({ type: "done", reason: "stop", message: final });
			stream.end();
			return stream;
		},
	});
	const loader = new DefaultResourceLoader({
		cwd: root, agentDir, settingsManager, noExtensions: true, noSkills: true,
		noPromptTemplates: true, noThemes: true, noContextFiles: true,
		extensionFactories: [meter, ...extra],
	});
	await loader.reload();
	expect(loader.getExtensions().errors, "fixture: extension load").toEqual([]);
	const { session } = await createAgentSession({
		cwd: root, agentDir, sessionManager: manager, settingsManager,
		modelRuntime: runtime, model: runtime.getModel(PROVIDER, MODEL), thinkingLevel: "off", tools: [], resourceLoader: loader,
	});
	let closed = false;
	const close = async () => {
		if (closed) return;
		closed = true;
		try { await session.extensionRunner.emit({ type: "session_shutdown", reason: "reload" }); }
		finally { session.dispose(); }
		expect(errors, "fixture: extension errors").toEqual([]);
	};
	cleanups.push(close);
	// Retain the SDK's no-op UI. Only intercept informational output/confirmation;
	// no popup or quota command is opened, and no command registry is fabricated.
	const ui: ExtensionUIContext = {
		...session.extensionRunner.getUIContext(),
		notify: (text) => { notices.push(text); },
		confirm: async () => true,
	};
	await session.bindExtensions({ mode, uiContext: ui, onError: (e) => errors.push(e.error) });
	expect(session.extensionRunner.getCommand("usage"), "fixture: /usage registered").toBeDefined();
	return {
		session, manager, notices, close,
		settle: () => session.extensionRunner.emit({ type: "agent_settled", aborted: false }),
		import: async () => { await session.prompt("/usage import"); expect(errors, "fixture: import errors").toEqual([]); },
	};
}

const billableFixtures = [
	["assistant", () => messageEntry("expense1", assistant())],
	["outer tool", () => messageEntry("expense1", tool(0.01))],
	["unknown usage", () => usageEntry("expense1", 0.01)],
	["compaction", () => summaryEntry("compaction", "expense1", 0.01)],
	["branch summary", () => summaryEntry("branch_summary", "expense1", 0.01)],
] as const;

describe("[T0] persisted usage and money", () => {
	it("positive control: assistant plus outer tool keeps tokens and costs", () => {
		const rows = records([messageEntry("assistant1", assistant()), messageEntry("outer001", tool())]);
		expectMoney(rows, 2, 0.04);
		expect(rows.map((r) => [r.in, r.out, r.cR, r.cW, r.tot])).toEqual([[10, 3, 2, 1, 16], [10, 3, 2, 1, 16]]);
	});
	it("SDK persisted assistant .01 + outer .03 + unknown usage .02 is .06, not nested expense again", async () => {
		const manager = savedSession();
		manager.appendMessage(assistant());
		manager.appendMessage({ ...tool(), nestedCalls: { complete: true, calls: [{ id: "call-fixture/1", name: "nested", status: "ok", durationMs: 1 }] } });
		manager.appendUsage("future-unrecognized-operation", PROVIDER, MODEL, usage(0.02));
		expectMoney(await parsedFile(manager), 3, 0.06);
	});
	it("positive control: compaction and branch summary are real additional expenses", () => {
		const rows = records([summaryEntry("compaction", "compact1", 0.03), summaryEntry("branch_summary", "branch01", 0.04)]);
		expectMoney(rows, 2, 0.07);
		expect(rows.map((r) => r.kind).sort()).toEqual(["branch_summary", "compaction"]);
	});
	it.each(billableFixtures)("%s: reported zero is known zero", (_name, make) => {
		const entry = make();
		const target = entry.type === "message" ? entry.message : entry;
		Object.assign(target, { usage: usage(0) });
		const rows = records([entry]);
		expect(rows).toHaveLength(1);
		expect(rows[0]).toMatchObject({ cost: 0, costKnown: true, tot: 16 });
	});
	const invalidCosts = [
		["missing", undefined], ["null", null], ["negative", -0.01], ["non-numeric", "not-a-price"],
	] as const;
	for (const [name, make] of billableFixtures) {
		it.each(invalidCosts)(`${name}: %s cost is unknown, without erasing the known subtotal`, (_reason, total) => {
			const entry = make();
			const target = entry.type === "message" ? entry.message : entry;
			Object.assign(target, { usage: { ...usage(), cost: total === undefined ? undefined : { total } } });
			const rows = records([messageEntry("known001", assistant(0.07)), entry]);
			expectMoney(rows, 2, 0.07);
			expect(rows.filter((r) => !r.costKnown)).toHaveLength(1);
			expect(rows.every((r) => Number.isFinite(r.cost))).toBe(true);
		});
	}
	it.each([NaN, Infinity, -Infinity])("message parser does not mark non-finite cost %s as known", (total) => {
		const msg = assistant();
		msg.usage.cost.total = total;
		const rows = usageRecordsFromMessage(msg, { sid: "session", cwd: CWD });
		expect(rows).toHaveLength(1);
		expect(rows[0].costKnown).toBe(false);
	});
});

describe("[T0] stable identity, not payload equality", () => {
	it.each(billableFixtures)("%s: equal payloads with distinct entry IDs both survive collapse/diff", (_name, make) => {
		const a = make();
		const b = { ...make(), id: "expense2" };
		const rows = records([a, b]);
		expectMoney(collapseDuplicateRecords(rows), 2, 0.02);
		expect(new Set(rows.map(recordKey)).size).toBe(2);
		expect(diffRecords([rows[0]], rows)).toEqual([rows[1]]);
		expect(diffRecords(rows, rows)).toEqual([]);
	});
	it("unrelated session headers with the same entry ID remain distinct", () => {
		const entry = messageEntry("same-id", assistant());
		const a = records([entry], "session-a", "same-filename");
		const b = records([entry], "session-b", "same-filename");
		expectMoney(collapseDuplicateRecords([...a, ...b]), 2, 0.02);
	});
	it("same header and entry under different filenames is one identity", () => {
		const entry = messageEntry("same-id", assistant());
		const a = records([entry], "one-header", "filename-a");
		const b = records([entry], "one-header", "filename-b");
		expect(diffRecords(a, b)).toEqual([]);
		expectMoney(collapseDuplicateRecords([...a, ...b]), 1, 0.01);
	});
	it("Consult fanout/retries use raw indices, exclude outer rollup and keep equal advisor expenses", () => {
		const raw = (model: string, paid: boolean) => ({ model, text: "fixture", durationMs: 1, attempts: 2, ...(paid ? { usage: usage(0.02) } : {}) });
		const details = (firstPaid: boolean) => ({ trigger: "onDemand", models: ["advisor/a", "advisor/b"], envelope: { verdict: "confirm", summary: "fixture", raw: [raw("advisor/a", firstPaid), raw("advisor/b", true), raw("advisor/b", true)] } });
		const partial = records([messageEntry("consult1", tool(0.04, "consult", details(false)))]);
		const complete = records([messageEntry("consult1", tool(0.06, "consult", details(true)))]);
		expectMoney(collapseDuplicateRecords(partial), 2, 0.04);
		expectMoney(complete, 3, 0.06);
		// Same raw slots 1 and 2, even when slot 0 has no usage. This compares
		// parser projections, not an instruction to rewrite persisted messages.
		expect(partial.map(recordKey)).toEqual(complete.slice(1).map(recordKey));
		expect(new Set(partial.map(recordKey)).size).toBe(2);
		expect(partial.map((r) => r.model)).toEqual(["advisor/b", "advisor/b"]);
	});
});

describe("[IO] normal FileLedgerStore and non-destructive compatibility", () => {
	it("two normal store instances append one identity only once", async () => {
		const a = (await createLedgerStore(agentDir)).store;
		const b = (await createLedgerStore(agentDir)).store;
		expect(a).toBeInstanceOf(FileLedgerStore);
		expect(b).toBeInstanceOf(FileLedgerStore);
		const [row] = records([messageEntry("entry-one", assistant())]);
		const added = await Promise.all([a.append(row), b.append({ ...row })]);
		expect(added.filter(Boolean)).toHaveLength(1);
		expectMoney(await ledgerRows(), 1, 0.01);
	});
	it("new identities are not consumed by legacy payload matching", async () => {
		const store = (await createLedgerStore(agentDir)).store;
		const [a, b] = records([messageEntry("entry-one", assistant()), messageEntry("entry-two", assistant())]);
		await store.append(a);
		expect(await store.append(b)).toBe(true);
		expectMoney(await ledgerRows(), 2, 0.02);
	});
	it("positive control: old known/unknown rows round-trip without changing values or budgets", async () => {
		const store = (await createLedgerStore(agentDir)).store;
		const rows = [legacyRow({ cost: 0.07 }), legacyRow({ ts: TS + 60_000, sid: "legacy-unknown-source", model: "fixture/unknown", cost: 0, costKnown: false })];
		for (const row of rows) {
			expect(parseUsageLine(JSON.stringify(serializeUsageRecord(row)))).toEqual(row);
			await store.append(row);
		}
		const budgets = { limits: [{ scope: "global" as const, period: "month" as const, metric: "cost" as const, max: 2 }] };
		await store.saveBudgets(budgets);
		const reopened = (await createLedgerStore(agentDir)).store;
		expect(await reopened.readAll()).toEqual(rows);
		expect(await reopened.loadBudgets()).toEqual(budgets);
	});
});

describe("[IO] real extension import / lifecycle", () => {
	it("[fixture] real command dispatch imports an assistant-only session without network", async () => {
		const source = savedSession();
		source.appendMessage(assistant(0.07));
		const app = await openMeter(savedSession("observer"));
		await app.import();
		expectMoney(await ledgerRows(), 1, 0.07);
		expect(app.notices.length).toBeGreaterThan(0);
	});
	it("[fixture] SDK message_end replacement is persisted before turn_end", async () => {
		const observed: number[] = [];
		const app = await openMeter(savedSession(), [(pi) => {
			pi.on("message_end", (event) => event.message.role === "assistant" ? { message: { ...event.message, usage: usage(0.04) } } : undefined);
			pi.on("turn_end", (event, ctx) => {
				const entry = ctx.sessionManager.getEntry(event.messageEntryId);
				if (entry?.type === "message" && entry.message.role === "assistant") observed.push(entry.message.usage.cost.total);
			});
		}]);
		await app.session.prompt("deterministic fixture; no remote model");
		expect(observed).toEqual([0.04]);
		const persisted = SessionManager.open(app.manager.getSessionFile()!).getEntries();
		expect(persisted.filter((e) => e.type === "message" && e.message.role === "assistant").map((e) => e.type === "message" && e.message.role === "assistant" ? e.message.usage.cost.total : undefined)).toEqual([0.04]);
	});
	it.each(["print", "rpc"] as const)("%s live capture uses finalized .04, never early message_end .01", async (mode) => {
		const app = await openMeter(savedSession(), [(pi) => {
			pi.on("message_end", (event) => event.message.role === "assistant" ? { message: { ...event.message, usage: usage(0.04) } } : undefined);
		}], mode);
		await app.session.prompt("deterministic fixture; no remote model");
		expectMoney(await ledgerRows(), 1, 0.04, true);
		await app.import();
		expectMoney(await ledgerRows(), 1, 0.04);
	});
	it.each(["live-first", "import-first"] as const)("%s: repeated capture/import/reload retains .06 and a new equal-payload usage tail", async (order) => {
		const source = savedSession();
		const app = await openMeter(source);
		source.appendMessage(assistant());
		source.appendMessage(tool());
		source.appendUsage("future-unrecognized-operation", PROVIDER, MODEL, usage(0.02));
		if (order === "import-first") await app.import();
		await app.settle();
		await app.import();
		await app.settle();
		expectMoney(await ledgerRows(), 3, 0.06, true);
		await app.close();
		const reloaded = await openMeter(SessionManager.open(source.getSessionFile()!));
		reloaded.manager.appendUsage("future-unrecognized-operation", PROVIDER, MODEL, usage(0.02));
		await reloaded.settle();
		await reloaded.import();
		await reloaded.settle();
		expectMoney(await ledgerRows(), 4, 0.08);
	});
	it("turn_end captures newly persisted usage before final agent settlement", async () => {
		let beforeSettle: UsageRecord[] | undefined;
		const source = savedSession();
		const app = await openMeter(source, [(pi) => {
			pi.on("message_end", (event) => {
				if (event.message.role === "assistant") source.appendUsage("future-operation", PROVIDER, MODEL, usage(0.02));
			});
			pi.on("agent_before_settle", async () => { beforeSettle = await ledgerRows(); });
		}]);
		await app.session.prompt("deterministic fixture; no remote model");
		expect(beforeSettle, "fixture: SDK reached pre-settle boundary").toBeDefined();
		expectMoney(beforeSettle!, 2, 0.03);
	});
	it("nested execution notification is not another ledger expense", async () => {
		const source = savedSession();
		const app = await openMeter(source);
		await app.session.extensionRunner.emit({ type: "tool_execution_end", toolCallId: "outer/1", parentToolCallId: "outer", toolName: "nested", result: { content: [], details: {}, usage: usage(0.02) }, isError: false });
		source.appendMessage(tool(0.03));
		await app.settle();
		await app.import();
		expectMoney(await ledgerRows(), 1, 0.03);
	});
	it("summary lifecycle boundaries and later import do not bill summaries twice", async () => {
		const source = savedSession();
		const app = await openMeter(source);
		const compactId = source.appendCompaction("fixture", source.getLeafId(), 100, undefined, true, usage(0.03));
		const compact = source.getEntry(compactId);
		if (compact?.type !== "compaction") throw new Error("fixture: SDK compaction entry missing");
		await app.session.extensionRunner.emit({ type: "session_compact", compactionEntry: compact, fromExtension: true, reason: "manual", willRetry: false });
		const oldLeafId = source.getLeafId();
		const summaryId = source.branchWithSummary(oldLeafId, "fixture", undefined, true, usage(0.04));
		const summary = source.getEntry(summaryId);
		if (summary?.type !== "branch_summary") throw new Error("fixture: SDK branch summary missing");
		await app.session.extensionRunner.emit({ type: "session_tree", newLeafId: summaryId, oldLeafId, summaryEntry: summary, fromExtension: true });
		await app.import();
		expectMoney(await ledgerRows(), 2, 0.07);
	});
	it("unchanged idle lifecycle does not repeatedly request the full entry history; a new tail is captured", async () => {
		const source = savedSession();
		for (let n = 0; n < 100; n++) source.appendMessage({ ...assistant(), timestamp: TS + n });
		const app = await openMeter(source);
		await app.settle();
		// Performance contract at the public SDK boundary, not a private cache assertion.
		const fullEntries = vi.spyOn(source, "getEntries");
		const fullBranch = vi.spyOn(source, "getBranch");
		for (let n = 0; n < 8; n++) await app.settle();
		expect(fullEntries).not.toHaveBeenCalled();
		expect(fullBranch).not.toHaveBeenCalled();
		fullEntries.mockRestore();
		fullBranch.mockRestore();
		source.appendUsage("new-tail", PROVIDER, MODEL, usage(0.02));
		await app.settle();
		expectMoney(await ledgerRows(), 101, 1.02);
	});
});

// These cases exercise file IO through /usage import, not hidden IO in parseSession.
describe("[IO] aliases, SDK fork/clone, parent receipts", () => {
	it("same header through two filenames and repeated import remains one expense", async () => {
		const source = savedSession();
		source.appendMessage(assistant());
		const app = await openMeter(savedSession("observer"));
		await app.import();
		await copyFile(source.getSessionFile()!, join(dirname(source.getSessionFile()!), "renamed-alias.jsonl"));
		await app.import();
		await app.import();
		expectMoney(await ledgerRows(), 1, 0.01);
	});
	it.each(["source-first", "fork-first"] as const)("%s SDK cross-project fork keeps copied expense at source project, new tail at target", async (order) => {
		// In fork-first order the parent is readable but outside history discovery.
		const source = savedSession("source", CWD, undefined, order === "fork-first" ? join(root, "outside-discovery") : join(agentDir, "sessions", "source"));
		source.appendMessage(assistant(0.03));
		const app = await openMeter(savedSession("observer"));
		if (order === "source-first") await app.import();
		const targetCwd = "/fixture/target-project";
		const fork = SessionManager.forkFrom(source.getSessionFile()!, targetCwd, join(agentDir, "sessions", "fork"));
		fork.appendMessage({ ...assistant(0.02), timestamp: TS + 1 });
		expect(fork.getHeader()?.parentSession, "fixture: actual SDK parent").toBe(source.getSessionFile());
		await app.import();
		if (order === "fork-first") {
			const discovered = join(agentDir, "sessions", "later-source");
			await mkdir(discovered, { recursive: true });
			await copyFile(source.getSessionFile()!, join(discovered, basename(source.getSessionFile()!)));
		}
		await app.import();
		const rows = await ledgerRows();
		expectMoney(rows, 2, 0.05);
		expectMoney(rows.filter((r) => r.cwd === CWD), 1, 0.03);
		expectMoney(rows.filter((r) => r.cwd === targetCwd), 1, 0.02);
	});
	it("SDK selected-branch clone with a label does not count copied entries again", async () => {
		const source = savedSession();
		const a = source.appendMessage(assistant(0.03));
		source.appendLabelChange(a, "kept-branch");
		const leaf = source.appendMessage({ ...assistant(0.02), timestamp: TS + 1 });
		source.branch(a);
		source.appendMessage({ ...assistant(0.04), timestamp: TS + 2 });
		const clonePath = source.createBranchedSession(leaf);
		expect(clonePath, "fixture: persisted SDK branch clone").toBeDefined();
		const clone = SessionManager.open(clonePath!);
		clone.appendMessage({ ...assistant(0.01), timestamp: TS + 3 });
		const app = await openMeter(savedSession("observer"));
		await app.import();
		expectMoney(await ledgerRows(), 4, 0.10);
	});
	it("a fresh child with parentSession is not inherited history, even at the same time and price", async () => {
		const parent = savedSession("parent");
		parent.appendMessage(assistant(0.03));
		const child = savedSession("child", CWD, parent.getSessionFile());
		child.appendMessage(assistant(0.03));
		const app = await openMeter(savedSession("observer"));
		await app.import();
		expectMoney(await ledgerRows(), 2, 0.06);
	});
	it("unlinked files remain distinct despite identical message and entry IDs", async () => {
		const dir = join(agentDir, "sessions", "unlinked");
		await mkdir(dir, { recursive: true });
		const entry = messageEntry("same-entry", assistant());
		await writeFile(join(dir, "a.jsonl"), jsonl([entry], "unrelated-a"));
		await writeFile(join(dir, "b.jsonl"), jsonl([entry], "unrelated-b"));
		const app = await openMeter(savedSession("observer"));
		await app.import();
		expectMoney(await ledgerRows(), 2, 0.02);
	});
	it.each([0.08, 0.02, 0] as const)("parent branch receipts are nonadditive; available child subtotal %s is not filled with provisional money", async (childCost) => {
		const parent = savedSession("parent");
		const branchPoint = parent.getLeafId()!;
		const cumulative = { input: 10, output: 3, cacheRead: 2, cacheWrite: 1, cost: 0.06 };
		const receipt = () => tool(0.06, "get_subagent_result", { subagentUsageRollup: { version: 1, agentId: "child-fixture", cumulative } });
		parent.appendMessage(receipt());
		parent.branch(branchPoint);
		parent.appendMessage(receipt());
		if (childCost > 0) {
			const child = savedSession("child", CWD, parent.getSessionFile());
			child.appendMessage(assistant(childCost));
		}
		const app = await openMeter(savedSession("observer"));
		await app.import();
		expectMoney(await ledgerRows(), childCost > 0 ? 1 : 0, childCost);
	});
	it("legacy Agent parent result stays nonadditive alongside the child canonical records", async () => {
		const parent = savedSession("parent");
		parent.appendMessage(tool(0.06, "Agent", { agentId: "child-fixture" }));
		const child = savedSession("child", CWD, parent.getSessionFile());
		child.appendMessage(assistant(0.06));
		const app = await openMeter(savedSession("observer"));
		await app.import();
		expectMoney(await ledgerRows(), 1, 0.06);
	});
});

async function filesUnder(dir: string): Promise<Map<string, string>> {
	const result = new Map<string, string>();
	for (const entry of await readdir(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) for (const [name, text] of await filesUnder(path)) result.set(name, text);
		else result.set(path, await readFile(path, "utf8"));
	}
	return result;
}

describe("[IO] legacy compatibility is bounded, not a historical reconstruction", () => {
	it("old duplicate rows stay on disk while the old read-side budget subtotal stays deduplicated", async () => {
		const old = legacyRow();
		await (await createLedgerStore(agentDir)).store.append(old);
		const serialized = JSON.stringify(serializeUsageRecord(old));
		const matches = [...await filesUnder(agentDir)].filter(([, text]) => text.split("\n").includes(serialized));
		expect(matches, "fixture: one normal ledger file").toHaveLength(1);
		const [path, original] = matches[0];
		const historical = original + serialized + "\n";
		await writeFile(path, historical);
		const app = await openMeter(savedSession("observer"));
		await app.import();
		expectMoney(collapseDuplicateRecords(await ledgerRows()), 1, 0.01);
		expect(await readFile(path, "utf8")).toBe(historical);
	});
	it("one old no-ID row covers one complete-source entry, never successive equal-payload tails", async () => {
		const source = savedSession();
		source.appendMessage(assistant());
		const [old] = await parsedFile(source);
		const store = (await createLedgerStore(agentDir)).store;
		// Deliberate old format: sid is the file alias; it has no new entry identity.
		const legacy = legacyRow({ ts: old.ts, cwd: old.cwd, model: old.model, sid: basename(source.getSessionFile()!, ".jsonl") });
		await store.append(legacy);
		const before = await filesUnder(agentDir);
		source.appendMessage(assistant());
		const app = await openMeter(source);
		await app.import();
		expectMoney(await ledgerRows(), 2, 0.02, true);
		source.appendMessage(assistant());
		await app.settle();
		await app.import();
		await app.settle();
		expectMoney(await ledgerRows(), 3, 0.03, true);
		// Non-destructive means existing ledger bytes remain an unchanged prefix;
		// no private storage filename is assumed and session log changes are excluded.
		const serialized = JSON.stringify(serializeUsageRecord(legacy));
		const oldLedgerFiles = [...before].filter(([, text]) => text.split("\n").includes(serialized));
		expect(oldLedgerFiles.length, "fixture: locate persisted legacy line").toBeGreaterThan(0);
		for (const [path, text] of oldLedgerFiles) expect((await readFile(path, "utf8")).startsWith(text)).toBe(true);
	});
	it("exact new identity matches first; one legacy row cannot also absorb a third new entry", async () => {
		const source = savedSession();
		source.appendMessage(assistant());
		const [newRow] = await parsedFile(source);
		const store = (await createLedgerStore(agentDir)).store;
		await store.append(newRow);
		await store.append(legacyRow({ ts: newRow.ts, cwd: newRow.cwd, model: newRow.model, sid: basename(source.getSessionFile()!, ".jsonl") }));
		source.appendMessage(assistant());
		source.appendMessage(assistant());
		const app = await openMeter(source);
		await app.import();
		await app.import();
		expectMoney(await ledgerRows(), 3, 0.03);
	});
	it("old uncorrespondable cost remains; import does not rewrite it to a guessed final value", async () => {
		const source = savedSession();
		source.appendMessage(assistant(0.04));
		const store = (await createLedgerStore(agentDir)).store;
		const old = legacyRow({ sid: "missing-historical-source", cost: 0.01 });
		await store.append(old);
		const app = await openMeter(savedSession("observer"));
		await app.import();
		const rows = await ledgerRows();
		expect(rows).toContainEqual(old);
		expectMoney(rows, 2, 0.05);
	});
});

// UI follow-up: the original 66 cases above remain unchanged. Only the terminal
// transport is synthetic; InteractiveMode owns custom(), focus and input routing.
async function openRecordedUsageDashboard(includeUnknown: boolean) {
	// Load generic transport at runtime: its sibling package uses a different TS
	// configuration. Only the public Terminal contract and transport capture are used.
	const transportURL = new URL("../../pi-tool-display-intent/tests/helpers/aggregate-terminal.ts", import.meta.url).href;
	const { AggregateTerminal } = await import(transportURL) as {
		AggregateTerminal: new () => import("@earendil-works/pi-tui").Terminal & {
			columns: number; rows: number; writes: string[]; onInput?: (input: string) => void;
		};
	};
	const { InteractiveMode, createAgentSessionRuntime, createAgentSessionServices, createAgentSessionFromServices } = await import("@earendil-works/pi-coding-agent");
	const { stripTerminalSequences } = await import("@earendil-works/pi-tui");
	const terminal = new AggregateTerminal();
	terminal.columns = 120;
	terminal.rows = 45;
	const source = savedSession("ui-expenses", root);
	const now = Date.now(); // The default footer's rolling window must include these expenses.
	source.appendMessage({ ...assistant(0.07), provider: "fixture-provider", model: "priced", timestamp: now });
	if (includeUnknown) {
		const unpriced = { ...assistant(), provider: "fixture-provider", model: "unpriced", timestamp: now + 1 };
		Reflect.deleteProperty(unpriced.usage, "cost");
		source.appendMessage(unpriced);
	}
	// Import before opening the UI, so this tests presentation of recorded data,
	// not a timer-dependent footer refresh after a separate history operation.
	const importer = await openMeter(savedSession("ui-importer", root));
	await importer.import();
	await importer.close();
	const imported = await ledgerRows();
	expectMoney(imported, includeUnknown ? 2 : 1, 0.07);
	expect(imported.filter((row) => !row.costKnown)).toHaveLength(includeUnknown ? 1 : 0);
	const host = await createAgentSessionRuntime(async ({ cwd, agentDir, sessionManager }) => {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"), modelsPath: join(agentDir, "models.json"),
			modelsStorePath: join(agentDir, "model-cache"), allowModelNetwork: false, refreshOnCreate: false,
		});
		const services = await createAgentSessionServices({
			cwd, agentDir, modelRuntime,
			settingsManager: SettingsManager.inMemory({ quietStartup: true, compaction: { enabled: false }, retry: { enabled: false } }),
			resourceLoaderOptions: { noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true, extensionFactories: [meter] },
		});
		return { ...await createAgentSessionFromServices({ services, sessionManager, tools: [] }), services, diagnostics: services.diagnostics };
	}, { cwd: root, agentDir, sessionManager: savedSession("ui-observer", root) });
	const mode = new InteractiveMode(host, { terminal, tuiMode: "regular" });
	let command: Promise<unknown> | undefined;
	const errors: string[] = [];
	cleanups.push(async () => {
		try {
			terminal.onInput?.("\x1b");
			await command;
			await host.dispose();
		} finally { mode.stop(); }
		expect(errors, "fixture: native UI extension errors").toEqual([]);
	});
	const runner = host.session.extensionRunner;
	runner.onError((event) => errors.push(event.error));
	const statuses = new Map<string, string>();
	const surfaces: Array<{ component: import("@earendil-works/pi-tui").Component; tui: import("@earendil-works/pi-tui").TUI }> = [];
	const bindUI = runner.setUIContext.bind(runner);
	// Intercept the genuine binding before session_start can retain its context.
	const binding = vi.spyOn(runner, "setUIContext").mockImplementation((nativeUI, mode) => {
		if (!nativeUI) return bindUI(nativeUI, mode);
		bindUI({
			...nativeUI,
			setStatus: (key, text) => {
				if (text === undefined) statuses.delete(key); else statuses.set(key, text);
				nativeUI.setStatus(key, text);
			},
			custom: (factory, options) => nativeUI.custom(async (...args) => {
				const component = await factory(...args);
				surfaces.push({ component, tui: args[0] });
				return component;
			}, options),
		}, mode);
	});
	try { await mode.init(); } finally { binding.mockRestore(); }
	command = host.session.prompt("/usage");
	await vi.waitFor(() => expect(stripTerminalSequences(terminal.writes.join("")), "fixture: real /usage menu").toMatch(/dashboard/i));
	const menuSurfaces = surfaces.length;
	terminal.onInput?.("\r"); // Default selection, through the real terminal input handler.
	await vi.waitFor(() => expect(surfaces.length, "fixture: Dashboard mounted after Enter").toBeGreaterThan(menuSurfaces));
	const dashboard = surfaces.at(-1)!;

	return {
		dashboard,
		manager: host.session.sessionManager,
		footer: () => stripTerminalSequences([...statuses.values()].join("\n")),
		visible: () => stripTerminalSequences(dashboard.component.render(terminal.columns).join("\n")),
	};
}

describe("[IO UI follow-up] recorded scope and render work", () => {
	it.each([false, true])("footer and real Dashboard express recorded .07, unknown cost present=%s", async (includeUnknown) => {
		const view = await openRecordedUsageDashboard(includeUnknown);
		for (const [surface, text] of [["footer", view.footer()], ["dashboard", view.visible()]] as const) {
			expect.soft(text, `${surface}: keep the known subtotal`).toMatch(/\$\s*0\.070*\b/);
			expect.soft(text, `${surface}: recorded scope, not a real-bill total`).toMatch(/recorded|logged|ledger|已记录|本地记录|账本/i);
			if (includeUnknown) {
				// Accept prose or compact money qualifiers, but not the unrelated
				// "unknown" model/quota hint or an n/a on just one model row.
				expect.soft(text, `${surface}: known subtotal is not a complete total`).toMatch(/unknown\s+(?:cost|price|fee)|(?:cost|price|fee).{0,15}unknown|incomplete|partial|lower[ -]bound|at least|未知费用|费用未知|不完整|下界|至少|≥|>=|[~?]\s*\$\s*0\.070*|\$\s*0\.070*[\s():-]*(?:unknown|[+?])|\+\s*\?/i);
			}
		}
	});
	it("opened real Dashboard repeats public renders and TUI frames without full session scans", async () => {
		const view = await openRecordedUsageDashboard(true);
		const fullEntries = vi.spyOn(view.manager, "getEntries");
		const fullBranch = vi.spyOn(view.manager, "getBranch");
		try {
			for (let frame = 0; frame < 8; frame++) {
				view.dashboard.component.render(frame % 2 ? 100 : 120);
				view.dashboard.tui.renderNow();
			}
			expect(fullEntries).not.toHaveBeenCalled();
			expect(fullBranch).not.toHaveBeenCalled();
		} finally {
			fullEntries.mockRestore();
			fullBranch.mockRestore();
		}
	});
});
