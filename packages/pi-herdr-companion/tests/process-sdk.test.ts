import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentSystemPrompt, getCurrentTools,
	InMemoryCredentialStore, InMemoryModelsStore, type JsonObject, type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	try {
		for (const dispose of cleanup.splice(0).reverse()) await dispose();
	} finally {
		vi.unstubAllEnvs();
	}
});
const start: JsonObject = { action: "start", label: "h1", command: "printf 'H1 ready\\n'" };

async function fixture(inside = true) {
	const cwd = mkdtempSync(join(tmpdir(), "herdr-sdk-"));
	const agentDir = join(cwd, "agent");
	const bin = join(cwd, "bin");
	mkdirSync(agentDir);
	mkdirSync(bin);
	cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));

	// Isolate BEFORE the real loader: inherited caller/socket identity must never
	// reach the user's Herdr session, including during session_start or shutdown.
	for (const key of Object.keys(process.env)) {
		if (key.startsWith("HERDR_")) vi.stubEnv(key, undefined);
	}
	vi.stubEnv("PI_HERDR_COMPANION_BTW_PAYLOAD", undefined);
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("PI_PROGRAM_STATUS", "0");
	vi.stubEnv("H1_CLI_ROOT", cwd);
	if (inside) {
		for (const [key, value] of Object.entries({
			HERDR_ENV: "1", HERDR_PANE_ID: "h1:p1", HERDR_TAB_ID: "h1:t1",
			HERDR_WORKSPACE_ID: "h1", HERDR_SOCKET_PATH: join(cwd, "unused.sock"),
		})) vi.stubEnv(key, value);
	}
	const cliSource = readFileSync(fileURLToPath(new URL("./fixtures/herdr-cli.cjs", import.meta.url)), "utf8");
	writeFileSync(join(bin, "herdr"), `#!${process.execPath}\n${cliSource}`);
	chmodSync(join(bin, "herdr"), 0o700);
	vi.stubEnv("PATH", `${bin}${delimiter}${process.env.PATH ?? ""}`);
	const initialPanes = [
		{ pane_id: "h1:p1", terminal_id: "h1-caller" },
		{ pane_id: "h1:p9", terminal_id: "h1-unowned" },
	];
	writeFileSync(join(cwd, "panes.json"), JSON.stringify(initialPanes));
	writeFileSync(join(cwd, "calls.jsonl"), "");
	const calls = (): string[][] => readFileSync(join(cwd, "calls.jsonl"), "utf8").trim().split("\n").filter(Boolean).map(line => JSON.parse(line));
	const panes = () => JSON.parse(readFileSync(join(cwd, "panes.json"), "utf8"));

	const provider = fauxProvider({ provider: "h1-herdr", tokensPerSecond: Infinity });
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null,
		allowModelNetwork: false, refreshOnCreate: false,
	});
	await modelRuntime.setRuntimeApiKey("h1-herdr", "offline-fixture");
	const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
	const callable: string[][] = [];
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager,
		additionalExtensionPaths: [fileURLToPath(new URL("../extensions/herdr-companion.ts", import.meta.url))],
		noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [pi => {
			pi.registerProvider(provider.provider);
			pi.registerTool({
				name: "nested_process", label: "Nested process probe", description: "Attempt native nested process management",
				parameters: Type.Object({ action: Type.String() }),
				async execute(_id, args, _signal, _update, ctx) {
					callable.push(ctx.tools.map(tool => tool.name));
					const outcome = await ctx.executeTool("herdr_process", { ...start, label: "nested-h1", action: args.action, target: "h1" });
					return { ...outcome.result, isError: outcome.isError };
				},
			});
		}],
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const sessionManager = SessionManager.inMemory(cwd);
	const { session } = await createAgentSession({
		cwd, agentDir, modelRuntime, resourceLoader, settingsManager, sessionManager,
		model: provider.getModel(), thinkingLevel: "off", noTools: "builtin",
	});
	cleanup.push(async () => {
		await session.abort();
		await session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
	});
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: error => { errors.push(error); } });
	expect(errors).toEqual([]);
	let callNumber = 0;
	const declarations: string[][] = [];
	const prompts: string[] = [];
	async function call(args: JsonObject, name = "herdr_process") {
		const id = `herdr-sdk-${++callNumber}`;
		provider.setResponses([
			context => {
				declarations.push(getCurrentTools(context.messages).map(tool => tool.name));
				prompts.push(getCurrentSystemPrompt(context.messages));
				return fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Done"),
		]);
		await session.prompt(`Execute fixture call ${id}`);
		expect(errors).toEqual([]);
		const result = session.messages.find((message): message is ToolResultMessage =>
			message.role === "toolResult" && message.toolCallId === id);
		expect(result, "the real agent loop must persist its tool result").toBeDefined();
		return result!;
	}
	return { session, sessionManager, call, calls, panes, initialPanes, declarations, prompts, callable, agentDir };
}

