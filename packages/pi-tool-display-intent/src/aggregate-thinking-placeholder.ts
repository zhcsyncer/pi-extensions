import {
	AssistantMessageComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import {
	AGGREGATE_ASSISTANT_MARK,
	aggregateAssistantFrameId,
	applyAggregateGroupFrame,
	getActiveAggregateProjection,
	attachExpandedAggregateSummary,
	renderAggregateActivity,
	resolveAggregateRenderTheme,
} from "./aggregate-activity.js";
import { onReloadShutdown } from "./extension-lifecycle.js";

interface PatchableAssistantMessage {
	render(width: number): string[];
	setExpanded?(expanded: boolean): void;
	invalidate?: () => void;
	hideThinkingBlock?: unknown;
	hiddenThinkingLabel?: unknown;
	lastMessage?: unknown;
	[AGGREGATE_ASSISTANT_EXPANDED_KEY]?: boolean;
	[AGGREGATE_ASSISTANT_FRAME_ID_KEY]?: string;
}

interface PatchableAssistantPrototype {
	render(width: number): string[];
	setExpanded?(expanded: boolean): void;
	[AGGREGATE_THINKING_PATCH_KEY]?: AggregateThinkingPatchState;
}

interface AggregateThinkingPatchState {
	originalRender: (this: PatchableAssistantMessage, width: number) => string[];
	patchedRender: (this: PatchableAssistantMessage, width: number) => string[];
	originalSetExpanded?: (this: PatchableAssistantMessage, expanded: boolean) => void;
	patchedSetExpanded: (this: PatchableAssistantMessage, expanded: boolean) => void;
	isAggregateEnabled: () => boolean;
}

const AGGREGATE_THINKING_PATCH_KEY = Symbol.for(
	"pi-tool-display-intent.aggregate-thinking-placeholder.v1",
);
const AGGREGATE_ASSISTANT_EXPANDED_KEY = Symbol.for(
	"pi-tool-display-intent.aggregate-assistant-expanded.v1",
);
const AGGREGATE_ASSISTANT_FRAME_ID_KEY = Symbol.for(
	"pi-tool-display-intent.aggregate-assistant-frame-id.v1",
);
const DEFAULT_HIDDEN_THINKING_LABEL = "Thinking...";
const OSC_SEQUENCE_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_SEQUENCE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;
const registeredApis = new WeakSet<ExtensionAPI>();

function toRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function visibleText(line: string): string {
	return line
		.replace(OSC_SEQUENCE_PATTERN, "")
		.replace(ANSI_SEQUENCE_PATTERN, "")
		.replace(/\s+/g, " ")
		.trim();
}

function resolveHiddenThinkingLabel(component: unknown): string {
	const label = toRecord(component).hiddenThinkingLabel;
	if (typeof label !== "string") return DEFAULT_HIDDEN_THINKING_LABEL;
	const normalized = label.replace(/\s+/g, " ").trim();
	return normalized || DEFAULT_HIDDEN_THINKING_LABEL;
}

export function stripCollapsedThinkingPlaceholderLines(
	lines: readonly string[],
	label = DEFAULT_HIDDEN_THINKING_LABEL,
): string[] {
	const normalizedLabel = label.replace(/\s+/g, " ").trim() || DEFAULT_HIDDEN_THINKING_LABEL;
	const kept = lines.filter((line) => visibleText(line) !== normalizedLabel);
	return trimBlankEdges(kept);
}

export function trimBlankEdges(lines: readonly string[]): string[] {
	const kept = [...lines];
	while (kept.length > 0 && visibleText(kept[0]!) === "") kept.shift();
	while (kept.length > 0 && visibleText(kept[kept.length - 1]!) === "") kept.pop();
	return kept;
}

export function shouldHideCollapsedThinkingPlaceholder(component: unknown): boolean {
	const instance = toRecord(component);
	if (instance.hideThinkingBlock !== true) return false;
	const message = toRecord(instance.lastMessage);
	const content = message.content;
	if (!Array.isArray(content)) return false;

	return content.some((blockValue) => {
		const block = toRecord(blockValue);
		return block.type === "thinking" && typeof block.thinking === "string" && Boolean(block.thinking.trim());
	});
}

export function isInterimAssistantNarration(component: unknown): boolean {
	const message = toRecord(toRecord(component).lastMessage);
	const stopReason = message.stopReason;
	if (stopReason === "error" || stopReason === "aborted" || stopReason === "length" || stopReason === "stop") {
		return false;
	}
	if (stopReason === "toolUse") return true;
	const content = message.content;
	if (!Array.isArray(content)) return false;
	return content.some((blockValue) => {
		const block = toRecord(blockValue);
		return block.type === "toolCall" || (block.type === "thinking" && typeof block.thinking === "string" && Boolean(block.thinking.trim()));
	});
}

/** @deprecated Use shouldHideCollapsedThinkingPlaceholder. */
export function isPureHiddenThinkingMessage(component: unknown): boolean {
	return shouldHideCollapsedThinkingPlaceholder(component);
}

function isExpanded(component: PatchableAssistantMessage): boolean {
	return component[AGGREGATE_ASSISTANT_EXPANDED_KEY] === true;
}

function assistantFrameId(component: PatchableAssistantMessage): string {
	const existing = component[AGGREGATE_ASSISTANT_FRAME_ID_KEY];
	if (existing) return existing;
	const id = aggregateAssistantFrameId(component.lastMessage) ?? `assistant:${++assistantFrameSequence}`;
	component[AGGREGATE_ASSISTANT_FRAME_ID_KEY] = id;
	return id;
}

let assistantFrameSequence = 0;

function firstToolCallId(message: unknown): string | undefined {
	const content = toRecord(message).content;
	if (!Array.isArray(content)) return undefined;
	for (const entry of content) {
		const block = toRecord(entry);
		if (block.type === "toolCall" && typeof block.id === "string" && block.id.trim()) return block.id;
	}
	return undefined;
}

function decorateAssistantLines(
	lines: readonly string[],
	theme: { fg(color: string, text: string): string },
): string[] {
	const firstVisible = lines.findIndex((line) => visibleText(line) !== "");
	if (firstVisible < 0) return [...lines];
	let mark = AGGREGATE_ASSISTANT_MARK;
	try {
		mark = theme.fg("muted", AGGREGATE_ASSISTANT_MARK);
	} catch {
		// Public markdown fallbacks and unbound Pi theme helpers must not crash render.
	}
	return lines.map((line, index) => index === firstVisible ? `${mark} ${line}` : line);
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
	state.originalSetExpanded = typeof prototype.setExpanded === "function"
		? prototype.setExpanded
		: undefined;
	state.isAggregateEnabled = isAggregateEnabled;
	state.patchedSetExpanded = function setAggregateAssistantExpanded(expanded: boolean): void {
		this[AGGREGATE_ASSISTANT_EXPANDED_KEY] = expanded === true;
		state.originalSetExpanded?.call(this, expanded);
		try {
			this.invalidate?.();
		} catch {
			// A stale transcript component may already be disposed.
		}
	};
	state.patchedRender = function renderAggregateAssistantMessage(width: number): string[] {
		const lines = state.originalRender.call(this, width);
		if (!state.isAggregateEnabled()) return lines;

		let next = lines;
		if (this.hideThinkingBlock === true && shouldHideCollapsedThinkingPlaceholder(this)) {
			next = stripCollapsedThinkingPlaceholderLines(next, resolveHiddenThinkingLabel(this));
		}
		const interim = isInterimAssistantNarration(this);
		const projection = getActiveAggregateProjection();
		const trimmed = trimBlankEdges(next);
		if (interim) {
			const frameId = assistantFrameId(this);
			if (trimmed.length === 0 || !isExpanded(this)) {
				projection?.markFrameContentVisible(frameId, false);
				if (trimmed.length === 0) projection?.untrackFramedItem(frameId);
				else projection?.trackFramedItem(frameId, undefined, firstToolCallId(this.lastMessage));
				return [];
			}
			projection?.trackFramedItem(frameId, undefined, firstToolCallId(this.lastMessage));
			projection?.connectFrameRenderer(frameId, () => {
				try {
					this.invalidate?.();
				} catch {
					// A stale transcript component may already be disposed.
				}
			});
			projection?.markFrameContentVisible(frameId, true);
		}
		if (trimmed.length === 0) return [];
		if (!interim) {
			// Pi prefixes visible assistant text with Spacer(1). Drop that so it
			// does not stack with the Tools ledger's trailing blank.
			return visibleText(next[0] ?? "") === "" ? next.slice(1) : next;
		}
		const theme = resolveAggregateRenderTheme();
		const marked = decorateAssistantLines(trimmed, theme);
		const frameId = assistantFrameId(this);
		const edge = projection?.getFrameEdge(frameId) ?? "only";
		const framed = applyAggregateGroupFrame(marked, width, theme, edge);
		if (projection?.shouldHostExpandedSummary(frameId)) {
			const headerView = projection.getViewForGroup(frameId);
			if (headerView) {
				return attachExpandedAggregateSummary(
					renderAggregateActivity(headerView, width, theme),
					framed,
				);
			}
		}
		return framed;
	};
	Object.defineProperty(prototype, AGGREGATE_THINKING_PATCH_KEY, {
		configurable: true,
		value: state,
	});
	prototype.render = state.patchedRender;
	prototype.setExpanded = state.patchedSetExpanded;
}

export function restoreAggregateThinkingPlaceholders(): void {
	const prototype = getPrototype();
	const state = prototype[AGGREGATE_THINKING_PATCH_KEY];
	if (!state) return;
	if (prototype.render === state.patchedRender) {
		prototype.render = state.originalRender;
		if (prototype.setExpanded === state.patchedSetExpanded) {
			if (state.originalSetExpanded) prototype.setExpanded = state.originalSetExpanded;
			else delete prototype.setExpanded;
		}
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
