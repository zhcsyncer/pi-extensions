/**
 * Pi 1.1's extension loader maps pi-ai subpaths onto compat.js, so neither
 * api/simple-options nor utils/estimate is loadable here. Keep only the budget
 * recipe locally; tests compare it with the installed SDK and real loader.
 * Sampling defaults belong to the official Responses adapter, not request
 * overrides. Spread options so provider hooks and future fields survive.
 */
import {
	getSystemMessageText,
	type Api,
	type Context,
	type Message,
	type Model,
	type SimpleStreamOptions,
	type StreamOptions,
	type Usage,
} from "@earendil-works/pi-ai/compat";

const CONTEXT_SAFETY_TOKENS = 4096;
const MIN_MAX_TOKENS = 1;
const CHARS_PER_TOKEN = 3.5;
const ESTIMATED_IMAGE_CHARS = 4800;

function calculateContextTokens(usage: Usage): number {
	return usage.totalTokens || usage.input + usage.output + usage.cacheRead + usage.cacheWrite;
}

function safeJsonStringify(value: unknown): string {
	try {
		return JSON.stringify(value) ?? "undefined";
	} catch {
		return "[unserializable]";
	}
}

function estimateToolsTokens(tools: unknown[] | undefined): number {
	return tools?.length ? Math.ceil(safeJsonStringify(tools).length / CHARS_PER_TOKEN) : 0;
}

function estimateMessageTokens(message: Message): number {
	if (message.role === "system") {
		return Math.ceil(getSystemMessageText(message).length / CHARS_PER_TOKEN)
			+ estimateToolsTokens(message.toolsAdded)
			+ estimateToolsTokens(message.toolsRemoved);
	}
	if (message.role === "user" || message.role === "toolResult") {
		const chars = typeof message.content === "string"
			? message.content.length
			: message.content.reduce((sum, block) => sum + (block.type === "text" ? block.text.length : ESTIMATED_IMAGE_CHARS), 0);
		return Math.ceil(chars / CHARS_PER_TOKEN);
	}
	let chars = 0;
	for (const block of message.content) {
		if (block.type === "text") chars += block.text.length;
		else if (block.type === "thinking") chars += block.thinking.length;
		else chars += block.name.length + safeJsonStringify(block.arguments).length;
	}
	return Math.ceil(chars / CHARS_PER_TOKEN);
}

export function estimateContextTokens(context: Context): number {
	let latestPrefixTimestamp = Number.NEGATIVE_INFINITY;
	let tokens = 0;
	let lastUsageIndex = -1;
	for (const [index, message] of context.messages.entries()) {
		// Only a successful, non-stale usage receipt describes the whole prefix.
		if (
			message.role === "assistant" &&
			message.timestamp >= latestPrefixTimestamp &&
			message.stopReason !== "aborted" &&
			message.stopReason !== "error" &&
			calculateContextTokens(message.usage) > 0
		) {
			tokens = calculateContextTokens(message.usage);
			lastUsageIndex = index;
		}
		latestPrefixTimestamp = Math.max(latestPrefixTimestamp, message.timestamp);
	}
	for (let i = lastUsageIndex + 1; i < context.messages.length; i++) {
		tokens += estimateMessageTokens(context.messages[i]!);
	}
	return tokens;
}

export function clampMaxTokensToContext(model: Model<Api>, context: Context, maxTokens: number): number {
	if (model.contextWindow <= 0) return Math.max(MIN_MAX_TOKENS, maxTokens);
	const available = model.contextWindow - estimateContextTokens(context) - CONTEXT_SAFETY_TOKENS;
	return Math.min(maxTokens, Math.max(MIN_MAX_TOKENS, available));
}

export function buildBaseOptions(
	model: Model<Api>,
	context: Context,
	options?: SimpleStreamOptions,
	apiKey?: string,
): StreamOptions {
	return {
		...options,
		maxTokens: clampMaxTokensToContext(model, context, options?.maxTokens ?? model.maxTokens),
		apiKey: apiKey || options?.apiKey,
	};
}