describe.skipIf(process.platform === "win32")("Herdr through the Pi 1.1 loader and agent loop (offline CLI)", () => {
	it("activates the real process path; direct calls retain ownership, logs, tree/reload and shutdown cleanup", async () => {
		const f = await fixture();
		expect(f.session.getActiveToolNames()).toContain("herdr_process");
		expect(f.session.getAllTools().map(tool => tool.name)).not.toContain("herdr_worker");
		expect(f.session.getToolDefinition("herdr_process")?.executionMode).toBe("sequential");
		expect((await f.call({ action: "list" })).content).toEqual([{ type: "text", text: "No companion-owned process panes are live." }]);
		expect(f.calls()).toContainEqual(["pane", "list"]);
		const branchPoint = f.sessionManager.getLeafId()!;
		const started = await f.call(start);
		expect(started.isError).toBe(false);
		expect(started.details).toMatchObject({ paneId: "h1:p2", registry: { entries: [{ ownerPaneId: "h1:p1", label: "h1" }] } });
		expect(f.calls().some(args => args[1] === "split" && args.includes("--no-focus"))).toBe(true);
		expect((await f.call({ action: "logs", target: "h1" })).content).toEqual([{ type: "text", text: "[h1 · h1:p2]\nH1 ready\n" }]);

		// A tree jump before creation must not orphan the still-live owned terminal.
		expect((await f.session.navigateTree(branchPoint, { summarize: false })).cancelled).toBe(false);
		await f.session.reload();
		expect((await f.call({ action: "list" })).details).toMatchObject({ registry: { entries: [{ paneId: "h1:p2" }] } });
		for (const target of ["h1:p1", "h1:p9"]) {
			expect((await f.call({ action: "stop", target })).isError).toBe(true);
		}
		expect(f.calls().filter(args => args[1] === "close")).toEqual([]);
		expect((await f.call({ action: "stop", target: "h1" })).isError).toBe(false);
		expect(f.panes()).toEqual(f.initialPanes);
		expect((await f.call(start)).isError).toBe(false);
		await f.session.extensionRunner.emit({ type: "session_shutdown", reason: "quit" });
		expect(f.panes()).toEqual(f.initialPanes);
		expect(f.calls().filter(args => args[1] === "close")).toEqual([
			["pane", "close", "h1:p2"], ["pane", "close", "h1:p2"],
		]);
		expect(f.declarations.every(names => names.includes("herdr_process") && !names.includes("herdr_worker"))).toBe(true);
		expect(f.prompts[0]).toContain("pane: h1:p1");
	});

	it("rejects every native nested action before any CLI access or ownership mutation", async () => {
		const f = await fixture();
		expect((await f.call(start)).isError).toBe(false);
		const callsBefore = f.calls();
		const panesBefore = f.panes();
		const ownership = () => f.sessionManager.getEntries().filter(entry => entry.type === "custom");
		const ownershipBefore = ownership();
		for (const action of ["list", "start", "logs", "stop"]) {
			const nested = await f.call({ action }, "nested_process");
			expect(nested.isError).toBe(true);
			expect(nested.content).toEqual([{ type: "text", text: expect.stringMatching(/not found|not callable/i) }]);
			expect(f.calls()).toEqual(callsBefore);
			expect(f.panes()).toEqual(panesBefore);
			expect(ownership()).toEqual(ownershipBefore);
		}
		expect(f.callable.every(names => !names.includes("herdr_process"))).toBe(true);
	});

	it("is inactive outside Herdr without CLI calls, config creation or runtime injection", async () => {
		const f = await fixture(false);
		expect(f.session.getAllTools().map(tool => tool.name)).not.toContain("herdr_process");
		expect((await f.call({ action: "list" })).isError).toBe(true);
		expect(f.calls()).toEqual([]);
		expect(f.prompts[0]).not.toContain("## Runtime: Herdr companion");
		expect(existsSync(join(f.agentDir, "extension-data", "pi-herdr-companion"))).toBe(false);
	});
});
