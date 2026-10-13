import { mkdtemp, mkdir, writeFile, readFile, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import {
	createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager,
	type AgentSession, type ExtensionUIContext,
} from "@earendil-works/pi-coding-agent";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore } from "@earendil-works/pi-ai";
import { afterEach, expect, it, vi } from "vitest";

let root: string;
let session: AgentSession | undefined;
afterEach(async () => {
	if (session) {
		await session.extensionRunner?.emit({ type: "session_shutdown", reason: "quit" });
		session.dispose();
		session = undefined;
	}
	vi.unstubAllEnvs();
	if (root) await rm(root, { recursive: true, force: true });
});

const submission = { title: "Offline Plan", markdown: "# Goal\n\nVerify the workflow.\n\n## Execution steps\n\n1. Verify it.\n" };

async function fixture(decision = "Approve Plan", reviewExit = 0) {
	root = await mkdtemp(path.join(tmpdir(), "p1a-sdk-"));
	const agentDir = path.join(root, "agent");
	const cwd = path.join(root, "project");
	await mkdir(agentDir);
	await mkdir(cwd);
	const readPath = path.join(cwd, "input.txt");
	await writeFile(readPath, "nested read positive control");
	const binary = path.join(root, "revdiff-fixture.mjs");
	const reviewLog = path.join(root, "reviews.jsonl");
	await writeFile(binary, `#!/usr/bin/env node\nimport { appendFileSync } from 'node:fs';\nappendFileSync(${JSON.stringify(reviewLog)}, JSON.stringify(process.argv.slice(2))+'\\n');\nprocess.exit(${reviewExit});\n`, { mode: 0o700 });
	vi.stubEnv("PI_CODING_AGENT_DIR", agentDir);
	vi.stubEnv("REVDIFF_BIN", binary);
	const uiCalls: string[] = [];
	const ui = {
		notify() {}, setWidget() {},
		async select(title: string) { uiCalls.push(title); return decision; },
		async custom<T>(factory: Parameters<ExtensionUIContext["custom"]>[0]): Promise<T> {
			uiCalls.push("review");
			return new Promise<T>((resolve) => {
				factory({ stop() {}, start() {}, requestRender() {} } as never, {} as never, {} as never, resolve as (value: unknown) => void);
			});
		},
	} as unknown as ExtensionUIContext;
	const fake = fauxProvider({ provider: "p1a-fixture", models: [{ id: "model", contextWindow: 200000 }], tokensPerSecond: 1000000 });
	const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, allowModelNetwork: false });
	runtime.registerNativeProvider(fake.provider);
	await runtime.setRuntimeApiKey("p1a-fixture", "synthetic-local");
	await runtime.getAvailable();
	const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
	let bridgeCalls = 0;
	const loader = new DefaultResourceLoader({
		cwd, agentDir, settingsManager, noExtensions: true, noSkills: true, noContextFiles: true, noThemes: true, noPromptTemplates: true,
		additionalExtensionPaths: [fileURLToPath(new URL("../extensions/plan-mode.ts", import.meta.url))],
		extensionFactories: [(pi) => {
			// Fixture-only carrier uses an already permitted name so Plan cannot reject
			// the outer call and falsely appear to enforce SDK model-only exposure.
			pi.registerTool({ name: "web_search", label: "Nested fixture", description: "Offline nested-call carrier",
				parameters: Type.Object({ target: Type.String(), args: Type.Record(Type.String(), Type.Unknown()) }),
				async execute(_id, args, _signal, _update, ctx) {
					bridgeCalls++;
					const outcome = await ctx.executeTool(args.target, args.args);
					return { ...outcome.result, isError: outcome.isError };
				},
			});
		}],
	});
	await loader.reload();
	expect(loader.getExtensions().errors).toEqual([]);
	const manager = SessionManager.create(cwd, path.join(root, "sessions"));
	({ session } = await createAgentSession({ cwd, agentDir, resourceLoader: loader, modelRuntime: runtime, model: fake.getModel(), settingsManager, sessionManager: manager }));
	await session.bindExtensions({ mode: "tui", uiContext: ui });
	const active = session;
	async function call(name: string, args: Parameters<typeof fauxToolCall>[1]) {
		const before = active.messages.length;
		fake.setResponses([
			fauxAssistantMessage(fauxToolCall(name, args), { stopReason: "toolUse" }),
			fauxAssistantMessage("DONE"), fauxAssistantMessage("DONE"),
		]);
		await active.prompt("Run the offline fixture call.");
		const result = active.messages.slice(before).find((message) => message.role === "toolResult" && message.toolName === name);
		if (!result || result.role !== "toolResult") throw new Error(`Missing tool result: ${name}`);
		return result;
	}
	async function snapshot() {
		const plans = path.join(agentDir, "plans");
		const artifacts: Record<string, string> = {};
		async function visit(dir: string) {
			for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
				const file = path.join(dir, entry.name);
				if (entry.isDirectory()) await visit(file);
				else artifacts[path.relative(plans, file)] = await readFile(file, "utf8");
			}
		}
		await visit(plans);
		return {
			artifacts, ui: [...uiCalls],
			state: JSON.stringify(manager.getBranch().filter((entry) => entry.type === "custom")),
			reviews: await readFile(reviewLog, "utf8").catch(() => ""),
		};
	}
	return { active, manager, call, snapshot, readPath, bridgeCalls: () => bridgeCalls };
}

