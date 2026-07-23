import {
	createProvider,
	openAICompletionsApi,
	openAIResponsesApi,
	type ApiKeyCredential,
	type AuthContext,
	type AuthInteraction,
	type Credential,
	type Model,
} from "@earendil-works/pi-ai";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

const PROVIDER_ID = "volcengine-agent-plan";
const BASE_URL = "https://ark.cn-beijing.volces.com/api/plan/v3";
const TIER_ENV = "ARK_AGENT_PLAN_TIER";
const KEY_ENV_NAMES = ["ARK_AGENT_PLAN_API_KEY", "VOLCENGINE_ARK_PLAN_API_KEY"] as const;
const KEY_VALIDATION_URL = `${BASE_URL}/responses`;
const KEY_VALIDATION_TIMEOUT_MS = 12_000;

const ZERO_COST = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
};

const RESPONSES_COMPAT = {
	supportsDeveloperRole: true,
	supportsLongCacheRetention: true,
};

const KIMI_CHAT_COMPAT = {
	supportsDeveloperRole: false,
	supportsReasoningEffort: true,
	supportsStore: true,
	supportsUsageInStreaming: true,
	supportsLongCacheRetention: false,
	maxTokensField: "max_completion_tokens" as const,
	requiresReasoningContentOnAssistantMessages: true,
};

type ArkApi = "openai-responses" | "openai-completions";
type PlanTier = "small" | "medium" | "large" | "max";

type CatalogEntry = Omit<Model<ArkApi>, "provider" | "baseUrl"> & {
	minimumTier: PlanTier;
};

const TIER_RANK: Record<PlanTier, number> = {
	small: 0,
	medium: 1,
	large: 2,
	max: 3,
};

