import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	fauxAssistantMessage, fauxProvider, fauxToolCall, getCurrentTools,
	InMemoryCredentialStore, InMemoryModelsStore, type JsonObject, type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";
import { ASK_USER_BLOCKED_EVENT, ASK_USER_PROMPT_EVENT, type AskUserBlockedEventPayload } from "./events.js";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const params: JsonObject = { questions: [
	{ question: "Which implementation?", header: "Approach", options: [
		{ label: "Small", description: "Keep the change local", preview: "const local = true;" },
		{ label: "Broad", description: "Change all callers" },
	] },
	{ question: "Which follow-up?", header: "Follow-up", options: [
		{ label: "Document", description: "Explain the workflow" },
		{ label: "Measure", description: "Measure performance" },
	] },
] };

type Select = ExtensionUIContext["select"];
async function fixture(options: { noUI?: boolean; select?: Select } = {}) {
	const cwd = mkdtempSync(join(tmpdir(), "pi-question-sdk-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
	const provider = fauxProvider({ provider: "f1-question", tokensPerSecond: Infinity });
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null,
		allowModelNetwork: false, refreshOnCreate: false,
	});
	await modelRuntime.setRuntimeApiKey("f1-question", "offline-fixture");
	const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
	const blocked: boolean[] = [];
	const prompts: unknown[] = [];
	let operationSignal: AbortSignal | undefined;
	// The public SDK supplies the default non-interactive UI. Only the host's
	// dialog boundary is replaced; product registration and execution stay real.
	let defaultUI: ExtensionUIContext | undefined;
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager,
		additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
		noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [pi => {
			pi.registerProvider(provider.provider);
			pi.on("session_start", (_event, ctx) => { defaultUI ??= ctx.ui; });
			pi.on("tool_call", (_event, ctx) => { operationSignal = ctx.signal; });
			const offBlocked = pi.events.on(ASK_USER_BLOCKED_EVENT, data => blocked.push((data as AskUserBlockedEventPayload).active));
			const offPrompt = pi.events.on(ASK_USER_PROMPT_EVENT, data => prompts.push(data));
			pi.on("session_shutdown", () => { offBlocked(); offPrompt(); });
			pi.registerTool({
				name: "nested_question", label: "Nested question probe", description: "Attempt native nested questionnaire execution",
				parameters: Type.Object({}),
				async execute(_id, _args, _signal, _update, ctx) {
					const outcome = await ctx.executeTool("ask_user_question", params);
					return { ...outcome.result, isError: outcome.isError };
				},
			});
		}],
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const { session } = await createAgentSession({
		cwd, agentDir, modelRuntime, resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(cwd),
		model: provider.getModel(), thinkingLevel: "off", noTools: "builtin",
	});
	cleanup.push(async () => { await session.abort(); session.dispose(); });
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: error => { errors.push(error); } });
	const dialogs: Array<{ method: string; title: string; options?: string[] }> = [];
	if (!options.noUI) {
		await session.bindExtensions({ mode: "rpc", uiContext: {
			...defaultUI!,
			async select(title, choices, opts) {
				dialogs.push({ method: "select", title, options: choices });
				return options.select ? options.select(title, choices, opts)
					: choices[title.includes("Which implementation?") ? 0 : choices.length - 1];
			},
			async input(title) {
				dialogs.push({ method: "input", title });
				return "A custom follow-up";
			},
			async custom() { throw new Error("RPC must not open a terminal form"); },
		} });
	}
	let callNumber = 0;
	const declarations: string[][] = [];
	async function call(name = "ask_user_question") {
		const id = `question-sdk-${++callNumber}`;
		provider.setResponses([
			context => {
				declarations.push(getCurrentTools(context.messages).map(tool => tool.name));
				return fauxAssistantMessage(fauxToolCall(name, name === "ask_user_question" ? params : {}, { id }), { stopReason: "toolUse" });
			},
			fauxAssistantMessage("Done"),
		]);
		await session.prompt(`Execute fixture call ${id}`);
		expect(errors).toEqual([]);
		const result = session.messages.find((message): message is ToolResultMessage =>
			message.role === "toolResult" && message.toolCallId === id);
		expect(result).toBeDefined();
		return result!;
	}
	return { session, call, blocked, prompts, dialogs, declarations, getSignal: () => operationSignal };
}

describe("Questionnaire through the Pi 1.1 loader and agent loop", () => {
	it("direct calls use public RPC dialogs and retain previews and custom answers", async () => {
		const f = await fixture();
		const result = await f.call();
		expect(result.isError).toBe(false);
		expect(result.details).toMatchObject({ cancelled: false, answers: [
			{ kind: "option", answer: "Small", preview: "const local = true;" },
			{ kind: "custom", answer: "A custom follow-up" },
		] });
		expect(f.dialogs.map(dialog => dialog.method)).toEqual(["select", "select", "input"]);
		expect(f.dialogs[0].title).toContain("const local = true;");
		expect(f.blocked).toEqual([true, false]);
		expect(f.declarations[0]).toContain("ask_user_question");
	});

	it("native nested calls open no dialog and never enter the prompt or blocked lifecycle", async () => {
		const f = await fixture();
		const result = await f.call("nested_question");
		expect(result.isError).toBe(true);
		expect(result.content).toEqual([{ type: "text", text: expect.stringMatching(/not found|not callable/i) }]);
		expect(f.dialogs).toEqual([]);
		expect(f.prompts).toEqual([]);
		expect(f.blocked).toEqual([]);
	});

	it.each(["cancel", "reject"] as const)("clears blocked state when the public dialog host responds with %s", async outcome => {
		const f = await fixture({ select: async () => {
			if (outcome === "reject") throw new Error("Dialog host failed");
			return undefined;
		} });
		const result = await f.call();
		if (outcome === "cancel") {
			expect(result.details).toMatchObject({ cancelled: true, answers: [] });
			expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("declined") }]);
		} else {
			expect(result.isError).toBe(true);
			expect(result.content).toEqual([{ type: "text", text: expect.stringContaining("Dialog host failed") }]);
		}
		expect(f.blocked).toEqual([true, false]);
	});

	it("pairs blocked events on host dismissal during abort and works after reload", async () => {
		let entered!: () => void;
		const opened = new Promise<void>(resolve => { entered = resolve; });
		let waitForAbort = true;
		const f = await fixture({ select: async (_title, choices) => {
			if (!waitForAbort) return choices[0];
			// Embedders own dialog dismissal. Observe the public operation signal,
			// as a host would, rather than resolving a product result in the test.
			return new Promise<string | undefined>(resolve => {
				f.getSignal()!.addEventListener("abort", () => resolve(undefined), { once: true });
				entered();
			});
		} });
		const running = f.call();
		await opened;
		expect(f.blocked).toEqual([true]);
		await f.session.abort();
		await running;
		expect(f.blocked).toEqual([true, false]);
		waitForAbort = false;
		await f.session.reload();
		expect((await f.call()).details).toMatchObject({ cancelled: false });
		expect(f.blocked).toEqual([true, false, true, false]);
	});

	it("no-UI runs remove the declaration and cannot open a questionnaire", async () => {
		const f = await fixture({ noUI: true });
		const result = await f.call(); // Deliberately emit an undeclared call to check the host boundary too.
		expect(f.declarations[0]).not.toContain("ask_user_question");
		expect(result.isError).toBe(true);
		expect(f.dialogs).toEqual([]);
		expect(f.prompts).toEqual([]);
		expect(f.blocked).toEqual([]);
	});
});
