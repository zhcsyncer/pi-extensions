import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync, copyFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { InMemoryCredentialStore, InMemoryModelsStore, Type, fauxAssistantMessage, fauxProvider, type Usage } from "@earendil-works/pi-ai";
import { DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, createAgentSession, defineTool } from "@earendil-works/pi-coding-agent";
import { SessionUsageCapture } from "../src/ledger/capture.ts";
import { createLedgerStore, serializeUsageRecord } from "../src/ledger/store.ts";
import { parseSession } from "../src/ledger/session-parser.ts";
import { readSessionSource } from "../src/ledger/session-source.ts";
import { getMeterPaths } from "../src/paths.ts";
import { statusForLimit } from "../src/ledger/budget.ts";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose(); });
function workspace() {
	const root = mkdtempSync(join(tmpdir(), "meter-sdk-"));
	const old = process.env.PI_CODING_AGENT_DIR;
	process.env.PI_CODING_AGENT_DIR = root;
	cleanup.push(() => { if (old === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = old; rmSync(root, { recursive: true, force: true }); });
	return root;
}
function usage(total: number): Usage {
	return { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2, cost: { input: total, output: 0, cacheRead: 0, cacheWrite: 0, total } };
}
function message(total: number) {
	const result = fauxAssistantMessage("answer"); result.usage = usage(total); return result;
}

async function sdkFixture() {
	const root = workspace();
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null, allowModelNetwork: false, refreshOnCreate: false });
	const faux = fauxProvider({ provider: "meter-offline", models: [{ id: "fixture", contextWindow: 128000, maxTokens: 4096 }] });
	runtime.registerNativeProvider(faux.provider);
	await runtime.setRuntimeApiKey("meter-offline", "synthetic-only");
	await runtime.refresh({ allowNetwork: false });
	const manager = SessionManager.create(root, join(root, "sessions"), { id: "real-session" });
	const settings = SettingsManager.inMemory({ packages: [], retry: { enabled: false }, compaction: { enabled: false, keepRecentTokens: 0 }, cacheWarming: "off" });
	let summaryCost = 0.01;
	const loader = new DefaultResourceLoader({ cwd: root, agentDir: root, settingsManager: settings,
		additionalExtensionPaths: [fileURLToPath(new URL("../extensions/meter.ts", import.meta.url))], noExtensions: true,
		noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true, systemPrompt: "Offline accounting fixture.",
		extensionFactories: [pi => {
			pi.registerTool(defineTool({ name: "inner", label: "Inner", description: "offline nested work", parameters: Type.Object({}), async execute() {
				return { content: [{ type: "text", text: "inner" }], details: {}, usage: usage(0.02) };
			} }));
			pi.registerTool(defineTool({ name: "outer", label: "Outer", description: "offline outer work", parameters: Type.Object({}), async execute(_id, _args, _signal, _update, ctx) {
				await ctx.executeTool("inner", {});
				manager.appendUsage("future-kind", "meter-offline", "fixture", usage(0.02));
				return { content: [{ type: "text", text: "outer" }], details: {}, usage: usage(0.01) };
			} }));
			// Loaded after Meter: the persisted replacement, not Meter's earlier event value, owns the charge.
			pi.on("message_end", event => event.message.role === "assistant" ? { message: { ...event.message, usage: usage(event.message.stopReason === "toolUse" ? 0.01 : 0) } } : undefined);
			pi.on("session_before_compact", event => ({ compaction: { summary: "same summary", firstKeptEntryId: event.preparation.firstKeptEntryId, tokensBefore: event.preparation.tokensBefore, usage: usage(summaryCost) } }));
		}],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({ cwd: root, agentDir: root, resourceLoader: loader, settingsManager: settings, modelRuntime: runtime, model: faux.getModel(), sessionManager: manager, noTools: "builtin" });
	cleanup.push(async () => { await session.abort(); session.dispose(); });
	const errors: unknown[] = [];
	await session.bindExtensions({ mode: "print", onError: error => { errors.push(error); } });
	const { store } = await createLedgerStore(root);
	return { root, session, manager, store, faux, errors, setSummaryCost: (cost: number) => { summaryCost = cost; } };
}

describe("Meter SDK integration", () => {
	it("records final outer/assistant/unknown usage once across real import and reload", async () => {
		const f = await sdkFixture();
		f.faux.setResponses([fauxAssistantMessage([{ type: "toolCall", id: "outer-1", name: "outer", arguments: {} }], { stopReason: "toolUse" }), fauxAssistantMessage("done")]);
		await f.session.prompt("Run outer.");
		let records = await f.store.readAll();
		expect(records.reduce((sum, record) => sum + record.cost, 0)).toBeCloseTo(0.06, 12);
		expect(records.every(record => record.sid === "real-session" && record.entryId)).toBe(true);
		expect(records.filter(record => record.usageKind === "future-kind")).toHaveLength(1);
		const ledger = readFileSync(getMeterPaths(f.root).usageFile, "utf8");
		copyFileSync(f.manager.getSessionFile()!, join(f.root, "sessions", "renamed-copy.jsonl"));
		await f.session.prompt("/usage import");
		await f.session.reload();
		await f.session.prompt("/usage import");
		expect(readFileSync(getMeterPaths(f.root).usageFile, "utf8")).toBe(ledger);
		// Idle append has no message_end. A public command must observe it without a model request.
		f.manager.appendUsage("another-future-kind", "meter-offline", "fixture", usage(0.04));
		await f.session.prompt("/usage all");
		records = await f.store.readAll();
		expect(records.reduce((sum, record) => sum + record.cost, 0)).toBeCloseTo(0.10, 12);
		expect(f.errors).toEqual([]);
	});

	it("captures both same-text SDK compactions despite its stale event entry", async () => {
		const f = await sdkFixture();
		f.faux.setResponses([fauxAssistantMessage("one"), fauxAssistantMessage("two")]);
		await f.session.prompt("first"); await f.session.compact();
		f.setSummaryCost(0.02);
		await f.session.prompt("second"); await f.session.compact();
		const summaries = (await f.store.readAll()).filter(record => record.kind === "compaction");
		expect(summaries.map(record => record.cost)).toEqual([0.01, 0.02]);
		expect(new Set(summaries.map(record => record.entryId)).size).toBe(2);
		expect(f.errors).toEqual([]);
	});

	it("keeps concurrent store appends idempotent and preserves legacy bytes and budget totals", async () => {
		const root = workspace();
		const manager = SessionManager.inMemory(root, { id: "s" });
		manager.appendMessage(message(0.01));
		const [record] = parseSession([manager.getHeader(), ...manager.getEntries()].map(entry => JSON.stringify(entry)).join("\n"), "alias").records;
		const a = (await createLedgerStore(root)).store, b = (await createLedgerStore(root)).store;
		expect((await Promise.all([a.append(record), b.append(record)])).filter(Boolean)).toHaveLength(1);
		expect(await a.readAll()).toHaveLength(1);
		const legacyRoot = join(root, "legacy-agent"), paths = getMeterPaths(legacyRoot);
		mkdirSync(paths.dataDir, { recursive: true });
		const { entryId: _id, ...old } = record;
		const bytes = [old, { ...old, ts: old.ts + 10 }].map(r => JSON.stringify(serializeUsageRecord(r))).join("\n") + "\n";
		writeFileSync(paths.usageFile, bytes);
		const legacy = (await createLedgerStore(legacyRoot)).store;
		expect((await legacy.readAll()).reduce((sum, r) => sum + r.cost, 0)).toBe(0.01);
		expect(readFileSync(paths.usageFile, "utf8")).toBe(bytes);
	});

	it("attributes normal copied entries to the source project, not an ordinary linked child's parent", async () => {
		const root = workspace();
		const source = SessionManager.create("/source-project", join(root, "sources"), { id: "source" });
		const first = source.appendMessage(message(0.01));
		source.appendLabelChange(first, "checkpoint"); source.appendMessage(message(0.02));
		const copied = SessionManager.forkFrom(source.getSessionFile()!, "/new-project", join(root, "copies"));
		copied.createBranchedSession(copied.getLeafId()!); // Normal label removal + parent reconnection, two levels of origin.
		copied.appendMessage(message(0.03));
		const ordinary = SessionManager.create("/child-project", join(root, "children"), { parentSession: source.getSessionFile() });
		ordinary.appendMessage(message(0.04));
		const { store } = await createLedgerStore(root);
		for (const manager of [copied, ordinary, source]) await new SessionUsageCapture().capture(manager, store);
		const records = await store.readAll();
		expect(records.reduce((sum, r) => sum + r.cost, 0)).toBeCloseTo(0.10, 12);
		expect(records.filter(r => r.sid === "source").map(r => r.cwd)).toEqual(["/source-project", "/source-project"]);
		expect(records.find(r => r.cost === 0.03)?.cwd).toBe("/new-project");
		expect(records.find(r => r.cost === 0.04)?.sid).toBe(ordinary.getSessionId());
		const resolved = (await readSessionSource(copied.getSessionFile()!, new Map()))!;
		const imported = parseSession(resolved.content, "arbitrary-name", { origins: resolved.origins });
		await store.appendRecords(imported.records);
		expect(await store.readAll()).toHaveLength(4);
	});

	it("does not rescan unchanged entries or spend a legacy allowance again on a new tail", async () => {
		const root = workspace();
		const manager = SessionManager.create(root, join(root, "sessions"), { id: "s" });
		const assistant = message(0.01); manager.appendMessage(assistant);
		const [record] = parseSession(readFileSync(manager.getSessionFile()!, "utf8"), "filename").records;
		const { entryId: _id, sourceId: _source, ...legacy } = record;
		legacy.sid = manager.getSessionFile()!.split("/").at(-1)!.replace(/\.jsonl$/, "");
		const { store } = await createLedgerStore(root); await store.append(legacy);
		const originalBytes = readFileSync(getMeterPaths(root).usageFile, "utf8");
		let scans = 0;
		const reader = {
			getSessionId: () => manager.getSessionId(), getSessionFile: () => manager.getSessionFile(), getCwd: () => manager.getCwd(),
			getHeader: () => manager.getHeader(), getLeafId: () => manager.getLeafId(), getEntry: (id: string) => manager.getEntry(id),
			getEntryCount: () => manager.getEntryCount(), getEntries: () => { scans++; return manager.getEntries(); },
		} as unknown as Parameters<SessionUsageCapture["capture"]>[0];
		const capture = new SessionUsageCapture();
		await capture.capture(reader, store);
		expect(readFileSync(getMeterPaths(root).usageFile, "utf8")).toBe(originalBytes);
		expect(statusForLimit(await store.readAll(), { scope: "session", period: "day", metric: "cost", max: 1 }, new Date(assistant.timestamp), "s").current).toBe(0.01);
		for (let i = 0; i < 10; i++) await capture.capture(reader, store);
		expect(scans).toBe(1);
		manager.appendMessage(assistant); // Exactly equal payload; genuinely new persisted ID.
		await capture.capture(reader, store); await capture.capture(reader, store);
		expect(scans).toBe(1);
		expect((await store.readAll()).reduce((sum, r) => sum + r.cost, 0)).toBeCloseTo(0.02, 12);
		await new SessionUsageCapture().capture(manager, store);
		expect(await store.readAll()).toHaveLength(2);
	});
});