const CATALOG: CatalogEntry[] = [
	{
		id: "doubao-seed-2.0-mini",
		name: "Doubao Seed 2.0 Mini",
		api: "openai-responses",
		minimumTier: "small",
		reasoning: true,
		input: ["text"],
		contextWindow: 256_000,
		maxTokens: 128_000,
		cost: ZERO_COST,
		compat: RESPONSES_COMPAT,
	},
	{
		id: "doubao-seed-2.0-lite",
		name: "Doubao Seed 2.0 Lite",
		api: "openai-responses",
		minimumTier: "small",
		reasoning: true,
		input: ["text"],
		contextWindow: 256_000,
		maxTokens: 128_000,
		cost: ZERO_COST,
		compat: RESPONSES_COMPAT,
	},
	{
		id: "deepseek-v4-flash",
		name: "DeepSeek V4 Flash",
		api: "openai-responses",
		minimumTier: "small",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_024_000,
		maxTokens: 384_000,
		cost: ZERO_COST,
		compat: RESPONSES_COMPAT,
	},
	{
		id: "doubao-seed-evolving",
		name: "Doubao Seed Evolving",
		api: "openai-responses",
		minimumTier: "small",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_024_000,
		maxTokens: 256_000,
		cost: ZERO_COST,
		compat: RESPONSES_COMPAT,
	},
	{
		id: "doubao-seed-2.0-code",
		name: "Doubao Seed 2.0 Code",
		api: "openai-responses",
		minimumTier: "small",
		reasoning: true,
		input: ["text"],
		contextWindow: 256_000,
		maxTokens: 128_000,
		cost: ZERO_COST,
		compat: RESPONSES_COMPAT,
	},
	{
		id: "doubao-seed-2.0-pro",
		name: "Doubao Seed 2.0 Pro",
		api: "openai-responses",
		minimumTier: "small",
		reasoning: true,
		input: ["text"],
		contextWindow: 256_000,
		maxTokens: 128_000,
		cost: ZERO_COST,
		compat: RESPONSES_COMPAT,
	},
	{
		id: "minimax-m2.7",
		name: "MiniMax M2.7",
		api: "openai-responses",
		minimumTier: "small",
		reasoning: true,
		thinkingLevelMap: { off: null },
		input: ["text"],
		contextWindow: 200_000,
		maxTokens: 128_000,
		cost: ZERO_COST,
		compat: RESPONSES_COMPAT,
	},
	{
		id: "minimax-m3",
		name: "MiniMax M3",
		api: "openai-responses",
		minimumTier: "small",
		reasoning: true,
		input: ["text"],
		contextWindow: 512_000,
		maxTokens: 128_000,
		cost: ZERO_COST,
		compat: RESPONSES_COMPAT,
	},
	{
		id: "glm-5.2",
		name: "GLM 5.2",
		api: "openai-responses",
		minimumTier: "small",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_024_000,
		maxTokens: 128_000,
		cost: ZERO_COST,
		compat: RESPONSES_COMPAT,
	},
	{
		id: "kimi-k2.6",
		name: "Kimi K2.6",
		api: "openai-completions",
		minimumTier: "small",
		reasoning: true,
		thinkingLevelMap: { off: "minimal" },
		input: ["text"],
		contextWindow: 256_000,
		maxTokens: 32_000,
		cost: ZERO_COST,
		compat: KIMI_CHAT_COMPAT,
	},
	{
		id: "kimi-k2.7-code",
		name: "Kimi K2.7 Code",
		api: "openai-completions",
		minimumTier: "small",
		reasoning: true,
		thinkingLevelMap: { off: null },
		input: ["text"],
		contextWindow: 256_000,
		maxTokens: 32_000,
		cost: ZERO_COST,
		compat: KIMI_CHAT_COMPAT,
	},
	{
		id: "deepseek-v4-pro",
		name: "DeepSeek V4 Pro",
		api: "openai-responses",
		minimumTier: "small",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_024_000,
		maxTokens: 384_000,
		cost: ZERO_COST,
		compat: RESPONSES_COMPAT,
	},
	{
		id: "kimi-k3",
		name: "Kimi K3",
		api: "openai-responses",
		minimumTier: "medium",
		reasoning: true,
		input: ["text"],
		contextWindow: 1_024_000,
		maxTokens: 128_000,
		cost: ZERO_COST,
		compat: RESPONSES_COMPAT,
	},
];

const MINIMUM_TIER = new Map(CATALOG.map((model) => [model.id, model.minimumTier]));
const MODELS: Model<ArkApi>[] = CATALOG.map(({ minimumTier: _minimumTier, ...model }) => ({
	...model,
	provider: PROVIDER_ID,
	baseUrl: BASE_URL,
}));

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

type KeyValidationResult =
	| { status: "valid" }
	| { status: "invalid" }
	| { status: "unavailable"; reason: string };

interface KeyValidationOptions {
	fetchImpl?: typeof fetch;
	signal?: AbortSignal;
	timeoutMs?: number;
}

async function responseErrorCode(response: Response): Promise<string | undefined> {
	try {
		const payload: unknown = await response.json();
		if (!isRecord(payload)) return undefined;
		const error = payload.error;
		if (isRecord(error) && typeof error.code === "string") return error.code;
		return typeof payload.code === "string" ? payload.code : undefined;
	} catch {
		return undefined;
	}
}

