import {
	formatSize,
	getMarkdownTheme,
	sessionEntryToContextMessages,
	ToolExecutionComponent,
	type ExtensionAPI,
	type ExtensionContext,
} from "@earendil-works/pi-coding-agent";
import { Markdown, truncateToWidth, visibleWidth, wrapTextWithAnsi } from "@earendil-works/pi-tui";
import { formatAggregateArgumentPreview } from "./aggregate-argument-preview.js";
import { agentReceiptChrome, formatAggregateAgentTarget, readAgentCallReceipt, type AgentCallReceipt } from "./aggregate-agent-call.js";
import { ContextGrowthLedger, formatContextGrowth, type ContextGrowth } from "./context-growth.js";
import { patchAggregateMouseHandling, recordAggregateClickRegions, recordAggregateNativeRegion, releaseAggregateClickRegions, restoreAggregateMouseHandling, type AggregateClickRegion } from "./aggregate-interaction.js";
import { layoutSteerPreview } from "./steer-preview.js";
import { patchAggregateGlobalExpansion, restoreAggregateGlobalExpansion } from "./aggregate-expansion.js";
import { patchAggregateViewport, restoreAggregateViewport, resetAggregateViewportOwner, toggleAggregateViewportRun, type AggregateViewportRun } from "./aggregate-viewport.js";
import { patchAggregateCustomMessages, restoreAggregateCustomMessages, bindExistingAggregateCustomMessages } from "./aggregate-custom-message.js";
import { createAggregateCollapseWidget } from "./aggregate-collapse-widget.js";
import type { DetailRequest } from "./detail-viewer.js";
import { lookupAggregateCallPresentation } from "./call-presentation-registry.js";
import { getDisplaySummary, normalizeDisplaySummary, stripDisplaySummary } from "./display-summary.js";
import type { ExpandedTimeline, ToolDisplayConfig } from "./types.js";
import { layoutPreviewRows } from "./preview-text.js";
import { pluralize, shortenPath } from "./render-utils.js";

export type AggregateMemberState =
	| "pending"
	| "running"
	| "success"
	| "failed"
	| "needsAttention";

export interface AggregateMember {
	toolCallId: string;
	toolName: string;
	groupId: string;
	sourceOrder: number;
	args: Record<string, unknown>;
	state: AggregateMemberState;
	errorSummary?: string;
	visible: boolean;
	retainedDone?: boolean;
	completionOrder?: number;
	startedAtMs?: number;
	endedAtMs?: number;
	agentTurnId?: string;
	/** Immutable interpretation of the Agent tool receipt, not live task progress. */
	agentReceipt?: AgentCallReceipt;
}

export interface AggregateUsageTotals {
	input: number;
	output: number;
	cacheRead: number;
	cacheWrite: number;
}

export interface AggregateSteer {
	id: string;
	text: string;
	firstLine: string;
}

export interface AggregateGroup {
	groupId: string;
	leaderToolCallId?: string;
	members: AggregateMember[];
	framedItemIds: string[];
	customItemIds: string[];
	expansionKey?: string;
	narrationById: Map<string, string>;
	agentTurnIds: string[];
	usageByKey: Map<string, AggregateUsageTotals>;
	steers: AggregateSteer[];
	hasSeenToolBatch: boolean;
	settled: boolean;
	startedAtMs?: number;
	endedAtMs?: number;
}

export type AggregateFrameEdge = "start" | "continue" | "end" | "only";

export interface ExpandedTurnPresentation {
	indent: boolean;
	leadingBlank?: boolean;
	header?: string;
}

export interface AggregateToolSummary {
	toolName: string;
	count: number;
	lastTarget: string;
}

export interface AggregateActivityView {
	groupId: string;
	leaderToolCallId: string;
	hasRunning: boolean;
	latestNarration?: string;
	callCount: number;
	customMessageCount?: number;
	agentTurnCount: number;
	settled: boolean;
	durationMs?: number;
	completedAtMs?: number;
	usage?: AggregateUsageTotals;
	contextGrowth?: ContextGrowth;
	active: AggregateMember[];
	displayRows: AggregateMember[];
	activeOverflow: number;
	failed: AggregateMember[];
	failedCount: number;
	steerCount: number;
	pinnedSteers: Array<{ id: string; firstLine: string }>;
	toolSummaries: AggregateToolSummary[];
}

export interface AggregateRenderTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

interface ToolCallRecord {
	id: string;
	name: string;
	args: Record<string, unknown>;
}

interface SessionContextLike {
	hasUI?: boolean;
	sessionManager?: {
		getBranch(): unknown[];
		buildContextEntries?(): unknown[];
		buildSessionContext?(): { messages?: unknown[] };
	};
}

interface PatchableToolExecution {
	toolName?: unknown;
	toolCallId?: unknown;
	args?: unknown;
	expanded?: unknown;
	result?: unknown;
	ui?: { requestRender?: () => void };
	invalidate?: () => void;
}

interface PatchableToolExecutionPrototype {
	render(width: number): string[];
	markExecutionStarted?(): void;
	setExpanded?(expanded: boolean): void;
	updateResult?(result: { isError?: boolean } & Record<string, unknown>, isPartial?: boolean): void;
	[AGGREGATE_TOOL_EXECUTION_PATCH_KEY]?: AggregateToolExecutionPatchState;
	[LEGACY_TOOL_EXECUTION_PATCH_KEY]?: AggregateToolExecutionPatchState;
}

interface AggregateToolExecutionPatchState {
	owner: typeof TOOL_MODULE;
	releaseOwner(): void;
	renderImpl: (this: PatchableToolExecution, width: number) => string[];
	onExpanded?: (this: PatchableToolExecution, expanded: boolean) => void;
	onStarted?: (this: PatchableToolExecution) => void;
	onEnded?: (this: PatchableToolExecution, result: { isError?: boolean } & Record<string, unknown>) => void;
	originalRender: (this: PatchableToolExecution, width: number) => string[];
	patchedRender: (this: PatchableToolExecution, width: number) => string[];
	originalSetExpanded?: (this: PatchableToolExecution, expanded: boolean) => void;
	patchedSetExpanded?: (this: PatchableToolExecution, expanded: boolean) => void;
	originalMarkExecutionStarted?: (this: PatchableToolExecution) => void;
	patchedMarkExecutionStarted?: (this: PatchableToolExecution) => void;
	originalUpdateResult?: (this: PatchableToolExecution, result: { isError?: boolean } & Record<string, unknown>, isPartial?: boolean) => void;
	patchedUpdateResult?: (this: PatchableToolExecution, result: { isError?: boolean } & Record<string, unknown>, isPartial?: boolean) => void;
	projection?: AggregateProjection;
}

const FAILED_SUMMARY_MAX_LENGTH = 200;
const ACTIVE_ROW_LIMIT = 3;
const AGGREGATE_FRAME_CONTINUE = "  │ ";
const AGGREGATE_FRAME_END = "  └ ";
export const AGGREGATE_ASSISTANT_MARK = "›";
export const AGGREGATE_STEER_MARK = "↳";
const COLLAPSED_NARRATION_ROW_LIMIT = 3;
const COLLAPSED_NARRATION_SOURCE_MAX_LENGTH = 2_000;
const COLLAPSED_CALL_ROW_LIMIT = 2;
const EXPANDED_CALL_ROW_LIMIT = 8;
const FAILED_DETAIL_ROW_LIMIT = 2;
const OSC_SEQUENCE_PATTERN = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g;
const ANSI_SEQUENCE_PATTERN = /\x1b\[[0-9;]*[a-zA-Z]/g;
const NARRATION_CONTROL_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f]/g;
export const AGGREGATE_DONE_SETTLE_DELAY_MS = 1_500;
export const DEFAULT_AGGREGATE_RENDER_PASSTHROUGH: readonly string[] = [];

const AGGREGATE_TOOL_EXECUTION_PATCH_KEY = Symbol.for(
	"pi-tool-display-intent.aggregate-tool-execution.v2",
);
const LEGACY_TOOL_EXECUTION_PATCH_KEY = Symbol.for("pi-tool-display-intent.aggregate-tool-execution.v1");
const TOOL_MODULE = { retired: false };
const registeredApis = new WeakSet<ExtensionAPI>();
const TOOL_COLOR_PALETTE = [
	"mdLink",
	"syntaxString",
	"syntaxFunction",
	"accent",
	"bashMode",
	"customMessageLabel",
	"syntaxType",
] as const;
const PLAIN_THEME: AggregateRenderTheme = {
	fg: (_color, text) => text,
	bold: (text) => text,
};

function publicThemeFallback(): AggregateRenderTheme {
	try {
		const markdown = getMarkdownTheme();
		const palette = [
			markdown.link,
			markdown.code,
			markdown.heading,
			markdown.codeBlock,
			markdown.listBullet,
		];
		return {
			fg(color, text) {
				if (color === "muted" || color === "dim") return markdown.quote(text);
				if (color === "success") return markdown.codeBlock(text);
				if (color === "warning" || color === "error" || color === "accent") return markdown.heading(text);
				if (color === "toolTitle") return markdown.code(text);
				let hash = 0;
				for (const character of color) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
				return palette[hash % palette.length]!(text);
			},
			bold: markdown.bold,
		};
	} catch {
		return PLAIN_THEME;
	}
}

function toRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? value as Record<string, unknown>
		: {};
}

function normalizeToolName(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized || undefined;
}

function textContent(result: unknown): string {
	const content = toRecord(result).content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((entry) => toRecord(entry).type === "text")
		.map((entry) => String(toRecord(entry).text ?? ""))
		.join("\n");
}

function firstMeaningfulLine(value: unknown, fallback: string): string {
	for (const line of textContent(value).replace(/\r/g, "").split("\n")) {
		const normalized = normalizeDisplaySummary(line, FAILED_SUMMARY_MAX_LENGTH);
		if (normalized) return normalized;
	}
	return fallback;
}

