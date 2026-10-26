import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
	createAssistantMessageEventStream,
	getCurrentSystemPrompt,
	getCurrentTools,
	InMemoryCredentialStore,
	InMemoryModelsStore,
	type Model,
	type Provider,
} from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import { executeConsult } from "../src/execute.ts";
import { CONSULT_SYSTEM_PROMPT } from "../src/prompt.ts";
import { ConsultTracker } from "../src/tracker.ts";

// Observe SDK dispatch at the provider boundary, not an injected Consult stream.
describe("Consult configured-provider authentication", () => {
	it.each(["api_key", "oauth"] as const)("keeps %s identity and credential-derived request fields", async (type) => {
		const directory = await mkdtemp(path.join(tmpdir(), "consult-sdk-auth-"));
		try {
			const credentials = new InMemoryCredentialStore();
			await credentials.modify("offline-advisor", async () => type === "oauth"
				? { type, access: "synthetic-access", refresh: "synthetic-refresh", expires: Date.now() + 3_600_000,
					endpoint: "https://subscription.invalid/account-a", account: "account-a" }
				: { type, key: "synthetic-key", env: { ACCOUNT: "account-a" } });
			const model: Model<"openai-completions"> = {
				id: "physical-advisor", provider: "offline-advisor", name: "Offline advisor",
				api: "openai-completions", baseUrl: "https://default.invalid/v1", reasoning: true,
				input: ["text", "image"], contextWindow: 32_000, maxTokens: 4_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
			};
			const signal = new AbortController().signal;
			let dispatches = 0;
			let oauthDerivations = 0;
			const provider: Provider = {
				id: model.provider, name: model.name,
				auth: {
					apiKey: {
						name: "Offline key",
						resolve: async ({ credential }) => {
							if (type === "oauth") throw new Error("OAuth must not fall back to a paid key");
							return credential?.key ? {
								auth: { apiKey: credential.key, headers: { "x-account": credential.env?.ACCOUNT ?? null } },
								env: credential.env,
							} : undefined;
						},
					},
					oauth: {
						name: "Offline subscription", isSubscription: true,
						login: async () => { throw new Error("No login allowed"); },
						refresh: async () => { throw new Error("No refresh expected"); },
						toAuth: async (credential) => {
							oauthDerivations += 1;
							return { apiKey: credential.access, baseUrl: String(credential.endpoint),
								headers: { "x-account": String(credential.account), "x-subscription": "included" } };
						},
					},
				},
				getModels: () => [model],
				stream: () => { throw new Error("Use provider-neutral streaming"); },
				streamSimple: (requestModel, context, options) => {
					dispatches += 1;
					expect(requestModel.provider).toBe(model.provider);
					expect(requestModel.id).toBe(model.id);
					expect(requestModel.baseUrl).toBe(type === "oauth" ? "https://subscription.invalid/account-a" : model.baseUrl);
					expect(options?.apiKey).toBe(type === "oauth" ? "synthetic-access" : "synthetic-key");
					expect(options?.headers).toMatchObject({ "x-account": "account-a" });
					if (type === "oauth") expect(options?.headers).toMatchObject({ "x-subscription": "included" });
					else expect(options?.env).toMatchObject({ ACCOUNT: "account-a" });
					expect(options?.signal).toBe(signal);
					expect(options?.reasoning).toBe("high");
					expect(getCurrentSystemPrompt(context.messages)).toBe(CONSULT_SYSTEM_PROMPT);
					expect(getCurrentTools(context.messages)).toEqual([]);
					const stream = createAssistantMessageEventStream();
					stream.push({ type: "done", reason: "stop", message: {
						role: "assistant", content: [{ type: "text", text: '{"verdict":"confirm","summary":"same account"}' }],
						api: model.api, provider: model.provider, model: model.id, timestamp: Date.now(), stopReason: "stop",
						usage: { input: 2, output: 3, cacheRead: 0, cacheWrite: 0, totalTokens: 5,
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
					} });
					return stream;
				},
			};
			const runtime = await ModelRuntime.create({ credentials, modelsPath: null,
				modelsStore: new InMemoryModelsStore(), refreshOnCreate: false, allowModelNetwork: false });
			const registry = new ModelRegistry(runtime);
			registry.registerProvider(provider);
			// First prove the target public SDK route independently of Consult's implementation.
			const direct = await registry.streamSimple(registry.find(model.provider, model.id)!,
				{ systemPrompt: CONSULT_SYSTEM_PROMPT, messages: [], tools: [] }, { signal, reasoning: "high" }).result();
			expect(direct.errorMessage).toBeUndefined();
			expect(direct.stopReason).toBe("stop");
			const result = await executeConsult({
				why: "Choose between consequential structural alternatives", toolCallId: "consult-auth",
				ctx: { modelRegistry: registry, sessionManager: {
					getEntries: () => [], getLeafId: () => null, getSessionFile: () => null,
				} } as unknown as ExtensionContext,
				pi: { getAllTools: () => [] } as unknown as ExtensionAPI,
				config: { panel: [{ model: `${model.provider}/${model.id}`, effort: "high" }], fanout: false,
					gates: { watchdog: 5 }, budget: { perRun: 3, perSession: 8 }, disabledForModels: [] },
				tracker: new ConsultTracker(), agentDir: directory, signal,
			});
			expect(result.details?.outcome).toBe("completed");
			expect(result.usage?.totalTokens).toBe(5);
			expect(dispatches).toBe(2);
			if (type === "oauth") expect(oauthDerivations).toBeGreaterThanOrEqual(2);
		} finally {
			await rm(directory, { recursive: true, force: true });
		}
	});
});
