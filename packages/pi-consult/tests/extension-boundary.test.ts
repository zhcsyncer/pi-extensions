import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createAssistantMessageEventStream, InMemoryCredentialStore, InMemoryModelsStore, type AssistantMessage, type Model, type Provider } from "@earendil-works/pi-ai";
import { createAgentSession, DefaultResourceLoader, ModelRuntime, SessionManager, SettingsManager, type AgentSession } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { expect, it, vi } from "vitest";
import consultExtension from "../extensions/consult.ts";
import { saveConsultConfig } from "../src/config.ts";
import { WATCHDOG_STEER_TEXT } from "../src/messages.ts";

it.each(["direct", "nested", "watchdog"] as const)("enforces the %s boundary in a real SDK session", async (scenario) => {
	const directory = await mkdtemp(path.join(tmpdir(), "consult-boundary-"));
	vi.stubEnv("PI_CODING_AGENT_DIR", directory);
	let session: AgentSession | undefined;
	try {
		await saveConsultConfig({ panel: [{ model: "offline-boundary/advisor" }], fanout: false,
			gates: { watchdog: 3 }, budget: { perRun: 3, perSession: 8 }, disabledForModels: [] }, directory);
		const model: Model<"openai-completions"> = {
			id: "executor", provider: "offline-boundary", name: "Offline executor", api: "openai-completions",
			baseUrl: "https://never-request.invalid", reasoning: false, input: ["text"], contextWindow: 32_000, maxTokens: 4_000,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		};
		let executorCalls = 0;
		let advisorCalls = 0;
		const nudges: number[] = [];
		const ends: Array<{ name: string; parent?: string }> = [];
		let nestedRejected = false;
		const provider: Provider = {
			id: model.provider, name: "Offline boundary",
			auth: { apiKey: { name: "Offline", resolve: async () => ({ auth: { apiKey: "synthetic" } }) } },
			getModels: () => [model, { ...model, id: "advisor", name: "Offline advisor" }],
			stream: () => { throw new Error("Unexpected API-specific stream"); },
			streamSimple: (requested, context) => {
				let content: AssistantMessage["content"];
				let stopReason: "stop" | "toolUse" = "stop";
				if (requested.id === "advisor") {
					advisorCalls += 1;
					content = [{ type: "text", text: '{"verdict":"confirm","summary":"offline advice"}' }];
				} else {
					executorCalls += 1;
					nudges.push(context.messages.filter((message) => message.role === "user" &&
						JSON.stringify(message.content).includes(WATCHDOG_STEER_TEXT.split("\n")[0])).length);
					const count = scenario === "watchdog" ? 3 : 1;
					if (executorCalls <= count) {
						stopReason = "toolUse";
						content = [{ type: "toolCall", id: `outer-${executorCalls}`,
							name: scenario === "direct" ? "consult" : "outer",
							arguments: scenario === "direct" ? { why: "Resolve a consequential structural choice" } : {} }];
					} else content = [{ type: "text", text: "Done" }];
				}
				const stream = createAssistantMessageEventStream();
				stream.push({ type: "done", reason: stopReason, message: {
					role: "assistant", content, api: requested.api, provider: requested.provider, model: requested.id,
					stopReason, timestamp: Date.now(), usage: { input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
						cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
				} });
				return stream;
			},
		};
		const modelRuntime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
			modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
		modelRuntime.registerNativeProvider(provider);
		const settingsManager = SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: false } });
		const resourceLoader = new DefaultResourceLoader({ cwd: directory, agentDir: directory, settingsManager,
			noExtensions: true, noSkills: true, noPromptTemplates: true, noThemes: true, noContextFiles: true,
			extensionFactories: [consultExtension, (pi) => {
				pi.registerTool({ name: "noop", label: "Noop", description: "Offline leaf", parameters: Type.Object({}),
					execute: async () => ({ content: [{ type: "text", text: "ok" }], details: undefined }) });
				pi.registerTool({ name: "outer", label: "Outer", description: "Offline nesting probe", parameters: Type.Object({}),
					execute: async (_id, _args, _signal, _update, ctx) => {
						if (scenario === "nested") {
							const result = await ctx.executeTool("consult", { why: "Nested requests must be rejected" });
							nestedRejected = result.isError === true;
						} else {
							for (let index = 0; index < 5; index++) await ctx.executeTool("noop", {});
						}
						return { content: [{ type: "text", text: "outer done" }], details: undefined };
					} });
				pi.on("tool_execution_end", async (event) => { ends.push({ name: event.toolName, parent: event.parentToolCallId }); });
			}],
		});
		await resourceLoader.reload();
		expect(resourceLoader.getExtensions().errors).toEqual([]);
		({ session } = await createAgentSession({ cwd: directory, agentDir: directory, model, modelRuntime,
			resourceLoader, settingsManager, sessionManager: SessionManager.inMemory(directory), noTools: "builtin", thinkingLevel: "off" }));
		const errors: unknown[] = [];
		await session.bindExtensions({ onError: (error) => { errors.push(error); } });
		expect(session.getActiveToolNames()).toEqual(expect.arrayContaining(["consult", "outer", "noop"]));
		await session.prompt("Exercise the offline boundary");
		expect(session.messages.filter((message) => message.role === "assistant" && message.stopReason === "error")).toEqual([]);
		expect(errors).toEqual([]);
		if (scenario === "direct") {
			expect(advisorCalls).toBe(1);
			expect(session.messages).toEqual(expect.arrayContaining([expect.objectContaining({ role: "toolResult", toolName: "consult",
				details: expect.objectContaining({ outcome: "completed" }) })]));
		} else if (scenario === "nested") {
			expect(nestedRejected).toBe(true);
			expect(advisorCalls).toBe(0);
		} else {
			expect(ends.filter((event) => event.name === "noop" && event.parent)).toHaveLength(15);
			expect(ends.filter((event) => event.name === "outer" && !event.parent)).toHaveLength(3);
			expect(nudges).toEqual([0, 0, 0, 1]);
			expect(advisorCalls).toBe(0);
		}
	} finally {
		session?.dispose();
		vi.unstubAllEnvs();
		await rm(directory, { recursive: true, force: true });
	}
});