function getPath(args: unknown): string | undefined {
	const record = toRecord(args);
	const value = record.path ?? record.file_path;
	return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeTargetText(value: unknown, fallback: string): string {
	return normalizeDisplaySummary(value, 400) ?? fallback;
}

function formatAggregatePath(args: unknown): string {
	return normalizeTargetText(shortenPath(getPath(args) ?? "."), ".");
}

function stringArg(args: Record<string, unknown>, key: string): string | undefined {
	const value = args[key];
	if (typeof value !== "string") return undefined;
	const trimmed = value.trim();
	return trimmed || undefined;
}

function formatMcpAggregateTarget(args: Record<string, unknown>): string {
	const tool = stringArg(args, "tool");
	const connect = stringArg(args, "connect");
	const describe = stringArg(args, "describe");
	const search = stringArg(args, "search");
	const server = stringArg(args, "server");
	if (tool) return server ? `call ${server}:${tool}` : `call ${tool}`;
	if (connect) return `connect ${connect}`;
	if (describe) return server ? `describe ${describe} @${server}` : `describe ${describe}`;
	if (search) return server ? `search "${search}" @${server}` : `search "${search}"`;
	if (server) return `tools ${server}`;
	return "status";
}

function formatCustomAggregateTarget(toolName: string, args: unknown): string {
	const presentation = lookupAggregateCallPresentation(toolName, args);
	if (presentation?.target) {
		const suffix = presentation.metadata?.[0];
		const inner = suffix ? `${presentation.target} · ${suffix}` : presentation.target;
		return `${toolName}(${inner})`;
	}
	if (toolName === "Agent") return formatAggregateAgentTarget(args);
	if (toolName === "mcp") return `mcp(${formatMcpAggregateTarget(toRecord(stripDisplaySummary(args)))})`;
	const preview = formatAggregateArgumentPreview(args);
	return preview ? `${toolName}(${preview})` : toolName;
}

function bashCommandSource(args: Record<string, unknown>): string {
	return typeof args.command === "string" ? args.command.replace(/\r\n?/g, "\n") : "";
}

export function formatAggregateTarget(
	member: Pick<AggregateMember, "toolName" | "args">,
): string {
	const args = member.args;
	const path = formatAggregatePath(args);
	switch (member.toolName) {
		case "read":
			return `Read(${path})`;
		case "grep": {
			const pattern = normalizeTargetText(args.pattern, "pattern");
			return `Search(/${pattern}/ in ${path})`;
		}
		case "find":
			return `Find(${normalizeTargetText(args.pattern, "pattern")} in ${path})`;
		case "ls":
			return `List(${path})`;
		case "bash": {
			const command = bashCommandSource(args);
			if (command.includes("\n")) return "Bash";
			return `Bash(${normalizeTargetText(command, "command")})`;
		}
		case "edit":
			return `Edit(${path})`;
		case "write":
			return `Write(${path})`;
		default:
			return formatCustomAggregateTarget(member.toolName, args);
	}
}

function toolColor(toolName: string): string {
	let hash = 0;
	for (const character of toolName) hash = (hash * 31 + character.codePointAt(0)!) >>> 0;
	return TOOL_COLOR_PALETTE[hash % TOOL_COLOR_PALETTE.length]!;
}

function formatColoredTarget(
	member: Pick<AggregateMember, "toolName" | "args">,
	theme: AggregateRenderTheme,
): string {
	return theme.fg(toolColor(member.toolName), formatAggregateTarget(member));
}

function bashSizeText(command: string): string | undefined {
	if (!command.trim()) return undefined;
	const lineCount = command.split("\n").length;
	const size = formatSize(Buffer.byteLength(command, "utf8"));
	return lineCount > 1 ? `${lineCount} lines · ${size}` : size;
}

function bashIntentText(args: Record<string, unknown>): string | undefined {
	return getDisplaySummary(args);
}

function renderBashLedgerLabel(
	args: Record<string, unknown>,
	theme: AggregateRenderTheme,
	labelWidth: number,
	maxRows: number,
): string {
	const command = bashCommandSource(args);
	const intent = bashIntentText(args);
	const intentPart = intent
		? `${theme.fg("muted", " — ")}${theme.fg("accent", intent)}`
		: "";
	// The audit target is bounded independently of the viewport. Never use its
	// potentially clipped command in the visible ledger, even on wide screens.
	const target = `Bash(${command.trim() || "command"})`;
	// Avoid measuring enormous single-line commands (or zero-width sequences)
	// grapheme by grapheme on every paint; their source belongs in the inspector.
	if (target.length <= labelWidth * 8 && !/[\u0000-\u001f\u007f-\u009f\u2028\u2029]/.test(command) && visibleWidth(target) <= labelWidth) {
		// A one-row budget may clip intent, but must not sacrifice the closing
		// parenthesis to a truncation mark when the target fits exactly.
		const suffix = maxRows === 1
			? truncateToWidth(intentPart, Math.max(0, labelWidth - visibleWidth(target)), "…")
			: intentPart;
		return `${theme.fg(toolColor("bash"), target)}${suffix}`;
	}
	const size = bashSizeText(command);
	const sizePart = size ? `${theme.fg("muted", " · ")}${theme.fg("muted", size)}` : "";
	return `${theme.fg(toolColor("bash"), "Bash")}${intentPart}${sizePart}`;
}

export function formatAggregateClockHms(ms: number): string {
	const date = new Date(ms);
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");
	return `${hours}:${minutes}:${seconds}`;
}

export function formatAggregateCallDuration(ms: number): string {
	if (ms < 10_000) {
		const tenths = Math.round(Math.max(0, ms) / 100) / 10;
		return Number.isInteger(tenths) ? `${tenths}s` : tenths.toFixed(1) + "s";
	}
	return formatAggregateDuration(ms);
}

function padDurationSlot(duration: string, width = 6): string {
	const extra = width - visibleWidth(duration);
	return extra > 0 ? `${" ".repeat(extra)}${duration}` : duration;
}

export function formatExpandedTurnHeader(
	chrome: {
		index: number;
		total: number;
		callCount: number;
		failedCount: number;
		contextGrowth?: ContextGrowth;
		startedAtMs?: number;
		endedAtMs?: number;
		running: boolean;
	},
	theme: AggregateRenderTheme,
	nowMs = Date.now(),
): string {
	const calls = `${chrome.callCount} ${chrome.callCount === 1 ? "call" : "calls"}`;
	let text = `↻ ${chrome.index}/${chrome.total}${chrome.callCount > 0 ? ` · ${calls}` : ""}`;
	const growth = formatContextGrowth(chrome.contextGrowth);
	if (growth) text += theme.fg("muted", ` · ${growth}`);
	if (chrome.startedAtMs !== undefined) {
		const endedAtMs = chrome.running ? undefined : chrome.endedAtMs;
		const durationMs = Math.max(0, (endedAtMs ?? nowMs) - chrome.startedAtMs);
		text += ` · ${formatAggregateCallDuration(durationMs)}`;
		if (endedAtMs !== undefined) text += `  ${formatAggregateClockHms(endedAtMs)}`;
	}
	if (chrome.failedCount > 0) text += theme.fg("error", ` · ${chrome.failedCount} failed`);
	return text;
}

export function formatMemberTiming(
	member: Pick<AggregateMember, "state" | "startedAtMs" | "endedAtMs">,
	theme: AggregateRenderTheme,
	nowMs = Date.now(),
): string {
	if (member.startedAtMs === undefined) return "";
	const running = member.state === "pending" || member.state === "running";
	const endedAtMs = running ? undefined : member.endedAtMs;
	const durationMs = Math.max(0, (endedAtMs ?? nowMs) - member.startedAtMs);
	const duration = formatAggregateCallDuration(durationMs);
	if (endedAtMs === undefined) return theme.fg("muted", duration);
	return theme.fg("muted", `${padDurationSlot(duration)}  ${formatAggregateClockHms(endedAtMs)}`);
}

export function composeLedgerCallLine(left: string, timing: string, width: number): string {
	const safeWidth = Math.max(0, Math.floor(width));
	if (safeWidth === 0) return "";
	if (!timing) return truncateToWidth(left, safeWidth, "…");
	const rightW = visibleWidth(timing);
	if (rightW + 2 > safeWidth) return truncateToWidth(left, safeWidth, "…");
	const trimmedLeft = truncateToWidth(left, safeWidth - rightW - 2, "…");
	const pad = Math.max(2, safeWidth - visibleWidth(trimmedLeft) - rightW);
	return `${trimmedLeft}${" ".repeat(pad)}${timing}`;
}

function messageRole(value: unknown): string | undefined {
	const role = toRecord(value).role;
	return typeof role === "string" ? role : undefined;
}

function messageContent(value: unknown): unknown[] {
	const content = toRecord(value).content;
	return Array.isArray(content) ? content : [];
}

function toolCallsFromMessage(value: unknown): ToolCallRecord[] {
	return messageContent(value).flatMap((entry) => {
		const content = toRecord(entry);
		const name = normalizeToolName(content.name);
		if (content.type !== "toolCall" || typeof content.id !== "string" || !name) return [];
		return [{ id: content.id, name, args: toRecord(content.arguments) }];
	});
}

function messageHasVisibleText(value: unknown): boolean {
	return firstVisibleAssistantText(value) !== undefined;
}

export function normalizeAssistantNarration(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const sanitized = value
		.replace(OSC_SEQUENCE_PATTERN, "")
		.replace(ANSI_SEQUENCE_PATTERN, "")
		.replace(NARRATION_CONTROL_PATTERN, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n")
		.replace(/[ \t]+\n/g, "\n")
		.replace(/\n{3,}/g, "\n\n")
		.trim();
	if (!sanitized) return undefined;
	return sanitized.length > COLLAPSED_NARRATION_SOURCE_MAX_LENGTH
		? sanitized.slice(0, COLLAPSED_NARRATION_SOURCE_MAX_LENGTH)
		: sanitized;
}

function firstVisibleAssistantText(value: unknown): string | undefined {
	for (const entry of messageContent(value)) {
		const content = toRecord(entry);
		if (content.type !== "text" || typeof content.text !== "string") continue;
		const normalized = normalizeAssistantNarration(content.text);
		if (normalized) return normalized;
	}
	return undefined;
}

function isVisuallyBlank(line: string): boolean {
	return visibleWidth(line) === 0;
}

function trimRenderedEdges(lines: readonly string[]): string[] {
	const kept = [...lines];
	while (kept.length > 0 && isVisuallyBlank(kept[0]!)) kept.shift();
	while (kept.length > 0 && isVisuallyBlank(kept[kept.length - 1]!)) kept.pop();
	return kept;
}

function renderNarrationMarkdownLines(text: string, width: number): string[] {
	try {
		const lines = trimRenderedEdges(new Markdown(text, 0, 0, getMarkdownTheme()).render(width));
		if (lines.length > 0) return lines;
	} catch {
		// Public markdown fallbacks and unbound Pi theme helpers must not crash the ledger.
	}
	const wrapped = wrapTextWithAnsi(text.replace(/\s+/g, " ").trim(), width);
	return wrapped.length > 0 ? wrapped : [text];
}

function colorSteerText(theme: AggregateRenderTheme, text: string): string {
	try {
		return theme.fg("accent", text);
	} catch {
		return text;
	}
}

export function formatAggregateSteerCount(count: number): string {
	return `${count} ${count === 1 ? "steer" : "steers"}`;
}

export function renderCollapsedSteerPins(
	steers: ReadonlyArray<{ firstLine: string }>,
	width: number,
	theme: AggregateRenderTheme,
): string[] {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (safeWidth === 0 || steers.length === 0) return [];
	return steers.map((steer) =>
		truncateToWidth(
			`  ${colorSteerText(theme, `${AGGREGATE_STEER_MARK} ${steer.firstLine}`)}`,
			safeWidth,
			"…",
		),
	);
}

export function renderSettledSteerReminder(
	steerCount: number,
	width: number,
	theme: AggregateRenderTheme,
): string[] {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (safeWidth === 0 || steerCount <= 0) return [];
	return [
		truncateToWidth(
			`  ${colorSteerText(theme, `${AGGREGATE_STEER_MARK} ${formatAggregateSteerCount(steerCount)}`)}`,
			safeWidth,
			"…",
		),
	];
}

export function renderExpandedAggregateSteer(
	text: string,
	width: number,
	theme: AggregateRenderTheme,
	edge: AggregateFrameEdge = "only",
): string[] {
	return renderExpandedAggregateSteerLayout(text, width, theme, edge).lines;
}

export function renderExpandedAggregateSteerLayout(
	text: string,
	width: number,
	theme: AggregateRenderTheme,
	edge: AggregateFrameEdge = "only",
): { lines: string[]; omissionRow?: number } {
	const bodyWidth = Math.max(0, width - visibleWidth(framePrefixForEdge(edge)) - 2);
	const preview = layoutSteerPreview(text, bodyWidth);
	if (preview.rows.length === 0) return { lines: [] };
	const marked = ["", ...preview.rows.map((line, index) => index === 0
		? colorSteerText(theme, `${AGGREGATE_STEER_MARK} ${line}`) : `  ${line}`), ""];
	return {
		lines: applyAggregateGroupFrame(marked, width, theme, edge),
		omissionRow: preview.omissionRow === undefined ? undefined : preview.omissionRow + 1,
	};
}

export function renderCollapsedAssistantNarration(
	text: string,
	width: number,
	theme: AggregateRenderTheme,
): string[] {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (safeWidth === 0 || !text) return [];
	let mark = AGGREGATE_ASSISTANT_MARK;
	try {
		mark = theme.fg("muted", AGGREGATE_ASSISTANT_MARK);
	} catch {
		// Theme helpers must not crash the collapsed ledger.
	}
	const prefix = `  ${mark} `;
	const continuation = "    ";
	const contentWidth = Math.max(1, safeWidth - visibleWidth(prefix));
	const rows = renderNarrationMarkdownLines(text, contentWidth).slice(0, COLLAPSED_NARRATION_ROW_LIMIT);
	return rows.map((row, index) => {
		const linePrefix = index === 0 ? prefix : continuation;
		return truncateToWidth(`${linePrefix}${row}`, safeWidth, "…");
	});
}

function isInterimAssistantMessage(value: unknown): boolean {
	const reason = toRecord(value).stopReason;
	if (reason === "error" || reason === "aborted" || reason === "length" || reason === "stop") return false;
	return reason === "toolUse" || toolCallsFromMessage(value).length > 0;
}

export function aggregateAssistantFrameId(message: unknown): string | undefined {
	const firstToolId = toolCallsFromMessage(message)[0]?.id;
	if (firstToolId) return `assistant-before:${firstToolId}`;
	const record = toRecord(message);
	if (typeof record.id === "string" && record.id.trim()) return `assistant:${record.id}`;
	if (typeof record.timestamp === "number") return `assistant:${record.timestamp}`;
	return undefined;
}

export function aggregateAssistantTurnId(message: unknown): string | undefined {
	const record = toRecord(message);
	if (typeof record.id === "string" && record.id.trim()) return `assistant:${record.id}`;
	if (typeof record.timestamp === "number") return `assistant:${record.timestamp}`;
	return undefined;
}

function collectVisibleToolCallIds(messages: unknown[] | undefined): Set<string> | undefined {
	if (!Array.isArray(messages)) return undefined;
	const ids = new Set<string>();
	for (const message of messages) {
		for (const call of toolCallsFromMessage(message)) ids.add(call.id);
	}
	return ids;
}

function entryMessage(entry: unknown): unknown | undefined {
	const record = toRecord(entry);
	if (record.type === "custom_message") return {
		role: "custom", customType: record.customType, content: record.content,
		display: record.display, details: record.details,
		timestamp: parseTimestampMs(record.timestamp),
	};
	return record.type === "message" ? record.message : undefined;
}

/** Mirror Pi's materialized compaction tail without mutating its persisted entries. */
function materializeAggregateEntries(entries: unknown[]): unknown[] {
	return entries.flatMap((entry) => {
		const source = toRecord(entry);
		if (source.type !== "compaction" || !Array.isArray(source.retainedTail)) return [entry];
		const tail = sessionEntryToContextMessages(source as never).filter((message) => message.role !== "compactionSummary");
		return [entry, ...tail.map((message, index) => ({
			type: "message", id: `retained:${source.id ?? "compaction"}:${index}`, message,
		}))];
	});
}

function entryId(entry: unknown, fallback: string): string {
	const id = toRecord(entry).id;
	return typeof id === "string" ? id : fallback;
}

function isAssistantTerminalFailure(message: unknown): boolean {
	const reason = toRecord(message).stopReason;
	return reason === "aborted" || reason === "error";
}

function isAssistantTerminal(message: unknown): boolean {
	const reason = toRecord(message).stopReason;
	return reason === "stop" || reason === "error" || reason === "aborted" || reason === "length";
}

export function userMessageText(message: unknown): string {
	const content = toRecord(message).content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	return content
		.filter((entry) => toRecord(entry).type === "text")
		.map((entry) => String(toRecord(entry).text ?? ""))
		.join("");
}

export function steerFirstLine(text: string): string {
	const sanitized = text
		.replace(OSC_SEQUENCE_PATTERN, "")
		.replace(ANSI_SEQUENCE_PATTERN, "")
		.replace(NARRATION_CONTROL_PATTERN, "")
		.replace(/\r\n/g, "\n")
		.replace(/\r/g, "\n");
	for (const line of sanitized.split("\n")) {
		const trimmed = line.trim();
		if (trimmed) return trimmed;
	}
	return "";
}

function minDefined(values: Array<number | undefined>): number | undefined {
	let min: number | undefined;
	for (const value of values) {
		if (value === undefined) continue;
		if (min === undefined || value < min) min = value;
	}
	return min;
}

function maxDefined(values: Array<number | undefined>): number | undefined {
	let max: number | undefined;
	for (const value of values) {
		if (value === undefined) continue;
		if (max === undefined || value > max) max = value;
	}
	return max;
}

function parseTimestampMs(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) return value;
	if (typeof value === "string" && value.trim()) {
		const parsed = Date.parse(value);
		if (Number.isFinite(parsed)) return parsed;
	}
	return undefined;
}

function messageTimestampMs(value: unknown, fallback?: unknown): number | undefined {
	return parseTimestampMs(toRecord(value).timestamp) ?? parseTimestampMs(fallback);
}

function emptyUsage(): AggregateUsageTotals {
	return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
}

function usageFromUnknown(value: unknown): AggregateUsageTotals | undefined {
	const usage = toRecord(toRecord(value).usage);
	const input = typeof usage.input === "number" && Number.isFinite(usage.input) ? usage.input : 0;
	const output = typeof usage.output === "number" && Number.isFinite(usage.output) ? usage.output : 0;
	const cacheRead = typeof usage.cacheRead === "number" && Number.isFinite(usage.cacheRead) ? usage.cacheRead : 0;
	const cacheWrite = typeof usage.cacheWrite === "number" && Number.isFinite(usage.cacheWrite) ? usage.cacheWrite : 0;
	if (input === 0 && output === 0 && cacheRead === 0 && cacheWrite === 0) return undefined;
	return { input, output, cacheRead, cacheWrite };
}

function sumUsage(usageByKey: Map<string, AggregateUsageTotals>): AggregateUsageTotals | undefined {
	const totals = emptyUsage();
	let hasUsage = false;
	for (const usage of usageByKey.values()) {
		hasUsage = true;
		totals.input += usage.input;
		totals.output += usage.output;
		totals.cacheRead += usage.cacheRead;
		totals.cacheWrite += usage.cacheWrite;
	}
	return hasUsage ? totals : undefined;
}

export function formatCompactTokenCount(count: number): string {
	if (count < 1000) return String(count);
	if (count < 10_000) return `${(count / 1000).toFixed(1)}k`;
	if (count < 1_000_000) return `${Math.round(count / 1000)}k`;
	if (count < 10_000_000) return `${(count / 1_000_000).toFixed(1)}M`;
	return `${Math.round(count / 1_000_000)}M`;
}

export function formatAggregateDuration(ms: number): string {
	const totalSeconds = Math.max(0, Math.round(ms / 1000));
	const hours = Math.floor(totalSeconds / 3600);
	const minutes = Math.floor((totalSeconds % 3600) / 60);
	const seconds = totalSeconds % 60;
	if (hours > 0) return `${hours}h${minutes}m${seconds}s`;
	if (minutes > 0) return `${minutes}m${seconds}s`;
	return `${seconds}s`;
}

export function formatAggregateClock(ms: number): string {
	const date = new Date(ms);
	const year = String(date.getFullYear());
	const month = String(date.getMonth() + 1).padStart(2, "0");
	const day = String(date.getDate()).padStart(2, "0");
	const hours = String(date.getHours()).padStart(2, "0");
	const minutes = String(date.getMinutes()).padStart(2, "0");
	const seconds = String(date.getSeconds()).padStart(2, "0");
	return `${year}-${month}-${day} ${hours}:${minutes}:${seconds}`;
}

export function formatAggregateStatsLine(
	view: Pick<AggregateActivityView, "settled" | "durationMs" | "completedAtMs" | "usage" | "contextGrowth">,
): string | undefined {
	if (!view.settled) return undefined;
	const parts: string[] = [];
	if (typeof view.durationMs === "number") parts.push(`took ${formatAggregateDuration(view.durationMs)}`);
	const growth = formatContextGrowth(view.contextGrowth);
	if (growth) parts.push(growth);
	if (view.usage) {
		const tokenParts: string[] = [];
		if (view.usage.input) tokenParts.push(`↑${formatCompactTokenCount(view.usage.input)}`);
		if (view.usage.output) tokenParts.push(`↓${formatCompactTokenCount(view.usage.output)}`);
		if (view.usage.cacheRead) tokenParts.push(`R${formatCompactTokenCount(view.usage.cacheRead)}`);
		if (view.usage.cacheWrite) tokenParts.push(`W${formatCompactTokenCount(view.usage.cacheWrite)}`);
		if (tokenParts.length > 0) parts.push(`tok ${tokenParts.join(" ")}`);
	}
	if (typeof view.completedAtMs === "number") parts.push(`at ${formatAggregateClock(view.completedAtMs)}`);
	return parts.length > 0 ? parts.join(" · ") : undefined;
}

function assistantFailureSummary(message: unknown): string {
	const record = toRecord(message);
	if (record.stopReason === "aborted") return "Operation aborted.";
	return normalizeDisplaySummary(record.errorMessage, FAILED_SUMMARY_MAX_LENGTH) ?? "Assistant turn failed.";
}

const projectionsByOwner = new WeakMap<object, AggregateProjection>();
const liveProjections = new Set<AggregateProjection>();
let hostAggregateProjection: AggregateProjection | undefined;

function rememberProjection(owner: object | undefined, projection: AggregateProjection): void {
	liveProjections.add(projection);
	if (owner) projectionsByOwner.set(owner, projection);
}

function forgetProjection(owner: object | undefined, projection: AggregateProjection): void {
	liveProjections.delete(projection);
	if (owner) projectionsByOwner.delete(owner);
	if (hostAggregateProjection === projection) hostAggregateProjection = undefined;
}

function claimHostProjection(owner: object | undefined, projection: AggregateProjection): boolean {
	rememberProjection(owner, projection);
	if (!hostAggregateProjection) {
		hostAggregateProjection = projection;
		return true;
	}
	return hostAggregateProjection === projection;
}

export function getActiveAggregateProjection(): AggregateProjection | undefined {
	return hostAggregateProjection;
}

export function resolveAggregateProjection(
	preferred?: AggregateProjection,
	...hints: unknown[]
): AggregateProjection | undefined {
	if (preferred) return preferred;
	for (const hint of hints) {
		if (typeof hint !== "string" || !hint) continue;
		for (const projection of liveProjections) {
			if (projection.getMember(hint) || projection.getFrameEdge(hint)) return projection;
		}
	}
	return hostAggregateProjection;
}

export function resolveAggregateRenderTheme(preferred?: AggregateProjection): AggregateRenderTheme {
	return preferred?.getRenderTheme() ?? hostAggregateProjection?.getRenderTheme() ?? publicThemeFallback();
}

export class AggregateProjection {
	private readonly groups: AggregateGroup[] = [];
	private readonly groupsById = new Map<string, AggregateGroup>();
	private readonly membersById = new Map<string, AggregateMember>();
	private readonly framedGroupById = new Map<string, string>();
	private readonly visibleFrameContent = new Set<string>();
	private readonly frameInvalidators = new Map<string, () => void>();
	private readonly invalidators = new Map<string, () => void>();
	private readonly assignedSteerIds = new Set<string>();
	private readonly steersByInstance = new WeakMap<object, string>();
	private sourceOrder = 0;
	private completionOrder = 0;
	private liveGroupSequence = 0;
	private activeGroupId: string | undefined;
	private initialized = false;
	private renderTheme: AggregateRenderTheme | undefined;
	private readonly contextGrowth = new ContextGrowthLedger();
	private readonly contextInvalidators = new Map<string, () => void>();
	private readonly turnIdsByMessage = new WeakMap<object, string>();
	private timelineExpanded = false;
	private timelineExpansionObserved = false;
	private readonly expandedGroups = new Map<string, boolean>();
	private readonly viewportRuns = new Map<string, AggregateViewportRun>();
	private detailOpener?: (request: DetailRequest) => Promise<void>;
	private detailOpen = false;

	constructor(
		private readonly isPassthroughTool: (toolName: string) => boolean = () => false,
		private readonly getExpandedTimeline: () => ExpandedTimeline = () => "flat",
		private readonly showContextGrowth: () => boolean = () => false,
	) {}

	private customSequence = 0;
	private replayEntryIds: string[] = [];
	private customBoundary = false;
	private readonly customMessages = new Map<string, unknown>();
	private readonly customAfterTurn = new Map<string, string>();
	private readonly customIdsByMessage = new WeakMap<object, string>();
	private readonly emptyCustomFrames = new Set<string>();

	isInitialized(): boolean {
		return this.initialized;
	}

	/** IDs describe occurrences in the current transcript, never task identity or text. */
	ingestCustomMessage(message: unknown, restoredId?: string): string | undefined {
		if (messageRole(message) !== "custom" || toRecord(message).display !== true) return undefined;
		if (!restoredId) {
			const existing = this.getCustomMessageItemId(message);
			if (existing) return existing;
		}
		const id = restoredId ?? `custom:${++this.customSequence}`;
		if (this.customBoundary) {
			this.activeGroupId = `custom-segment:${id}`;
			this.customBoundary = false;
		}
		const group = this.ensureActiveGroup();
		this.customMessages.set(id, message);
		const afterTurn = group.agentTurnIds.at(-1);
		if (afterTurn) this.customAfterTurn.set(id, afterTurn);
		this.bindCustomMessage(message, id);
		if (!group.customItemIds.includes(id)) group.customItemIds.push(id);
		if (!group.members.length) group.expansionKey ??= id;
		this.trackFramedItem(id, group.groupId);
		if (!group.members.length && !group.agentTurnIds.length) group.settled = true;
		this.initialized = true;
		this.invalidateIds(...group.framedItemIds);
		return id;
	}

	bindCustomMessage(message: unknown, itemId: string): void {
		if (message && typeof message === "object" && this.customMessages.has(itemId)) {
			this.customIdsByMessage.set(message, itemId);
		}
	}

	getCustomMessageItemId(message: unknown): string | undefined {
		const id = message && typeof message === "object" ? this.customIdsByMessage.get(message) : undefined;
		return id && this.customMessages.has(id) ? id : undefined;
	}

	getCustomOccurrenceIds(): string[] {
		return [...this.customMessages.keys()];
	}

	prepareCustomReplay(entries: unknown[]): Array<string | undefined> {
		this.rebuild(entries);
		let index = 0;
		return materializeAggregateEntries(entries).flatMap((entry) => {
			const message = entryMessage(entry);
			if (messageRole(message) !== "custom") return [];
			return [toRecord(message).display === true ? `custom:${++index}` : undefined];
		});
	}

	/** A failed/unsupported native replay must not leave an invisible summary host. */
	discardCustomReplay(): void {
		for (const group of this.groups) {
			for (const id of group.customItemIds) {
				this.untrackFramedItem(id);
				this.expandedGroups.delete(id);
			}
			group.customItemIds = [];
			group.expansionKey = undefined;
			this.invalidateGroup(group.groupId);
		}
		this.customMessages.clear();
		this.customAfterTurn.clear();
		this.emptyCustomFrames.clear();
		this.clearViewportState();
	}

	private collapsedHost(group: AggregateGroup): string | undefined {
		return [...group.framedItemIds].reverse().find((id) => {
			if (this.customMessages.has(id)) return !this.emptyCustomFrames.has(id);
			const member = this.membersById.get(id);
			return member?.visible && member.state !== "needsAttention" && !this.isPassthrough(member.toolName);
		});
	}

	isPassthrough(toolName: string): boolean {
		return this.isPassthroughTool(toolName);
	}

	setRenderTheme(theme: AggregateRenderTheme): void {
		this.renderTheme = theme;
	}

	getRenderTheme(): AggregateRenderTheme {
		return this.renderTheme ?? publicThemeFallback();
	}

	noteTimelineExpansion(expanded: boolean): void {
		const changed = this.timelineExpanded !== expanded;
		this.timelineExpansionObserved = true;
		this.timelineExpanded = expanded;
		if (changed) {
			this.expandedGroups.clear();
			this.invalidateAll();
		}
	}

	isTimelineExpanded(): boolean {
		return this.timelineExpanded;
	}

	private groupForItem(itemId: string): AggregateGroup | undefined {
		const groupId = this.membersById.get(itemId)?.groupId ?? this.framedGroupById.get(itemId);
		return this.groupsById.get(groupId ?? itemId)
			?? this.groups.find((group) => group.agentTurnIds.includes(itemId));
	}

	isItemExpanded(itemId: string, fallback = false): boolean {
		const group = this.groupForItem(itemId);
		return (group && this.expandedGroups.get(group.expansionKey ?? group.members[0]?.toolCallId ?? group.groupId))
			?? (this.timelineExpansionObserved ? this.timelineExpanded : fallback);
	}

	isMessageExpanded(message: unknown, fallback = false): boolean {
		return this.isItemExpanded(this.contextTurnId(message) ?? aggregateAssistantFrameId(message) ?? "", fallback);
	}

	getViewportRun(itemId: string): AggregateViewportRun | undefined {
		const group = this.groupForItem(itemId);
		if (!group) return undefined;
		const cached = this.viewportRuns.get(group.groupId);
		if (cached) return cached;
		const id = group.groupId;
		const run: AggregateViewportRun = {
			owner: this, id,
			isValid: () => this.viewportRuns.get(id) === run && this.groupsById.has(id),
			isExpanded: () => this.isItemExpanded(id),
			toggle: () => { if (run.isValid()) this.toggleGroupExpansion(id); },
			label: () => {
				const count = this.groupsById.get(id)?.members.filter((member) => member.visible).length ?? 0;
				const messages = this.groupsById.get(id)?.customItemIds.filter((item) => !this.emptyCustomFrames.has(item)).length ?? 0;
				const parts = count > 0 || messages === 0 ? [`${count} ${pluralize(count, "call")}`] : [];
				if (messages) parts.push(`${messages} ${pluralize(messages, "message")}`);
				return `Run (${parts.join(" · ")})`;
			},
		};
		this.viewportRuns.set(id, run);
		return run;
	}

	clearViewportState(): void {
		this.viewportRuns.clear();
		resetAggregateViewportOwner(this);
	}

	toggleGroupExpansionFromComponent(itemId: string, component: object): void {
		const run = this.getViewportRun(itemId);
		if (run) toggleAggregateViewportRun(component, run);
	}

	toggleGroupExpansion(itemId: string): void {
		const group = this.groupForItem(itemId);
		if (!group) return;
		const expanded = !this.isItemExpanded(itemId);
		this.timelineExpansionObserved = true;
		this.expandedGroups.set(group.expansionKey ?? group.members[0]?.toolCallId ?? group.groupId, expanded);
		this.invalidateIds(...group.members.map((member) => member.toolCallId), ...group.framedItemIds);
		for (const id of group.agentTurnIds) this.contextInvalidators.get(id)?.();
	}

	setDetailOpener(opener: ((request: DetailRequest) => Promise<void>) | undefined): void {
		this.detailOpener = opener;
	}

	openDetail(request: DetailRequest): void {
		if (!this.detailOpener || this.detailOpen) return;
		this.detailOpen = true;
		void this.detailOpener(request).catch(() => { /* The UI may have closed with its session. */ })
			.finally(() => { this.detailOpen = false; });
	}

	getGroups(): readonly AggregateGroup[] {
		return this.groups;
	}

	hasPaintedToolsLedger(message?: unknown): boolean {
		const turnId = aggregateAssistantTurnId(message);
		if (turnId) {
			for (const group of this.groups) {
				if (group.agentTurnIds.includes(turnId)) return Boolean(group.leaderToolCallId);
			}
			return false;
		}
		const active = this.activeGroupId ? this.groupsById.get(this.activeGroupId) : undefined;
		return Boolean(active?.leaderToolCallId);
	}

	assistantFollowsAggregateLedger(message?: unknown): boolean {
		const turnId = aggregateAssistantTurnId(message);
		if (!turnId) return false;
		for (const group of this.groups) {
			if (!group.agentTurnIds.includes(turnId) || !group.leaderToolCallId) continue;
			const firstToolTurn = this.toolTurnIds(group)[0];
			if (!firstToolTurn) return false;
			return group.agentTurnIds.indexOf(turnId) > group.agentTurnIds.indexOf(firstToolTurn);
		}
		return false;
	}

	framedItemFollowsTool(itemId: string): boolean {
		const items = this.getFramedItemIds(itemId);
		const index = items.indexOf(itemId);
		if (index <= 0) return false;
		const previous = items[index - 1] ?? "";
		return this.membersById.has(previous);
	}

	shouldFrameAssistantNarration(message?: unknown): boolean {
		if (this.isPassthroughOnlyAssistantMessage(message)) return false;
		if (this.hasPaintedToolsLedger(message)) return true;
		if (!message) return false;
		return toolCallsFromMessage(message).some((call) => !this.isPassthrough(call.name));
	}

	private isPassthroughOnlyAssistantMessage(message?: unknown): boolean {
		if (!message) return false;
		const calls = toolCallsFromMessage(message);
		return calls.length > 0 && calls.every((call) => this.isPassthrough(call.name));
	}

	getMember(toolCallId: string): AggregateMember | undefined {
		return this.membersById.get(toolCallId);
	}

	renderExpandedToolRow(toolCallId: string, width: number, nowMs = Date.now()): string[] {
		return this.renderExpandedToolRowLayout(toolCallId, width, nowMs).lines;
	}

	renderExpandedToolRowLayout(toolCallId: string, width: number, nowMs = Date.now()): { lines: string[]; callStart: number } {
		const member = this.getMember(toolCallId);
		if (!member) return { lines: [], callStart: 0 };
		const theme = this.getRenderTheme();
		const edge = this.getFrameEdge(toolCallId) ?? "only";
		if (this.getExpandedTimeline() !== "turns") {
			return { lines: renderAggregateMemberRow(member, width, theme, edge, nowMs), callStart: 0 };
		}
		const turn = this.getExpandedTurnPresentation(member, edge, nowMs);
		return {
			lines: renderExpandedAggregateMember(member, width, theme, edge, nowMs, turn),
			callStart: (turn.leadingBlank ? 1 : 0) + (turn.header ? 1 : 0),
		};
	}

	private toolTurnIds(group: AggregateGroup, includePassthrough = false): string[] {
		return group.agentTurnIds.filter((turnId) =>
			group.members.some((member) => (
				member.visible &&
				member.agentTurnId === turnId &&
				(includePassthrough || !this.isPassthrough(member.toolName))
			)),
		);
	}

	private turnPeers(group: AggregateGroup, turnId: string): AggregateMember[] {
		return group.members
			.filter((member) => (
				member.visible &&
				member.agentTurnId === turnId &&
				!this.isPassthrough(member.toolName)
			))
			.sort((left, right) => left.sourceOrder - right.sourceOrder);
	}

	private getExpandedTurnPresentation(
		member: AggregateMember,
		edge: AggregateFrameEdge,
		nowMs: number,
	): ExpandedTurnPresentation {
		const group = this.groupsById.get(member.groupId);
		if (!group || !member.agentTurnId) return { indent: false };
		const turnIds = this.toolTurnIds(group, this.showContextGrowth());
		const index = turnIds.indexOf(member.agentTurnId);
		if (index < 0) return { indent: false };
		const peers = this.turnPeers(group, member.agentTurnId);
		const isFirst = peers[0]?.toolCallId === member.toolCallId;
		if (!isFirst) return { indent: true };
		const running = peers.some((peer) => peer.state === "pending" || peer.state === "running");
		const startedAtMs = minDefined(peers.map((peer) => peer.startedAtMs));
		const endedAtMs = running ? undefined : maxDefined(peers.map((peer) => peer.endedAtMs));
		return {
			indent: true,
			leadingBlank: edge === "continue" || edge === "end",
			header: formatExpandedTurnHeader({
				index: index + 1,
				total: turnIds.length,
				callCount: peers.length,
				failedCount: peers.filter((peer) => peer.state === "failed").length,
				contextGrowth: this.showContextGrowth() ? this.contextGrowth.getTurn(member.agentTurnId) : undefined,
				startedAtMs,
				endedAtMs,
				running,
			}, this.getRenderTheme(), nowMs),
		};
	}

	getFrameEdge(itemId: string): AggregateFrameEdge | undefined {
		const items = this.getFramedItemIds(itemId);
		const index = items.indexOf(itemId);
		if (index < 0) return undefined;
		if (items.length === 1) return "only";
		if (index === 0) return "start";
		if (index === items.length - 1) return "end";
		return "continue";
	}

	getFramedItemIds(itemId: string): string[] {
		const groupId = this.framedGroupById.get(itemId);
		return groupId ? (this.groupsById.get(groupId)?.framedItemIds ?? []).filter((id) => !this.emptyCustomFrames.has(id)) : [];
	}

	isFrameStart(itemId: string): boolean {
		const edge = this.getFrameEdge(itemId);
		return edge === "start" || edge === "only";
	}

	shouldHostExpandedSummary(itemId: string): boolean {
		const items = this.getFramedItemIds(itemId);
		const firstVisible = items.find((id) => this.hasVisibleFrameContent(id));
		return firstVisible === itemId;
	}

	hasVisibleFrameContent(itemId: string): boolean {
		if (
			!itemId.startsWith("assistant-before:") &&
			!itemId.startsWith("assistant:") &&
			!itemId.startsWith("steer:")
		) {
			return true;
		}
		return this.visibleFrameContent.has(itemId);
	}

	markFrameContentVisible(itemId: string, visible: boolean): void {
		if (!itemId) return;
		const previousHost = this.getFramedItemIds(itemId).find((id) => this.hasVisibleFrameContent(id));
		const group = this.groupForItem(itemId);
		if (this.customMessages.has(itemId)) {
			const wasEmpty = this.emptyCustomFrames.has(itemId);
			if (visible) this.emptyCustomFrames.delete(itemId);
			else this.emptyCustomFrames.add(itemId);
			if (wasEmpty === visible && group) this.invalidateIds(...group.framedItemIds);
		}
		if (visible) this.visibleFrameContent.add(itemId);
		else this.visibleFrameContent.delete(itemId);
		const nextHost = this.getFramedItemIds(itemId).find((id) => this.hasVisibleFrameContent(id));
		if (previousHost !== nextHost) this.invalidateIds(previousHost, nextHost, itemId);
	}

	getViewForGroup(itemId: string): AggregateActivityView | undefined {
		const group = this.groupForItem(itemId);
		const host = group && this.collapsedHost(group);
		return group && host ? this.buildGroupView(group, host) : undefined;
	}

	private groupIdForFrameItem(itemId: string, beforeId?: string): string | undefined {
		if (beforeId) {
			const fromTool = this.membersById.get(beforeId)?.groupId ?? this.framedGroupById.get(beforeId);
			if (fromTool) return fromTool;
		}
		const existing = this.framedGroupById.get(itemId);
		if (existing) return existing;
		const prefix = "assistant-before:";
		if (itemId.startsWith(prefix)) {
			const toolId = itemId.slice(prefix.length);
			return this.membersById.get(toolId)?.groupId ?? this.framedGroupById.get(toolId);
		}
		return this.activeGroupId;
	}

	trackFramedItem(itemId: string, groupId?: string, beforeId?: string): void {
		const resolvedGroupId = groupId ?? this.groupIdForFrameItem(itemId, beforeId);
		if (!resolvedGroupId || !itemId) return;
		const existingGroupId = this.framedGroupById.get(itemId);
		if (existingGroupId === resolvedGroupId) return;
		if (existingGroupId) this.untrackFramedItem(itemId);
		const group = this.ensureGroup(resolvedGroupId);
		const previousLast = group.framedItemIds[group.framedItemIds.length - 1];
		const beforeIndex = beforeId ? group.framedItemIds.indexOf(beforeId) : -1;
		if (beforeIndex >= 0) group.framedItemIds.splice(beforeIndex, 0, itemId);
		else group.framedItemIds.push(itemId);
		this.framedGroupById.set(itemId, resolvedGroupId);
		this.invalidateIds(previousLast, itemId);
	}

	untrackFramedItem(itemId: string): void {
		const groupId = this.framedGroupById.get(itemId);
		if (!groupId) return;
		const group = this.groupsById.get(groupId);
		const previousLast = group?.framedItemIds[group.framedItemIds.length - 1];
		if (group) group.framedItemIds = group.framedItemIds.filter((id) => id !== itemId);
		this.framedGroupById.delete(itemId);
		this.invalidateIds(previousLast, group?.framedItemIds[group.framedItemIds.length - 1]);
	}

	connectFrameRenderer(itemId: string, invalidate: (() => void) | undefined): void {
		if (!invalidate || !itemId) return;
		this.frameInvalidators.set(itemId, invalidate);
	}

	rememberNarration(itemId: string, text: string, groupId?: string): void {
		const resolvedGroupId = groupId ?? this.groupIdForFrameItem(itemId);
		if (!resolvedGroupId || !itemId || !text) return;
		const group = this.ensureGroup(resolvedGroupId);
		group.narrationById.set(itemId, text);
		this.invalidateIds(group.leaderToolCallId);
	}

	rememberAgentTurn(message: unknown): void {
		const group = this.ensureActiveGroup();
		const previousId = message && typeof message === "object"
			? this.turnIdsByMessage.get(message) ?? this.membersById.get(toolCallsFromMessage(message)[0]?.id ?? "")?.agentTurnId
			: undefined;
		const id = aggregateAssistantTurnId(message) ?? previousId ?? `assistant-turn:${group.agentTurnIds.length + 1}`;
		// A later message_end handler may replace timestamp/id in place. Reconcile
		// the streaming turn instead of creating a phantom turn at turn_end.
		if (previousId && previousId !== id && group.agentTurnIds.includes(previousId)) {
			group.agentTurnIds = [...new Set(group.agentTurnIds.map((value) => value === previousId ? id : value))];
			group.usageByKey.delete(previousId);
			for (const item of group.customItemIds) {
				if (this.customAfterTurn.get(item) === previousId) this.customAfterTurn.set(item, id);
			}
			for (const member of group.members) {
				if (member.agentTurnId === previousId) member.agentTurnId = id;
			}
			const invalidate = this.contextInvalidators.get(previousId);
			if (invalidate) this.contextInvalidators.set(id, invalidate);
			this.contextInvalidators.delete(previousId);
		}
		if (!group.agentTurnIds.includes(id)) group.agentTurnIds.push(id);
		if (message && typeof message === "object") this.turnIdsByMessage.set(message, id);
		this.rememberUsage(id, message);
		this.rememberEndedAt(messageTimestampMs(message));
	}

	rememberUsage(key: string, value: unknown): void {
		const usage = usageFromUnknown(value);
		if (!key || !usage) return;
		const group = this.ensureActiveGroup();
		group.usageByKey.set(key, usage);
		this.invalidateIds(group.leaderToolCallId);
	}

	rememberStartedAt(timestampMs: number | undefined): void {
		if (timestampMs === undefined) return;
		const group = this.ensureActiveGroup();
		if (group.startedAtMs === undefined || timestampMs < group.startedAtMs) group.startedAtMs = timestampMs;
		this.invalidateIds(group.leaderToolCallId);
	}

	rememberEndedAt(timestampMs: number | undefined): void {
		if (timestampMs === undefined) return;
		this.rememberStartedAt(timestampMs);
		const group = this.ensureActiveGroup();
		if (group.endedAtMs === undefined || timestampMs > group.endedAtMs) group.endedAtMs = timestampMs;
		this.invalidateIds(group.leaderToolCallId);
	}

	markGroupSettled(groupId = this.activeGroupId, endedAtMs?: number): void {
		if (!groupId) return;
		const group = this.groupsById.get(groupId);
		if (!group || group.settled) return;
		group.settled = true;
		this.rememberEndedAt(endedAtMs ?? (group.endedAtMs === undefined ? Date.now() : undefined));
		this.invalidateIds(group.leaderToolCallId);
	}

	latestNarrationFor(itemId: string): string | undefined {
		const groupId = this.framedGroupById.get(itemId) ?? this.membersById.get(itemId)?.groupId;
		if (!groupId) return undefined;
		const group = this.groupsById.get(groupId);
		if (!group) return undefined;
		for (const frameId of [...group.framedItemIds].reverse()) {
			const narration = group.narrationById.get(frameId);
			if (narration) return narration;
		}
		return undefined;
	}

	getConnectedRendererCount(): number {
		return this.invalidators.size;
	}

	startUserGroup(groupId?: string, startedAtMs?: number, options: { collapseRetainedDone?: boolean } = {}): string {
		const previousGroupId = this.activeGroupId;
		if (previousGroupId && previousGroupId !== groupId) {
			this.markUnsettledInterrupted();
			this.markGroupSettled(previousGroupId, startedAtMs);
		}
		if (options.collapseRetainedDone !== false) this.collapseRetainedDone();
		const resolvedId = groupId || `live-user-${++this.liveGroupSequence}`;
		const group = this.ensureGroup(resolvedId);
		this.activeGroupId = resolvedId;
		this.customBoundary = false;
		this.initialized = true;
		const fromId = resolvedId.startsWith("live-user-")
			? parseTimestampMs(resolvedId.slice("live-user-".length))
			: undefined;
		this.rememberStartedAt(startedAtMs ?? fromId);
		group.settled = false;
		return resolvedId;
	}

	shouldTreatAsSteer(streamingBehavior?: "steer" | "followUp"): boolean {
		const group = this.activeGroupId ? this.groupsById.get(this.activeGroupId) : undefined;
		if (!group || group.settled) return false;
		if (streamingBehavior === "followUp") return false;
		if (streamingBehavior === "steer") return true;
		return group.hasSeenToolBatch;
	}

	recordSteer(text: string, timestampMs?: number): string | undefined {
		const group = this.activeGroupId ? this.groupsById.get(this.activeGroupId) : undefined;
		if (!group) return undefined;
		const id = `steer:${group.groupId}:${group.steers.length}`;
		group.steers.push({
			id,
			text,
			firstLine: steerFirstLine(text),
		});
		this.trackFramedItem(id, group.groupId);
		this.rememberEndedAt(timestampMs);
		this.invalidateIds(group.leaderToolCallId);
		return id;
	}

	ingestUserMessage(
		message: unknown,
		options: {
			streamingBehavior?: "steer" | "followUp";
			collapseRetainedDone?: boolean;
			groupId?: string;
			timestampMs?: number;
		} = {},
	): "steer" | "group" | undefined {
		if (messageRole(message) !== "user") return undefined;
		const timestampMs = options.timestampMs ?? messageTimestampMs(message);
		if (this.shouldTreatAsSteer(options.streamingBehavior)) {
			this.recordSteer(userMessageText(message), timestampMs);
			return "steer";
		}
		const groupId = options.groupId ??
			(timestampMs !== undefined ? `live-user-${timestampMs}` : undefined);
		this.startUserGroup(groupId, timestampMs, {
			collapseRetainedDone: options.collapseRetainedDone,
		});
		return "group";
	}

	getSteer(id: string): AggregateSteer | undefined {
		for (const group of this.groups) {
			const found = group.steers.find((steer) => steer.id === id);
			if (found) return found;
		}
		return undefined;
	}

	matchSteerForComponent(component: object, text?: string): AggregateSteer | undefined {
		const existingId = this.steersByInstance.get(component);
		if (existingId) {
			const existing = this.getSteer(existingId);
			if (existing) return existing;
		}
		if (text === undefined) return undefined;
		for (const group of this.groups) {
			for (const steer of group.steers) {
				if (steer.text !== text || this.assignedSteerIds.has(steer.id)) continue;
				this.assignedSteerIds.add(steer.id);
				this.steersByInstance.set(component, steer.id);
				return steer;
			}
		}
		for (const group of this.groups) {
			const found = group.steers.find((steer) => steer.text === text);
			if (found) return found;
		}
		return undefined;
	}

	connectRenderer(
		toolCallId: string,
		toolName: string,
		args: unknown,
		invalidate: (() => void) | undefined,
	): void {
		if (!this.initialized) {
			if (invalidate) this.invalidators.set(toolCallId, invalidate);
			return;
		}
		const member = this.membersById.get(toolCallId);
		if (!member || !member.visible) return;
		if (invalidate) this.invalidators.set(toolCallId, invalidate);
		member.args = { ...member.args, ...toRecord(args) };
		if (member.toolName !== toolName) member.toolName = toolName;
	}

	ingestAssistantMessage(message: unknown): void {
		if (messageRole(message) !== "assistant") return;
		const savedGroup = this.activeGroupId;
		const savedBoundary = this.customBoundary;
		const turnId = this.contextTurnId(message);
		const known = turnId ? this.groups.find((group) => group.agentTurnIds.includes(turnId)) : undefined;
		if (known) this.activeGroupId = known.groupId;
		else {
			this.ensureActiveGroup().settled = false;
			this.customBoundary = false;
		}
		this.rememberAgentTurn(message);
		const calls = toolCallsFromMessage(message);
		if (calls.length > 0) this.markGroupSawToolBatch();
		if (
			isInterimAssistantMessage(message) &&
			!this.isPassthroughOnlyAssistantMessage(message)
		) {
			const frameId = aggregateAssistantFrameId(message);
			const narration = firstVisibleAssistantText(message);
			if (frameId && narration) {
				// A native assistant component already exists when a custom notice
				// arrives during its text stream. Later tool-call discovery must not
				// put the Run title below that earlier narration.
				const turn = this.contextTurnId(message);
				const beforeNotice = this.ensureActiveGroup().customItemIds.find((id) => this.customAfterTurn.get(id) === turn);
				this.trackFramedItem(frameId, this.activeGroupId, beforeNotice ?? calls[0]?.id);
				this.rememberNarration(frameId, narration);
			}
		}
		for (const call of calls) {
			this.addOrUpdateMember(call.id, call.name, call.args, true);
		}
		if (isAssistantTerminalFailure(message)) {
			const summary = assistantFailureSummary(message);
			for (const call of toolCallsFromMessage(message)) {
				if (this.membersById.has(call.id)) this.markFailed(call.id, summary);
			}
		}
		this.maybeSettleFromTerminalAssistant(message);
		if (known && known.groupId !== savedGroup) {
			this.activeGroupId = savedGroup;
			this.customBoundary = savedBoundary;
		}
	}

	ingestToolResult(
		message: unknown,
		options: { retainDone?: boolean; fallbackTimestamp?: unknown } = {},
	): void {
		if (messageRole(message) !== "toolResult") return;
		const record = toRecord(message);
		if (typeof record.toolCallId === "string") {
			const member = this.membersById.get(record.toolCallId);
			if (!member || !this.isPassthrough(member.toolName)) {
				this.rememberUsage(`tool:${record.toolCallId}`, message);
			}
			this.markComplete(record.toolCallId, record, record.isError === true, {
				retainDone: options.retainDone,
				endedAtMs: messageTimestampMs(message, options.fallbackTimestamp),
				stampNow: false,
			});
		}
		this.markGroupSawToolBatch(this.membersById.get(String(record.toolCallId))?.groupId);
		this.rememberEndedAt(messageTimestampMs(message, options.fallbackTimestamp));
	}

	markStarted(toolCallId: string, toolName: string, args: unknown): void {
		const normalizedName = normalizeToolName(toolName);
		if (!normalizedName) return;
		const member = this.addOrUpdateMember(toolCallId, normalizedName, args, true);
		if (!member || member.state === "needsAttention") return;
		member.startedAtMs = Date.now();
		member.state = "running";
		delete member.agentReceipt;
		member.retainedDone = false;
		member.completionOrder = undefined;
		member.endedAtMs = undefined;
		const group = this.groupsById.get(member.groupId);
		if (group) group.settled = false;
		this.invalidateGroup(member.groupId, toolCallId);
	}

	markUpdated(toolCallId: string, args: unknown): void {
		const member = this.membersById.get(toolCallId);
		if (!member) return;
		member.args = { ...member.args, ...toRecord(args) };
		if (member.state === "pending") member.state = "running";
		this.invalidateGroup(member.groupId, toolCallId);
	}

	markComplete(
		toolCallId: string,
		result: unknown,
		isError: boolean,
		options: { retainDone?: boolean; endedAtMs?: number; stampNow?: boolean } = {},
	): void {
		const member = this.membersById.get(toolCallId);
		if (!member) return;
		if (isError) {
			this.markFailed(toolCallId, firstMeaningfulLine(result, "Tool failed."), options);
			return;
		}

		if (member.toolName === "Agent") {
			member.agentReceipt = readAgentCallReceipt(member.args, result);
			if (member.agentReceipt === "failed" || member.agentReceipt === "stopped") {
				this.markFailed(toolCallId, firstMeaningfulLine(result, `Agent ${member.agentReceipt}.`), options);
				return;
			}
		}
		const firstSuccess = member.state !== "success";
		member.state = "success";
		member.errorSummary = undefined;
		this.stampMemberEnd(member, options);
		if (firstSuccess && options.retainDone !== false && !this.isPassthrough(member.toolName)) {
			member.retainedDone = true;
			member.completionOrder = ++this.completionOrder;
			this.trimRetainedDone(member.groupId);
		}
		this.invalidateGroup(member.groupId, toolCallId);
	}

	markNeedsAttention(toolCallId: string): void {
		const member = this.membersById.get(toolCallId);
		if (!member || member.state === "needsAttention") return;
		member.state = "needsAttention";
		member.errorSummary = undefined;
		member.retainedDone = false;
		member.completionOrder = undefined;
		this.recomputeLeader(member.groupId);
		this.invalidateGroup(member.groupId, toolCallId);
	}

	markFailed(
		toolCallId: string,
		summary: string,
		options: { endedAtMs?: number; stampNow?: boolean } = {},
	): void {
		const member = this.membersById.get(toolCallId);
		if (!member || member.state === "needsAttention") return;
		member.state = "failed";
		delete member.agentReceipt;
		member.errorSummary = normalizeDisplaySummary(summary, FAILED_SUMMARY_MAX_LENGTH) ?? "Tool failed.";
		member.retainedDone = false;
		member.completionOrder = undefined;
		this.stampMemberEnd(member, options);
		this.invalidateGroup(member.groupId, toolCallId);
	}

	private stampMemberEnd(
		member: AggregateMember,
		options: { endedAtMs?: number; stampNow?: boolean } = {},
	): void {
		if (options.endedAtMs !== undefined) {
			member.endedAtMs ??= options.endedAtMs;
			return;
		}
		if (options.stampNow === false) return;
		member.endedAtMs = Date.now();
	}

	collapseRetainedDone(): void {
		const changedGroups = new Set<string>();
		for (const member of this.membersById.values()) {
			if (!member.retainedDone) continue;
			member.retainedDone = false;
			member.completionOrder = undefined;
			changedGroups.add(member.groupId);
		}
		for (const groupId of changedGroups) this.invalidateGroup(groupId);
	}

	markUnsettledInterrupted(summary = "Interrupted before a final result."): void {
		for (const member of this.membersById.values()) {
			if (member.state === "pending" || member.state === "running") {
				this.markFailed(member.toolCallId, summary);
			}
		}
	}

	rebuild(branchEntries: unknown[], visibleMessages?: unknown[]): void {
		this.clearViewportState();
		const visibleIds = collectVisibleToolCallIds(visibleMessages);
		const projectedEntries = materializeAggregateEntries(Array.isArray(branchEntries) ? branchEntries : []);
		const nextEntryIds = projectedEntries.map((entry, index) => entryId(entry, `position:${index}`));
		// Occurrence IDs are scoped to the current transcript. A different branch
		// or compaction must not inherit another notification's local expansion.
		if (!this.replayEntryIds.every((id, index) => nextEntryIds[index] === id)) {
			for (const id of this.customMessages.keys()) this.expandedGroups.delete(id);
		}
		this.replayEntryIds = nextEntryIds;
		this.customSequence = 0;
		this.customBoundary = false;
		this.customMessages.clear();
		this.customAfterTurn.clear();
		this.emptyCustomFrames.clear();
		this.groups.length = 0;
		this.groupsById.clear();
		this.membersById.clear();
		this.framedGroupById.clear();
		this.visibleFrameContent.clear();
		this.frameInvalidators.clear();
		this.assignedSteerIds.clear();
		this.sourceOrder = 0;
		this.completionOrder = 0;
		this.activeGroupId = undefined;

		let fallbackGroupIndex = 0;
		for (const entry of projectedEntries) {
			const message = entryMessage(entry);
			if (!message) continue;
			const role = messageRole(message);
			if (role === "custom") {
				if (toRecord(message).display === true) this.ingestCustomMessage(message, `custom:${++this.customSequence}`);
				continue;
			}
			if (role === "user") {
				const restoredId = entryId(entry, `restored-user-${++fallbackGroupIndex}`);
				this.ingestUserMessage(message, {
					groupId: restoredId,
					collapseRetainedDone: false,
					timestampMs: messageTimestampMs(message, toRecord(entry).timestamp),
				});
				continue;
			}
			if (role === "assistant") {
				this.ingestAssistantMessage(message);
				const startedAtMs = messageTimestampMs(message, toRecord(entry).timestamp);
				this.rememberEndedAt(startedAtMs);
				for (const call of toolCallsFromMessage(message)) {
					const member = this.membersById.get(call.id);
					if (!member) continue;
					const visible = visibleIds?.has(call.id) ?? true;
					member.visible = visible;
					if (!visible) this.untrackFramedItem(call.id);
					if (startedAtMs !== undefined) member.startedAtMs ??= startedAtMs;
				}
				continue;
			}
			if (role === "toolResult") {
				this.ingestToolResult(message, {
					retainDone: false,
					fallbackTimestamp: toRecord(entry).timestamp,
				});
			}
		}

		this.initialized = true;
		this.markUnsettledInterrupted();
		for (const group of this.groups) {
			this.recomputeLeader(group.groupId);
			group.settled ||= group.members.length > 0
				&& !group.members.some((member) => member.state === "pending" || member.state === "running");
		}
		const staleInvalidators: Array<() => void> = [];
		for (const [toolCallId, invalidate] of this.invalidators) {
			if (this.membersById.get(toolCallId)?.visible !== true) {
				this.invalidators.delete(toolCallId);
				staleInvalidators.push(invalidate);
			}
		}
		for (const invalidate of staleInvalidators) {
			try {
				invalidate();
			} catch {
				// A removed row may already belong to a disposed transcript.
			}
		}
		const expansionKeys = new Set(this.groups.map((group) => group.expansionKey ?? group.members[0]?.toolCallId ?? group.groupId));
		for (const key of this.expandedGroups.keys()) {
			if (!expansionKeys.has(key)) this.expandedGroups.delete(key);
		}
		this.rebuildContextGrowth(projectedEntries);
	}

	private contextTurnId(message: unknown): string | undefined {
		return aggregateAssistantTurnId(message)
			?? (message && typeof message === "object" ? this.turnIdsByMessage.get(message) : undefined);
	}

	/** Reuse the final branch for live turns and history, never streaming usage. */
	rebuildContextGrowth(entries: readonly unknown[]): void {
		this.contextGrowth.reset();
		const groupsByTurn = new Map(this.groups.flatMap((group) => group.agentTurnIds.map((id) => [id, group] as const)));
		let previousGroup: AggregateGroup | undefined;
		let previousTerminal = true;
		for (const entry of entries) {
			const source = toRecord(entry);
			const message = entryMessage(entry);
			const role = messageRole(message);
			if (role === "assistant") {
				const id = this.contextTurnId(message);
				const group = id ? groupsByTurn.get(id) : undefined;
				if (!id || !group) {
					this.contextGrowth.breakChain(previousGroup?.groupId);
					continue;
				}
				this.contextGrowth.recordAssistant(group.groupId, id, message);
				previousGroup = group;
				previousTerminal = isAssistantTerminal(message);
			} else if (role === "toolResult") {
				this.contextGrowth.recordToolResult(message);
			} else if (role === "user") {
				// A new run does not invalidate the preceding run's own total. A steer
				// will be detected when the next assistant stays in the same group.
				this.contextGrowth.breakChain();
			} else if (message || ["custom_message", "compaction", "branch_summary", "model_change", "thinking_level_change"].includes(String(source.type))) {
				this.contextGrowth.breakChain(previousTerminal ? undefined : previousGroup?.groupId);
			}
		}
		this.invalidateAll();
	}

	finishContextTurn(message: unknown, toolResults: readonly unknown[], entries?: readonly unknown[]): void {
		this.ingestAssistantMessage(message);
		if (entries) {
			this.rebuildContextGrowth(entries);
			return;
		}
		const id = this.contextTurnId(message);
		const group = id ? this.groups.find((candidate) => candidate.agentTurnIds.includes(id)) : undefined;
		if (!id || !group) return;
		this.contextGrowth.recordAssistant(group.groupId, id, message);
		for (const result of toolResults) this.contextGrowth.recordToolResult(result);
		this.invalidateAll();
	}

	connectContextRenderer(message: unknown, invalidate: () => void): void {
		const id = this.contextTurnId(message);
		if (id) this.contextInvalidators.set(id, invalidate);
	}

	getAssistantContextLines(message: unknown, expanded: boolean): string[] {
		// Plain replies retain their original spacing and never host ledger chrome.
		// Their finalized usage still participates in the run's measurements.
		if (!this.showContextGrowth() || toolCallsFromMessage(message).length === 0) return [];
		const id = this.contextTurnId(message);
		const group = id ? this.groups.find((entry) => entry.agentTurnIds.includes(id)) : undefined;
		if (!id || !group) return [];
		const lines: string[] = [];
		const growth = this.contextGrowth.getTurn(id);
		const turnIds = this.toolTurnIds(group, true);
		const index = turnIds.indexOf(id);
		if (expanded && this.getExpandedTimeline() === "turns" && growth && index >= 0 && this.turnPeers(group, id).length === 0) {
			const peers = group.members.filter((member) => member.visible && member.agentTurnId === id);
			lines.push(formatExpandedTurnHeader({
				index: index + 1,
				total: turnIds.length,
				callCount: peers.length,
				failedCount: peers.filter((member) => member.state === "failed").length,
				running: false,
				contextGrowth: growth,
			}, this.getRenderTheme()));
		}
		// Passthrough-only runs need no dummy Tools ledger.
		if (!group.leaderToolCallId && group.settled && group.agentTurnIds.at(-1) === id
			&& !(lines.length > 0 && group.agentTurnIds.length === 1)) {
			const summary = formatContextGrowth(this.contextGrowth.getRun(group.groupId, group.agentTurnIds));
			if (summary) lines.push(summary);
		}
		return lines;
	}

	getView(itemId: string): AggregateActivityView | undefined {
		const group = this.groupForItem(itemId);
		if (!group || this.collapsedHost(group) !== itemId) return undefined;
		return this.buildGroupView(group, itemId);
	}

	private buildGroupView(group: AggregateGroup, hostId: string): AggregateActivityView {
		const grouped = group.members;
		const aggregateMembers = grouped.filter(
			(entry) => entry.state !== "needsAttention" && !this.isPassthrough(entry.toolName),
		);
		const activeAll = aggregateMembers
			.filter((entry) => entry.state === "pending" || entry.state === "running")
			.sort((left, right) => left.sourceOrder - right.sourceOrder);
		const active = activeAll.slice(0, ACTIVE_ROW_LIMIT);
		const retainedDone = aggregateMembers
			.filter((entry) => entry.state === "success" && entry.retainedDone)
			.sort((left, right) => (right.completionOrder ?? 0) - (left.completionOrder ?? 0))
			.slice(0, Math.max(0, ACTIVE_ROW_LIMIT - active.length));
		const displayRows = [...active, ...retainedDone]
			.sort((left, right) => left.sourceOrder - right.sourceOrder);
		const failed = aggregateMembers
			.filter((entry) => entry.state === "failed")
			.sort((left, right) => left.sourceOrder - right.sourceOrder);

		const summaries = new Map<string, AggregateToolSummary>();
		for (const entry of [...grouped].sort((left, right) => left.sourceOrder - right.sourceOrder)) {
			const summary = summaries.get(entry.toolName);
			if (summary) {
				summary.count += 1;
				summary.lastTarget = formatAggregateTarget(entry);
			} else {
				summaries.set(entry.toolName, {
					toolName: entry.toolName,
					count: 1,
					lastTarget: formatAggregateTarget(entry),
				});
			}
		}

		return {
			groupId: group.groupId,
			leaderToolCallId: group.leaderToolCallId ?? hostId,
			hasRunning: grouped.some((entry) => entry.state === "pending" || entry.state === "running"),
			latestNarration: this.latestNarrationFor(hostId),
			callCount: grouped.length,
			customMessageCount: group.customItemIds.filter((id) => !this.emptyCustomFrames.has(id)).length,
			agentTurnCount: grouped.length ? Math.max(1, group.agentTurnIds.length) : group.agentTurnIds.length,
			settled: group.settled,
			durationMs: group.startedAtMs !== undefined && group.endedAtMs !== undefined
				? Math.max(0, group.endedAtMs - group.startedAtMs)
				: undefined,
			completedAtMs: group.endedAtMs,
			usage: sumUsage(group.usageByKey),
			contextGrowth: this.showContextGrowth() && group.agentTurnIds.length > 0 ? this.contextGrowth.getRun(group.groupId, group.agentTurnIds) : undefined,
			active,
			displayRows,
			activeOverflow: Math.max(0, activeAll.length - ACTIVE_ROW_LIMIT),
			failed,
			failedCount: grouped.filter((entry) => entry.state === "failed").length,
			steerCount: group.steers.length,
			pinnedSteers: group.settled
				? []
				: group.steers.map((steer) => ({ id: steer.id, firstLine: steer.firstLine })),
			toolSummaries: [...summaries.values()],
		};
	}

	private markGroupSawToolBatch(groupId = this.activeGroupId): void {
		if (!groupId) return;
		const group = this.groupsById.get(groupId);
		if (group) group.hasSeenToolBatch = true;
	}

	private maybeSettleFromTerminalAssistant(message: unknown): void {
		if (!isAssistantTerminal(message)) return;
		this.customBoundary = true;
		const group = this.activeGroupId ? this.groupsById.get(this.activeGroupId) : undefined;
		if (!group) return;
		if (group.members.some((member) => member.state === "pending" || member.state === "running")) {
			return;
		}
		group.settled = true;
	}

	private ensureGroup(groupId: string): AggregateGroup {
		let group = this.groupsById.get(groupId);
		if (!group) {
			group = {
				groupId,
				members: [],
				framedItemIds: [],
				customItemIds: [],
				narrationById: new Map(),
				agentTurnIds: [],
				usageByKey: new Map(),
				steers: [],
				hasSeenToolBatch: false,
				settled: false,
			};
			this.groups.push(group);
			this.groupsById.set(groupId, group);
		}
		return group;
	}

	private ensureActiveGroup(): AggregateGroup {
		if (!this.activeGroupId) this.activeGroupId = `orphan-${++this.liveGroupSequence}`;
		return this.ensureGroup(this.activeGroupId);
	}

	private addOrUpdateMember(
		toolCallId: string,
		toolName: string,
		args: unknown,
		visible: boolean,
	): AggregateMember {
		const existing = this.membersById.get(toolCallId);
		if (existing) {
			existing.args = { ...existing.args, ...toRecord(args) };
			existing.toolName = toolName;
			const becameVisible = !existing.visible && visible;
			existing.visible ||= visible;
			const turnId = this.groupsById.get(existing.groupId)?.agentTurnIds.at(-1);
			if (turnId) existing.agentTurnId ??= turnId;
			if (becameVisible) this.recomputeLeader(existing.groupId);
			return existing;
		}

		const group = this.ensureActiveGroup();
		group.hasSeenToolBatch = true;
		this.evictOldestRetainedDone(group);
		const previousLeader = group.leaderToolCallId;
		const member: AggregateMember = {
			toolCallId,
			toolName,
			groupId: group.groupId,
			sourceOrder: this.sourceOrder++,
			args: { ...toRecord(args) },
			state: "pending",
			visible,
			agentTurnId: group.agentTurnIds.at(-1),
		};
		group.members.push(member);
		this.membersById.set(toolCallId, member);
		if (visible && !this.isPassthrough(toolName)) {
			this.trackFramedItem(toolCallId, group.groupId);
			group.leaderToolCallId = toolCallId;
		}
		this.invalidateIds(previousLeader, group.leaderToolCallId);
		return member;
	}

	private evictOldestRetainedDone(group: AggregateGroup): void {
		const oldest = group.members
			.filter((member) => member.retainedDone)
			.sort((left, right) =>
				(left.completionOrder ?? Number.MAX_SAFE_INTEGER) -
				(right.completionOrder ?? Number.MAX_SAFE_INTEGER),
			)[0];
		if (!oldest) return;
		oldest.retainedDone = false;
		oldest.completionOrder = undefined;
	}

	private trimRetainedDone(groupId: string): void {
		const group = this.groupsById.get(groupId);
		if (!group) return;
		while (group.members.filter((member) => member.retainedDone).length > ACTIVE_ROW_LIMIT) {
			this.evictOldestRetainedDone(group);
		}
	}

	private recomputeLeader(groupId: string): void {
		const group = this.groupsById.get(groupId);
		if (!group) return;
		const previousLeader = group.leaderToolCallId;
		group.leaderToolCallId = [...group.members]
			.reverse()
			.find((member) =>
				member.visible &&
				member.state !== "needsAttention" &&
				!this.isPassthrough(member.toolName),
			)?.toolCallId;
		this.invalidateIds(previousLeader, group.leaderToolCallId);
	}

	private invalidateGroup(groupId: string, changedId?: string): void {
		const group = this.groupsById.get(groupId);
		this.invalidateIds(group?.leaderToolCallId, group && this.collapsedHost(group), changedId);
	}

	private invalidateIds(...ids: Array<string | undefined>): void {
		const requested = new Set(ids.filter((entry): entry is string => Boolean(entry)));
		if (requested.size === 0) return;
		for (const id of requested) {
			try {
				this.invalidators.get(id)?.();
			} catch {
				// Rendering must remain fail-open if a stale component rejects invalidation.
			}
		}
		for (const [id, invalidate] of this.frameInvalidators) {
			if (!requested.has(id)) continue;
			try {
				invalidate();
			} catch {
				// A stale transcript component may already be disposed.
			}
		}
	}

	private invalidateAll(): void {
		const turnIds = new Set(this.groups.flatMap((group) => group.agentTurnIds));
		for (const id of this.contextInvalidators.keys()) {
			if (!turnIds.has(id)) this.contextInvalidators.delete(id);
		}
		for (const invalidate of [...this.invalidators.values(), ...this.contextInvalidators.values(), ...this.frameInvalidators.values()]) {
			try {
				invalidate();
			} catch {
				// Ignore stale render contexts after session replacement.
			}
		}
	}
}

function memberStatusChrome(
	member: Pick<AggregateMember, "state" | "errorSummary" | "agentReceipt">,
	theme: AggregateRenderTheme,
): { marker: string; detail?: string; receiptLabel?: string } {
	if (member.state === "failed") {
		return {
			marker: theme.fg("error", "!"),
			detail: member.errorSummary ?? "Tool failed.",
		};
	}
	if (member.state === "success" && member.agentReceipt) {
		const chrome = agentReceiptChrome(member.agentReceipt);
		return { marker: theme.fg(chrome.color, chrome.marker), receiptLabel: chrome.label };
	}
	if (member.state === "success") return { marker: theme.fg("success", "✓") };
	return { marker: theme.fg("warning", "◐") };
}

function appendTruncationMark(row: string, width: number): string {
	const mark = "…";
	return `${truncateToWidth(row, Math.max(0, width - visibleWidth(mark)), "")}${mark}`;
}

function renderBoundedCallRows(
	member: Pick<AggregateMember, "toolName" | "args" | "state" | "errorSummary" | "agentReceipt">,
	contentWidth: number,
	theme: AggregateRenderTheme,
	options: {
		indent?: string;
		maxRows: number;
		timing?: string;
		includeFailureDetail?: boolean;
	},
): string[] {
	const safeWidth = Math.max(1, Math.floor(contentWidth));
	const rowLimit = Math.max(1, Math.floor(options.maxRows));
	const indent = options.indent ?? "";
	const { marker, detail, receiptLabel } = memberStatusChrome(member, theme);
	const callPrefix = `${indent}${marker} `;
	const continuation = " ".repeat(visibleWidth(callPrefix));
	const requestedTiming = options.timing ?? "";
	const timing = requestedTiming && visibleWidth(requestedTiming) + 2 <= safeWidth
		? requestedTiming
		: "";
	const timingReserve = timing ? visibleWidth(timing) + 2 : 0;
	const firstLabelWidth = Math.max(1, safeWidth - visibleWidth(callPrefix) - timingReserve);
	const includeDetail = options.includeFailureDetail !== false && Boolean(detail);
	const labelRowLimit = Math.max(1, rowLimit - (includeDetail ? 1 : 0));
	const moveLabelBelowTiming = Boolean(timing) && firstLabelWidth < 8 && labelRowLimit > 1;
	const labelWidth = moveLabelBelowTiming
		? Math.max(1, safeWidth - visibleWidth(continuation))
		: firstLabelWidth;
	const availableLabelRows = labelRowLimit - (moveLabelBelowTiming ? 1 : 0);
	const label = member.toolName === "bash"
		? renderBashLedgerLabel(member.args, theme, labelWidth, availableLabelRows)
		: `${formatColoredTarget(member, theme)}${receiptLabel ? theme.fg("muted", ` · ${receiptLabel}`) : ""}`;
	const labelLayout = layoutPreviewRows([label], availableLabelRows, labelWidth);
	const labelRows = labelLayout.rows.length > 0 ? [...labelLayout.rows] : [""];
	if (labelLayout.longLineTruncated || labelLayout.rowLimitReached) {
		const last = labelRows.length - 1;
		labelRows[last] = appendTruncationMark(labelRows[last] ?? "", labelWidth);
	}
	const lines = moveLabelBelowTiming
		? [
			composeLedgerCallLine(`${callPrefix}…`, timing, safeWidth),
			...labelRows.map((row) => `${continuation}${row}`),
		]
		: labelRows.map((row, index) => {
			const left = `${index === 0 ? callPrefix : continuation}${row}`;
			return index === 0 ? composeLedgerCallLine(left, timing, safeWidth) : left;
		});

	const detailRowBudget = Math.min(FAILED_DETAIL_ROW_LIMIT, rowLimit - lines.length);
	if (includeDetail && detail && detailRowBudget > 0) {
		const detailWidth = Math.max(1, safeWidth - visibleWidth(continuation));
		const detailLayout = layoutPreviewRows(
			[theme.fg("error", detail)],
			detailRowBudget,
			detailWidth,
		);
		const detailRows = detailLayout.rows.length > 0 ? [...detailLayout.rows] : [theme.fg("error", detail)];
		if (detailLayout.longLineTruncated || detailLayout.rowLimitReached) {
			const last = detailRows.length - 1;
			detailRows[last] = appendTruncationMark(detailRows[last] ?? "", detailWidth);
		}
		lines.push(...detailRows.map((row) => `${continuation}${row}`));
	}
	return lines.slice(0, rowLimit);
}

export function framePrefixForEdge(edge: AggregateFrameEdge): string {
	return edge === "end" || edge === "only" ? AGGREGATE_FRAME_END : AGGREGATE_FRAME_CONTINUE;
}

export function applyAggregateGroupFrame(
	lines: readonly string[],
	width: number,
	theme: AggregateRenderTheme,
	edge: AggregateFrameEdge,
): string[] {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (safeWidth === 0 || lines.length === 0) return [];
	const lastIndex = lines.length - 1;
	return lines.map((line, index) => {
		const prefixPlain = index === lastIndex ? framePrefixForEdge(edge) : AGGREGATE_FRAME_CONTINUE;
		const prefix = theme.fg("muted", prefixPlain);
		const contentWidth = Math.max(0, safeWidth - visibleWidth(prefixPlain));
		return `${prefix}${truncateToWidth(line, contentWidth, "…")}`;
	});
}

export function padAggregateBlock(lines: readonly string[]): string[] {
	return lines.length > 0 ? ["", ...lines, ""] : [];
}

export function attachExpandedAggregateSummary(
	header: readonly string[],
	detail: readonly string[],
): string[] {
	if (header.length === 0) return [...detail];
	if (detail.length === 0) return padAggregateBlock(header);
	return ["", ...header, ...detail];
}

export function renderAggregateMemberRow(
	member: Pick<AggregateMember, "toolName" | "args" | "state" | "errorSummary" | "startedAtMs" | "endedAtMs" | "agentReceipt">,
	width: number,
	theme: AggregateRenderTheme,
	edge: AggregateFrameEdge = "only",
	nowMs = Date.now(),
): string[] {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (safeWidth === 0) return [];
	const contentWidth = Math.max(1, safeWidth - visibleWidth(framePrefixForEdge(edge)));
	return applyAggregateGroupFrame(
		renderBoundedCallRows(member, contentWidth, theme, {
			maxRows: EXPANDED_CALL_ROW_LIMIT,
			timing: formatMemberTiming(member, theme, nowMs),
		}),
		safeWidth,
		theme,
		edge,
	);
}

export function renderExpandedAggregateMember(
	member: Pick<AggregateMember, "toolName" | "args" | "state" | "errorSummary" | "startedAtMs" | "endedAtMs" | "agentReceipt">,
	width: number,
	theme: AggregateRenderTheme,
	edge: AggregateFrameEdge = "only",
	nowMs = Date.now(),
	turn?: ExpandedTurnPresentation,
): string[] {
	if (turn === undefined) return renderAggregateMemberRow(member, width, theme, edge, nowMs);
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (safeWidth === 0) return [];
	const indent = turn.indent === true ? "  " : "";
	const inner: string[] = [];
	if (turn.leadingBlank === true) inner.push("");
	if (turn.header) inner.push(turn.header);
	inner.push(...renderBoundedCallRows(
		member,
		Math.max(1, safeWidth - visibleWidth(framePrefixForEdge(edge))),
		theme,
		{ indent, maxRows: EXPANDED_CALL_ROW_LIMIT },
	));
	return applyAggregateGroupFrame(inner, safeWidth, theme, edge);
}

export function renderAggregateActivity(
	view: AggregateActivityView,
	width: number,
	theme: AggregateRenderTheme,
	nowMs = Date.now(),
): string[] {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (safeWidth === 0) return [];
	const hasFailure = view.failedCount > 0;
	const marker = hasFailure ? "!" : view.hasRunning ? "◐" : view.callCount ? "✓" : "•";
	const markerColor = hasFailure ? "error" : view.hasRunning ? "warning" : view.callCount ? "success" : "muted";
	const parts: string[] = [];
	if (view.callCount || !view.customMessageCount) {
		parts.push(`${view.callCount} ${pluralize(view.callCount, "call")}`, `${view.agentTurnCount} ${pluralize(view.agentTurnCount, "turn")}`);
	}
	if (view.customMessageCount) parts.push(`${view.customMessageCount} ${pluralize(view.customMessageCount, "message")}`);
	const totals = theme.fg("muted", ` (${parts.join(" · ")})`);
	let header = `${theme.fg(markerColor, marker)} ${theme.fg("toolTitle", theme.bold?.("Run") ?? "Run")}${totals}`;
	if (hasFailure) header += theme.fg("error", ` · ${view.failedCount} failed`);
	for (const summary of view.toolSummaries) {
		header += theme.fg("muted", " · ");
		header += theme.fg(toolColor(summary.toolName), `${summary.toolName} ×${summary.count}`);
	}

	const lines = [truncateToWidth(header, safeWidth, "…")];
	if (view.settled) {
		lines.push(...renderSettledSteerReminder(view.steerCount ?? 0, safeWidth, theme));
	} else {
		lines.push(...renderCollapsedSteerPins(view.pinnedSteers ?? [], safeWidth, theme));
	}
	const stats = formatAggregateStatsLine(view);
	if (stats) {
		lines.push(truncateToWidth(`  ${theme.fg("muted", stats)}`, safeWidth, "…"));
	}
	if (!view.settled && view.latestNarration) {
		lines.push(...renderCollapsedAssistantNarration(view.latestNarration, safeWidth, theme));
	}
	for (const row of view.displayRows) {
		lines.push(...renderBoundedCallRows(row, safeWidth, theme, {
			indent: "  ",
			maxRows: COLLAPSED_CALL_ROW_LIMIT,
			timing: formatMemberTiming(row, theme, nowMs),
			includeFailureDetail: false,
		}));
	}
	if (view.activeOverflow > 0) {
		lines.push(
			truncateToWidth(theme.fg("muted", `  … ${view.activeOverflow} more active`), safeWidth, "…"),
		);
	}
	return lines;
}

export function renderExpandedAggregateSummary(view: AggregateActivityView, width: number, theme: AggregateRenderTheme): string[] {
	// Expanded rows already contain these notes, steers and calls in source order.
	return renderAggregateActivity({ ...view, latestNarration: undefined, displayRows: [], activeOverflow: 0, pinnedSteers: [] }, width, theme);
}

function getToolExecutionPrototype(): PatchableToolExecutionPrototype {
	return ToolExecutionComponent.prototype as unknown as PatchableToolExecutionPrototype;
}

function createComponentInvalidator(component: PatchableToolExecution): () => void {
	return () => {
		try {
			component.invalidate?.();
			component.ui?.requestRender?.();
		} catch {
			// A stale transcript component may already be disposed.
		}
	};
}

function stampLiveExecutionStart(component: PatchableToolExecution, fallback?: AggregateProjection): void {
	const toolName = normalizeToolName(component.toolName);
	const toolCallId = typeof component.toolCallId === "string" ? component.toolCallId : undefined;
	if (!toolName || !toolCallId) return;
	const projection = resolveAggregateProjection(undefined, toolCallId) ?? fallback;
	projection?.markStarted(toolCallId, toolName, component.args);
}

function stampLiveExecutionEnd(
	component: PatchableToolExecution,
	result: { isError?: boolean } & Record<string, unknown>,
	fallback?: AggregateProjection,
): void {
	const toolCallId = typeof component.toolCallId === "string" ? component.toolCallId : undefined;
	if (!toolCallId) return;
	const projection = resolveAggregateProjection(undefined, toolCallId) ?? fallback;
	projection?.markComplete(toolCallId, result, result.isError === true);
}

function installExecutionClockHooks(
	prototype: PatchableToolExecutionPrototype,
	state: AggregateToolExecutionPatchState,
): void {
	// These delegates are rebound on module takeover; outer wrappers keep their identity.
	state.onExpanded = function(expanded) {
		const projection = resolveAggregateProjection(undefined, this.toolCallId) ?? state.projection;
		if (projection && typeof this.toolName === "string" && !projection.isPassthrough(this.toolName)) projection.noteTimelineExpansion(expanded);
	};
	state.onStarted = function() { stampLiveExecutionStart(this, state.projection); };
	state.onEnded = function(result) { stampLiveExecutionEnd(this, result, state.projection); };
	if (!state.patchedSetExpanded && typeof prototype.setExpanded === "function") {
		state.originalSetExpanded = prototype.setExpanded;
		state.patchedSetExpanded = function noteGlobalToolExpansion(expanded): void {
			state.originalSetExpanded?.call(this, expanded);
			state.onExpanded?.call(this, expanded);
		};
		prototype.setExpanded = state.patchedSetExpanded;
	}
	if (!state.patchedMarkExecutionStarted && typeof prototype.markExecutionStarted === "function") {
		state.originalMarkExecutionStarted = prototype.markExecutionStarted;
		state.patchedMarkExecutionStarted = function markAggregateExecutionStarted(): void {
			state.onStarted?.call(this);
			state.originalMarkExecutionStarted?.call(this);
		};
		prototype.markExecutionStarted = state.patchedMarkExecutionStarted;
	}
	if (!state.patchedUpdateResult && typeof prototype.updateResult === "function") {
		state.originalUpdateResult = prototype.updateResult;
		state.patchedUpdateResult = function markAggregateExecutionEnded(result, isPartial = false): void {
			state.originalUpdateResult?.call(this, result, isPartial);
			if (isPartial !== true) state.onEnded?.call(this, result);
		};
		prototype.updateResult = state.patchedUpdateResult;
	}
}

export function patchAggregateToolExecutions(projection: AggregateProjection): void {
	if (TOOL_MODULE.retired) return;
	claimHostProjection(undefined, projection);
	const prototype = getToolExecutionPrototype();
	const legacy = prototype[LEGACY_TOOL_EXECUTION_PATCH_KEY];
	if (legacy) {
		legacy.projection = undefined;
		if (prototype.render === legacy.patchedRender) prototype.render = legacy.originalRender;
		if (prototype.setExpanded === legacy.patchedSetExpanded) prototype.setExpanded = legacy.originalSetExpanded;
		if (prototype.markExecutionStarted === legacy.patchedMarkExecutionStarted) prototype.markExecutionStarted = legacy.originalMarkExecutionStarted;
		if (prototype.updateResult === legacy.patchedUpdateResult) prototype.updateResult = legacy.originalUpdateResult;
	}
	let existing = prototype[AGGREGATE_TOOL_EXECUTION_PATCH_KEY];
	if (existing?.owner === TOOL_MODULE && !existing.projection && prototype.render !== existing.patchedRender) {
		// An earlier wrapper may have restored the native method before our cleanup.
		delete prototype[AGGREGATE_TOOL_EXECUTION_PATCH_KEY];
		existing = undefined;
	}
	if (existing && existing.owner !== TOOL_MODULE) existing.releaseOwner();
	patchAggregateViewport();
	patchAggregateCustomMessages();
	patchAggregateMouseHandling(prototype);
	patchAggregateGlobalExpansion((expanded) => getActiveAggregateProjection()?.noteTimelineExpansion(expanded));
	const state = existing ?? {} as AggregateToolExecutionPatchState;
	if (!existing) {
		state.originalRender = prototype.render as AggregateToolExecutionPatchState["originalRender"];
		state.patchedRender = function(width) { return state.renderImpl.call(this, width); };
	}
	state.owner = TOOL_MODULE;
	state.releaseOwner = () => {
		TOOL_MODULE.retired = true;
		hostAggregateProjection = undefined;
		liveProjections.clear();
	};
	state.projection = hostAggregateProjection ?? projection;
	state.renderImpl = function renderAggregateToolExecution(width: number): string[] {
		releaseAggregateClickRegions(this);
		const toolName = normalizeToolName(this.toolName);
		const toolCallId = typeof this.toolCallId === "string" ? this.toolCallId : undefined;
		const activeProjection = resolveAggregateProjection(undefined, toolCallId)
			?? state.projection;
		if (!activeProjection || !toolName || !toolCallId) {
			return state.originalRender.call(this, width);
		}
		activeProjection.connectRenderer(
			toolCallId,
			toolName,
			this.args,
			createComponentInvalidator(this),
		);
		if (activeProjection.isPassthrough(toolName)) {
			const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
			const inset = visibleWidth(framePrefixForEdge("only"));
			if (safeWidth <= inset) {
				recordAggregateClickRegions(this, safeWidth, 0);
				return [];
			}
			const bodyWidth = safeWidth - inset;
			const native = state.originalRender.call(this, bodyWidth);
			recordAggregateNativeRegion(this, safeWidth, native.length, {
				left: inset, top: 0, width: bodyWidth, height: native.length,
			});
			return native.map((line) => " ".repeat(inset) + line);
		}
		recordAggregateClickRegions(this, width, 0);
		if (!activeProjection.isInitialized()) return [];
		const member = activeProjection.getMember(toolCallId);
		if (member?.state === "needsAttention") {
			releaseAggregateClickRegions(this);
			return state.originalRender.call(this, width);
		}
		if (!member) return [];
		const view = activeProjection.getView(toolCallId);
		const regions: AggregateClickRegion[] = [];
		const run = activeProjection.getViewportRun(toolCallId);
		const toggle = () => activeProjection.toggleGroupExpansionFromComponent(toolCallId, this);
		if (activeProjection.isItemExpanded(toolCallId, this.expanded === true)) {
			const detail = activeProjection.renderExpandedToolRowLayout(toolCallId, width);
			let lines = detail.lines;
			let offset = 0;
			if (activeProjection.shouldHostExpandedSummary(toolCallId)) {
				const headerView = activeProjection.getViewForGroup(toolCallId);
				if (headerView) {
					const header = renderExpandedAggregateSummary(headerView, width, activeProjection.getRenderTheme());
					lines = attachExpandedAggregateSummary(header, detail.lines);
					offset = 1 + header.length;
					regions.push({ startRow: 1, endRow: offset, onClick: toggle });
				}
			}
			regions.push({ startRow: offset + detail.callStart, endRow: lines.length, onClick: () => activeProjection.openDetail({
				kind: "tool", toolName, target: formatAggregateTarget(member), args: this.args, result: this.result,
				status: member.state, timing: formatMemberTiming(member, PLAIN_THEME),
			}) });
			recordAggregateClickRegions(this, width, lines.length, regions, run ? { run, ...(offset > 0 ? { titleRow: 1 } : {}) } : undefined);
			return lines;
		}
		if (!view) return [];
		const lines = padAggregateBlock(renderAggregateActivity(view, width, activeProjection.getRenderTheme()));
		recordAggregateClickRegions(this, width, lines.length, [{ startRow: 1, endRow: lines.length - 1, onClick: toggle }], run ? { run, titleRow: 1 } : undefined);
		return lines;
	};
	Object.defineProperty(prototype, AGGREGATE_TOOL_EXECUTION_PATCH_KEY, {
		configurable: true,
		value: state,
	});
	if (!existing) prototype.render = state.patchedRender;
	installExecutionClockHooks(prototype, state);
}

export function restoreAggregateToolExecutions(): void {
	restoreAggregateViewport();
	hostAggregateProjection = undefined;
	liveProjections.clear();
	const prototype = getToolExecutionPrototype();
	const state = prototype[AGGREGATE_TOOL_EXECUTION_PATCH_KEY];
	if (state && state.owner !== TOOL_MODULE) return;
	restoreAggregateCustomMessages();
	restoreAggregateMouseHandling(prototype);
	restoreAggregateGlobalExpansion();
	if (!state) return;
	state.renderImpl = state.originalRender;
	state.onExpanded = undefined;
	state.onStarted = undefined;
	state.onEnded = undefined;
	state.projection = undefined;
	if (prototype.render === state.patchedRender) {
		prototype.render = state.originalRender;
		if (state.patchedSetExpanded && prototype.setExpanded === state.patchedSetExpanded) {
			prototype.setExpanded = state.originalSetExpanded;
		}
		if (state.patchedMarkExecutionStarted && prototype.markExecutionStarted === state.patchedMarkExecutionStarted) {
			prototype.markExecutionStarted = state.originalMarkExecutionStarted;
		}
		if (state.patchedUpdateResult && prototype.updateResult === state.patchedUpdateResult) {
			prototype.updateResult = state.originalUpdateResult;
		}
		delete prototype[AGGREGATE_TOOL_EXECUTION_PATCH_KEY];
		return;
	}
	state.projection = undefined;
}

function rebuildProjectionFromContext(projection: AggregateProjection, ctx: SessionContextLike): void {
	const sessionManager = ctx?.sessionManager;
	if (!sessionManager) return;
	let visibleMessages: unknown[] | undefined;
	try {
		visibleMessages = sessionManager.buildSessionContext?.().messages;
	} catch {
		visibleMessages = undefined;
	}
	projection.rebuild(sessionManager.buildContextEntries?.() ?? sessionManager.getBranch(), visibleMessages);
}

export function registerAggregateProjectionEvents(
	pi: ExtensionAPI,
	projection: AggregateProjection,
	options: { doneSettleDelayMs?: number; getConfig?: () => ToolDisplayConfig } = {},
): void {
	if (registeredApis.has(pi) || TOOL_MODULE.retired) return;
	registeredApis.add(pi);
	const requestedDelay = options.doneSettleDelayMs ?? AGGREGATE_DONE_SETTLE_DELAY_MS;
	const doneSettleDelayMs = Number.isFinite(requestedDelay)
		? Math.max(0, Math.floor(requestedDelay))
		: AGGREGATE_DONE_SETTLE_DELAY_MS;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	const collapseWidget = createAggregateCollapseWidget(projection);
	const clearSettleTimer = () => {
		if (settleTimer !== undefined) clearTimeout(settleTimer);
		settleTimer = undefined;
	};
	const rebuild = (ctx: SessionContextLike) => {
		clearSettleTimer();
		const uiContext = ctx as ExtensionContext;
		collapseWidget.bind(uiContext);
		projection.setDetailOpener(uiContext?.hasUI !== false && typeof uiContext?.ui?.custom === "function"
			? async (request) => {
				const { openDetailViewer } = await import("./detail-viewer.js");
				await openDetailViewer(uiContext, request, options.getConfig?.());
			}
			: undefined);
		rebuildProjectionFromContext(projection, ctx);
		bindExistingAggregateCustomMessages(uiContext, projection);
	};
	const adoptHostIfNeeded = () => {
		// A later session may keep its own ledger, but must not steal the host
		// prototype pointer or rebuild the already-painting host projection.
		if (!TOOL_MODULE.retired && claimHostProjection(pi, projection)) patchAggregateToolExecutions(projection);
	};

	pi.on("session_shutdown", async () => {
		clearSettleTimer();
		collapseWidget.dispose();
		projection.clearViewportState();
		projection.setDetailOpener(undefined);
		const wasHost = hostAggregateProjection === projection;
		forgetProjection(pi, projection);
		// The UI host owns shared rendering, not the last lingering child session.
		if (wasHost) restoreAggregateToolExecutions();
		registeredApis.delete(pi);
	});
	const bindSession = (ctx: SessionContextLike) => {
		if (TOOL_MODULE.retired) return;
		if (ctx?.hasUI === false) forgetProjection(pi, projection);
		else adoptHostIfNeeded();
		rebuild(ctx);
	};
	pi.on("session_start", async (_event, ctx) => bindSession(ctx));
	pi.on("before_agent_start", async (_event, ctx) => bindSession(ctx));
	pi.on("session_compact", async (_event, ctx) => rebuild(ctx));
	pi.on("session_tree", async (_event, ctx) => rebuild(ctx));
	let pendingStreamingBehavior: "steer" | "followUp" | undefined;
	pi.on("input", async (event) => {
		pendingStreamingBehavior = event.streamingBehavior;
	});
	pi.on("message_start", async (event) => {
		if (messageRole(event.message) === "assistant") projection.ingestAssistantMessage(event.message);
		if (messageRole(event.message) === "user") {
			clearSettleTimer();
			const behavior = pendingStreamingBehavior;
			pendingStreamingBehavior = undefined;
			projection.ingestUserMessage(event.message, { streamingBehavior: behavior });
		}
	});
	pi.on("message_update", async (event) => projection.ingestAssistantMessage(event.message));
	pi.on("message_end", async (event) => {
		const role = messageRole(event.message);
		if (role === "assistant") projection.ingestAssistantMessage(event.message);
		else if (role === "toolResult") projection.ingestToolResult(event.message);
	});
	pi.on("turn_end", async (event, ctx) => {
		projection.finishContextTurn(event.message, event.toolResults, ctx?.sessionManager?.getBranch());
	});
	pi.on("tool_execution_start", async (event) => {
		clearSettleTimer();
		projection.markStarted(event.toolCallId, event.toolName, event.args);
	});
	pi.on("tool_execution_update", async (event) => projection.markUpdated(event.toolCallId, event.args));
	pi.on("tool_execution_end", async (event) => {
		projection.markComplete(event.toolCallId, event.result, event.isError === true);
	});
	pi.on("agent_settled", async () => {
		projection.markUnsettledInterrupted();
		projection.markGroupSettled();
		clearSettleTimer();
		settleTimer = setTimeout(() => {
			settleTimer = undefined;
			projection.collapseRetainedDone();
		}, doneSettleDelayMs);
		settleTimer.unref?.();
	});
}
