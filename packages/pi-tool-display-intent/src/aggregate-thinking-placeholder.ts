import {
	AssistantMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { onReloadShutdown } from "./extension-lifecycle.js";

interface PatchableAssistantMessage {
	render(width: number): string[];
	hideThinkingBlock?: unknown;
	lastMessage?: unknown;
}

interface PatchableAssistantPrototype {
	render(width: number): string[];
	[AGGREGATE_THINKING_PATCH_KEY]?: AggregateThinkingPatchState;
}

interface AggregateThinkingPatchState {
	originalRender: (this: PatchableAssistantMessage, width: number) => string[];
	patchedRender: (this: PatchableAssistantMessage, width: number) => string[];
	isAggregateEnabled: () => boolean;
}

const AGGREGATE_THINKING_PATCH_KEY = Symbol.for(
	"pi-tool-display-intent.aggregate-thinking-placeholder.v1",
);
const registeredApis = new WeakSet<ExtensionAPI>();

function toRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

export function isPureHiddenThinkingMessage(component: unknown): boolean {
	const instance = toRecord(component);
	if (instance.hideThinkingBlock !== true) return false;
	const message = toRecord(instance.lastMessage);
	const content = message.content;
	if (!Array.isArray(content)) return false;

	let hasThinking = false;
	let hasToolCall = false;
	for (const blockValue of content) {
		const block = toRecord(blockValue);
		if (block.type === "thinking") {
			if (typeof block.thinking === "string" && block.thinking.trim()) hasThinking = true;
			continue;
		}
		if (block.type === "toolCall") {
			hasToolCall = true;
			continue;
		}
		if (block.type === "text" && (typeof block.text !== "string" || !block.text.trim())) {
			continue;
		}
		return false;
	}

	if (!hasThinking) return false;
	if (message.stopReason === "length") return false;
	if ((message.stopReason === "error" || message.stopReason === "aborted") && !hasToolCall) {
		return false;
	}
	return true;
}

function getPrototype(): PatchableAssistantPrototype {
	return AssistantMessageComponent.prototype as unknown as PatchableAssistantPrototype;
}

export function patchAggregateThinkingPlaceholders(isAggregateEnabled: () => boolean): void {
	const prototype = getPrototype();
	const existing = prototype[AGGREGATE_THINKING_PATCH_KEY];
	if (existing) {
		existing.isAggregateEnabled = isAggregateEnabled;
		// Another extension may deliberately wrap our renderer. Keep that outer
		// wrapper in place instead of reapplying and creating a recursive chain.
		return;
	}

	const state = {} as AggregateThinkingPatchState;
	state.originalRender = prototype.render as AggregateThinkingPatchState["originalRender"];
	state.isAggregateEnabled = isAggregateEnabled;
	state.patchedRender = function renderWithoutAggregateThinkingPlaceholder(width: number): string[] {
		if (state.isAggregateEnabled() && isPureHiddenThinkingMessage(this)) return [];
		return state.originalRender.call(this, width);
	};
	Object.defineProperty(prototype, AGGREGATE_THINKING_PATCH_KEY, {
		configurable: true,
		value: state,
	});
	prototype.render = state.patchedRender;
}

export function restoreAggregateThinkingPlaceholders(): void {
	const prototype = getPrototype();
	const state = prototype[AGGREGATE_THINKING_PATCH_KEY];
	if (!state) return;
	if (prototype.render === state.patchedRender) {
		prototype.render = state.originalRender;
		delete prototype[AGGREGATE_THINKING_PATCH_KEY];
		return;
	}
	// A later wrapper still references patchedRender. Disable our behavior but
	// retain the state so a subsequent reload can safely update its predicate.
	state.isAggregateEnabled = () => false;
}

export function registerAggregateThinkingPlaceholderSuppression(
	pi: ExtensionAPI,
	isAggregateEnabled: () => boolean,
): void {
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);
	patchAggregateThinkingPlaceholders(isAggregateEnabled);

	onReloadShutdown(pi, () => {
		restoreAggregateThinkingPlaceholders();
		registeredApis.delete(pi);
	});
	pi.on("session_start", async () => patchAggregateThinkingPlaceholders(isAggregateEnabled));
	pi.on("before_agent_start", async () => patchAggregateThinkingPlaceholders(isAggregateEnabled));
}
