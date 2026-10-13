import { mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	fauxAssistantMessage, fauxProvider, fauxToolCall, InMemoryCredentialStore, InMemoryModelsStore,
	type JsonObject, type ToolResultMessage,
} from "@earendil-works/pi-ai";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { afterEach, describe, expect, it } from "vitest";

const cleanup: Array<() => void | Promise<void>> = [];
afterEach(async () => {
	for (const dispose of cleanup.splice(0).reverse()) await dispose();
});
const batch: JsonObject = {
	action: "batch",
	operations: [
		{ action: "create", subject: "Investigate behavior", status: "in_progress" },
		{ action: "create", subject: "Deliver implementation" },
	],
};

async function fixture() {
	const cwd = mkdtempSync(join(tmpdir(), "pi-todo-sdk-"));
	const agentDir = join(cwd, "agent");
	mkdirSync(agentDir);
	cleanup.push(() => rmSync(cwd, { recursive: true, force: true }));
	const provider = fauxProvider({ provider: "f1-todo", tokensPerSecond: Infinity });
	const modelRuntime = await ModelRuntime.create({
		credentials: new InMemoryCredentialStore(), modelsStore: new InMemoryModelsStore(), modelsPath: null,
		allowModelNetwork: false, refreshOnCreate: false,
	});
	await modelRuntime.setRuntimeApiKey("f1-todo", "offline-fixture");
	const settingsManager = SettingsManager.inMemory({ packages: [], compaction: { enabled: false }, retry: { enabled: false } });
	const resourceLoader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager,
		additionalExtensionPaths: [fileURLToPath(new URL("./index.ts", import.meta.url))],
		noSkills: true, noThemes: true, noPromptTemplates: true, noContextFiles: true,
		extensionFactories: [pi => {
			pi.registerProvider(provider.provider);
			pi.registerTool({
				name: "nested_todo", label: "Nested Todo probe", description: "Attempt the same batch through native nested execution",
				parameters: Type.Object({}),
				async execute(_id, _args, _signal, _update, ctx) {
					const outcome = await ctx.executeTool("todo", batch);
					return { ...outcome.result, isError: outcome.isError };
				},
			});
		}],
	});
	await resourceLoader.reload();
	expect(resourceLoader.getExtensions().errors).toEqual([]);
	const sessionManager = SessionManager.create(cwd, join(cwd, "sessions"));
	const { session } = await createAgentSession({
		cwd, agentDir, modelRuntime, resourceLoader, settingsManager, sessionManager,
		model: provider.getModel(), thinkingLevel: "off", noTools: "builtin",
	});
	cleanup.push(async () => { await session.abort(); session.dispose(); });
	const errors: unknown[] = [];
	await session.bindExtensions({ onError: error => { errors.push(error); } });
	let callNumber = 0;
	async function call(name: string, args: JsonObject) {
		const id = `todo-sdk-${++callNumber}`;
		provider.setResponses([
			fauxAssistantMessage(fauxToolCall(name, args, { id }), { stopReason: "toolUse" }),
			fauxAssistantMessage("Done"),
		]);
		await session.prompt(`Execute fixture call ${id}`);
		expect(errors).toEqual([]);
		const result = session.messages.find((message): message is ToolResultMessage =>
			message.role === "toolResult" && message.toolCallId === id);
		expect(result, "the real agent loop must persist its tool result").toBeDefined();
		return result!;
	}
	return { session, sessionManager, call };
}

function checkpoints(session: AgentSession) {
	// Read actual JSONL, not the in-memory product store or a registration mock.
	return readFileSync(session.sessionFile!, "utf8").trim().split("\n").filter(line => {
		const entry = JSON.parse(line);
		return entry.type === "message" && entry.message.role === "toolResult"
			&& entry.message.toolName === "todo" && entry.message.details?.kind === "checkpoint";
	});
}

describe("Todo through the Pi 1.1 loader and agent loop", () => {
	it("direct batch mutates state; nested execution cannot change state or persisted checkpoints", async () => {
		const f = await fixture();
		const direct = await f.call("todo", batch);
		expect(direct.isError).toBe(false);
		expect(direct.details).toMatchObject({ schemaVersion: 2, kind: "checkpoint", state: {
			nextId: 3, tasks: [{ id: 1, status: "in_progress" }, { id: 2, status: "pending" }],
		} });
		const before = await f.call("todo", { action: "list" });
		const persisted = checkpoints(f.session);
		expect(persisted).toHaveLength(1);

		// A failed second operation must not leak the first update or a checkpoint.
		const invalid = await f.call("todo", { action: "batch", operations: [
			{ action: "update", id: 1, subject: "Must roll back" },
			{ action: "update", id: 2, status: "in_progress" },
		] });
		expect(invalid.isError).toBe(true);
		expect((await f.call("todo", { action: "list" })).content).toEqual(before.content);
		expect(checkpoints(f.session)).toEqual(persisted);
		// The identical creation batch is legitimate again once this cycle is
		// terminal: without model-only the nested call would roll over the cycle.
		expect((await f.call("todo", { action: "batch", operations: [
			{ action: "update", id: 1, status: "completed" },
			{ action: "update", id: 2, status: "completed" },
		] })).isError).toBe(false);
		const terminal = await f.call("todo", { action: "list", includeDeleted: true });
		const terminalCheckpoints = checkpoints(f.session);
		expect(terminalCheckpoints).toHaveLength(2);
		const nested = await f.call("nested_todo", {});
		expect(nested.isError).toBe(true);
		expect(nested.content).toEqual([{ type: "text", text: expect.stringMatching(/not found|not callable/i) }]);
		expect((await f.call("todo", { action: "list", includeDeleted: true })).content).toEqual(terminal.content);
		expect(checkpoints(f.session)).toEqual(terminalCheckpoints);
		await f.session.reload();
		expect((await f.call("todo", { action: "list", includeDeleted: true })).content).toEqual(terminal.content);
		const rollover = await f.call("todo", batch);
		expect(rollover.isError).toBe(false);
		expect(rollover.details).toMatchObject({ state: { nextId: 5, tasks: [
			{ id: 3, status: "in_progress" }, { id: 4, status: "pending" },
		] } });
	});

	it("tree restoration keeps IDs monotonic and a separate session starts empty", async () => {
		const f = await fixture();
		await f.call("todo", batch);
		const initial = await f.call("todo", { action: "list" });
		const branchPoint = f.sessionManager.getLeafId()!;
		await f.call("todo", { action: "create", subject: "Abandoned branch task" });
		expect((await f.session.navigateTree(branchPoint, { summarize: false })).cancelled).toBe(false);
		expect((await f.call("todo", { action: "list" })).content).toEqual(initial.content);
		const added = await f.call("todo", { action: "create", subject: "New branch task" });
		expect(added.details).toMatchObject({ state: { nextId: 5, tasks: [
			{ id: 1 }, { id: 2 }, { id: 4, subject: "New branch task" },
		] } });
		const fresh = await fixture();
		expect((await fresh.call("todo", { action: "list" })).content).toEqual([{ type: "text", text: "No tasks" }]);
	});
});