export async function validateAgentPlanKey(
	key: string,
	options: KeyValidationOptions = {},
): Promise<KeyValidationResult> {
	const fetchImpl = options.fetchImpl ?? fetch;
	const controller = new AbortController();
	let timedOut = false;
	const timeout = setTimeout(() => {
		timedOut = true;
		controller.abort();
	}, options.timeoutMs ?? KEY_VALIDATION_TIMEOUT_MS);
	const abortFromLogin = () => controller.abort(options.signal?.reason);
	if (options.signal?.aborted) abortFromLogin();
	else options.signal?.addEventListener("abort", abortFromLogin, { once: true });

	try {
		// An authenticated empty request is rejected as MissingParameter before any
		// model inference. Invalid credentials fail earlier with 401/403, allowing
		// login validation without consuming Agent Plan tokens.
		const response = await fetchImpl(KEY_VALIDATION_URL, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${key}`,
				"Content-Type": "application/json",
			},
			body: "{}",
			signal: controller.signal,
		});
		const errorCode = await responseErrorCode(response);

		if (response.status === 401 || response.status === 403) return { status: "invalid" };
		if (response.ok || (response.status === 400 && errorCode === "MissingParameter")) {
			return { status: "valid" };
		}
		return {
			status: "unavailable",
			reason: `HTTP ${response.status}${errorCode ? ` (${errorCode})` : ""}`,
		};
	} catch (error) {
		if (options.signal?.aborted) {
			throw options.signal.reason instanceof Error
				? options.signal.reason
				: new Error("Agent Plan 登录已取消");
		}
		return {
			status: "unavailable",
			reason: timedOut
				? "请求超时"
				: error instanceof Error
					? error.message
					: "未知网络错误",
		};
	} finally {
		clearTimeout(timeout);
		options.signal?.removeEventListener("abort", abortFromLogin);
	}
}

async function promptValidatedAgentPlanKey(
	interaction: AuthInteraction,
	fetchImpl: typeof fetch,
): Promise<string> {
	keyPrompt: while (true) {
		const key = (
			await interaction.prompt({
				type: "secret",
				message: "Agent Plan API Key",
				placeholder: "输入后将安全保存到 Pi auth.json",
			})
		).trim();
		if (!key) throw new Error("Agent Plan API Key 不能为空");

		while (true) {
			interaction.notify({ type: "progress", message: "正在验证 Agent Plan API Key…" });
			const result = await validateAgentPlanKey(key, {
				fetchImpl,
				signal: interaction.signal,
			});
			if (result.status === "valid") {
				interaction.notify({ type: "info", message: "Agent Plan API Key 验证通过。" });
				return key;
			}
			if (result.status === "invalid") {
				interaction.notify({
					type: "info",
					message: "API Key 无效或无权访问 Agent Plan，请重新输入。",
				});
				continue keyPrompt;
			}

			const action = await interaction.prompt({
				type: "select",
				message: `暂时无法验证 API Key：${result.reason}`,
				options: [
					{ id: "retry", label: "重试", description: "再次连接 Agent Plan 验证" },
					{ id: "save", label: "仍然保存", description: "跳过验证并在首次请求时确认" },
				],
			});
			if (action === "retry") continue;
			return key;
		}
	}
}

function parsePlanTier(value: unknown): PlanTier | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim().toLowerCase();
	return normalized === "small" || normalized === "medium" || normalized === "large" || normalized === "max"
		? normalized
		: undefined;
}

function processPlanTier(): PlanTier {
	return parsePlanTier(process.env[TIER_ENV]) ?? "medium";
}

function credentialPlanTier(credential: Credential | undefined): PlanTier {
	if (credential?.type === "api_key") {
		const stored = parsePlanTier(credential.env?.[TIER_ENV]);
		if (stored) return stored;
	}
	return processPlanTier();
}

interface ResolvedKey {
	key: string;
	source: string;
}

async function resolveKey(ctx: AuthContext, credential?: ApiKeyCredential): Promise<ResolvedKey | undefined> {
	const stored = credential?.key?.trim();
	if (stored) return { key: stored, source: "Pi auth.json" };

	for (const variable of KEY_ENV_NAMES) {
		const value = (await ctx.env(variable))?.trim();
		if (value) return { key: value, source: variable };
	}

	return undefined;
}

async function resolveTier(ctx: AuthContext, credential?: ApiKeyCredential): Promise<PlanTier> {
	return (
		parsePlanTier(credential?.env?.[TIER_ENV]) ??
		parsePlanTier(await ctx.env(TIER_ENV)) ??
		"medium"
	);
}

function filterModelsByTier(models: readonly Model<ArkApi>[], tier: PlanTier): readonly Model<ArkApi>[] {
	return models.filter((model) => {
		const minimum = MINIMUM_TIER.get(model.id) ?? "small";
		return TIER_RANK[tier] >= TIER_RANK[minimum];
	});
}

export interface AgentPlanProviderOptions {
	fetchImpl?: typeof fetch;
}

export function createAgentPlanProvider(options: AgentPlanProviderOptions = {}) {
	return createProvider<ArkApi>({
		id: PROVIDER_ID,
		name: "Volcengine Ark Agent Plan",
		baseUrl: BASE_URL,
		auth: {
			apiKey: {
				name: "Ark Agent Plan API key",
				async login(interaction) {
					interaction.notify({
						type: "info",
						message: "请使用 Agent Plan 专属 API Key；普通方舟 API Key 不适用于该端点。",
					});
					const key = await promptValidatedAgentPlanKey(
						interaction,
						options.fetchImpl ?? fetch,
					);

					const tier = parsePlanTier(
						await interaction.prompt({
							type: "select",
							message: "选择 Agent Plan 订阅级别",
							options: [
								{ id: "small", label: "Small", description: "隐藏 Medium 起可用的 Kimi K3" },
								{ id: "medium", label: "Medium", description: "当前套餐；显示全部文本模型" },
								{ id: "large", label: "Large", description: "显示全部文本模型" },
								{ id: "max", label: "Max", description: "显示全部文本模型" },
							],
						}),
					);
					if (!tier) throw new Error("无效的 Agent Plan 订阅级别");

					interaction.notify({
						type: "progress",
						message: "正在保存凭证并刷新 provider 状态，请稍候…",
					});
					return {
						type: "api_key",
						key,
						env: { [TIER_ENV]: tier },
					};
				},
				async check({ ctx, credential }) {
					const resolved = await resolveKey(ctx, credential);
					return resolved ? { type: "api_key", source: resolved.source } : undefined;
				},
				async resolve({ ctx, credential }) {
					const resolved = await resolveKey(ctx, credential);
					if (!resolved) return undefined;
					const tier = await resolveTier(ctx, credential);
					return {
						auth: { apiKey: resolved.key },
						env: { [TIER_ENV]: tier },
						source: resolved.source,
					};
				},
		},
		},
		models: MODELS,
		filterModels(models, credential) {
			return filterModelsByTier(models, credentialPlanTier(credential));
		},
		api: {
			"openai-responses": openAIResponsesApi(),
			"openai-completions": openAICompletionsApi(),
		},
	});
}

export default function volcengineAgentPlan(pi: ExtensionAPI) {
	pi.registerProvider(createAgentPlanProvider());

	pi.on("before_provider_request", (event, ctx) => {
		if (ctx.model?.provider !== PROVIDER_ID || !isRecord(event.payload)) return;
		const payload = { ...event.payload };

		if (ctx.model.id === "minimax-m2.7") {
			// The model emits standard Responses reasoning events but rejects the OpenAI
			// `reasoning` request object. Keep reasoning enabled on the model card so Pi
			// can render returned thinking blocks, while removing unsupported controls.
			delete payload.reasoning;
			if (Array.isArray(payload.include)) {
				const include = payload.include.filter(
					(item) => item !== "reasoning.encrypted_content",
				);
				if (include.length > 0) payload.include = include;
				else delete payload.include;
			}
			payload.thinking = {
				type: pi.getThinkingLevel() === "off" ? "disabled" : "enabled",
			};
		}

		if (ctx.model.id === "kimi-k2.6") {
			// `reasoning_effort: minimal` alone does not disable thinking through the
			// Agent Plan gateway; this provider field is required for a real off state.
			payload.thinking = {
				type: pi.getThinkingLevel() === "off" ? "disabled" : "enabled",
			};
		}

		return payload;
	});
}