it("keeps real direct submission/completion usable but refuses nested calls before workflow side effects", async () => {
	const f = await fixture();
	await f.active.prompt("/plan on");
	const nestedRead = await f.call("web_search", { target: "read", args: { path: f.readPath } });
	expect(nestedRead.isError).not.toBe(true);
	expect(JSON.stringify(nestedRead.content)).toContain("nested read positive control");
	expect(f.active.getActiveToolNames()).toContain("submit_plan");
	expect(f.active.getCallableToolNames()).not.toContain("submit_plan");
	const beforeSubmit = await f.snapshot();
	const deniedSubmit = await f.call("web_search", { target: "submit_plan", args: submission });
	expect(deniedSubmit.isError).toBe(true);
	expect(await f.snapshot()).toEqual(beforeSubmit);
	expect(f.bridgeCalls()).toBe(2);
	expect(f.active.getToolDefinition("submit_plan")?.exposure).toBe("model-only");
	const approved = await f.call("submit_plan", submission);
	expect(approved.isError).not.toBe(true);
	const details = approved.details as { kind: string; planId: string; revision: number };
	expect(details.kind).toBe("approved");
	expect((await f.snapshot()).reviews).toContain("--only");
	expect((await f.snapshot()).ui).toContain("Plan review finished. Choose an explicit decision:");
	const completion = { planId: details.planId, revision: details.revision, summary: "Verified", verification: ["Offline fixture passed"] };
	expect(f.active.getActiveToolNames()).toContain("complete_plan");
	expect(f.active.getCallableToolNames()).not.toContain("complete_plan");
	const beforeComplete = await f.snapshot();
	const deniedComplete = await f.call("web_search", { target: "complete_plan", args: completion });
	expect(deniedComplete.isError).toBe(true);
	expect(await f.snapshot()).toEqual(beforeComplete);
	expect(f.bridgeCalls()).toBe(3);
	expect(f.active.getToolDefinition("complete_plan")?.exposure).toBe("model-only");
	const completed = await f.call("complete_plan", completion);
	expect(completed.isError).not.toBe(true);
	expect(completed.details).toMatchObject({ kind: "completed", planId: details.planId, revision: details.revision });
	expect(f.active.getActiveToolNames()).not.toContain("complete_plan");
});

it.each([
	{ decision: "Keep planning", exit: 0, kind: "keep_planning" },
	{ decision: "Approve Plan", exit: 130, kind: "cancelled" },
])("does not approve or complete after $kind", async ({ decision, exit, kind }) => {
	const f = await fixture(decision, exit);
	await f.active.prompt("/plan on");
	const result = await f.call("submit_plan", submission);
	expect(result.details).toMatchObject({ kind });
	expect(f.active.getActiveToolNames()).toContain("submit_plan");
	expect(f.active.getActiveToolNames()).not.toContain("complete_plan");
	const snapshot = await f.snapshot();
	expect(snapshot.state).not.toContain('"implementing"');
	expect(snapshot.state).not.toContain('"completed"');
	expect(snapshot.reviews).toContain("--only");
});
