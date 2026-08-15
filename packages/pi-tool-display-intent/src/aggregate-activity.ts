import {
	getMarkdownTheme,
	ToolExecutionComponent,
	type ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import { normalizeDisplaySummary } from "./display-summary.js";
import { onReloadShutdown } from "./extension-lifecycle.js";
import { shortenPath } from "./render-utils.js";

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
}

export interface AggregateGroup {
	groupId: string;
	leaderToolCallId?: string;
	members: AggregateMember[];
	framedItemIds: string[];
}

export type AggregateFrameEdge = "start" | "continue" | "end" | "only";

export interface AggregateToolSummary {
	toolName: string;
	count: number;
	lastTarget: string;
}

export interface AggregateActivityView {
	groupId: string;
	leaderToolCallId: string;
	hasRunning: boolean;
	active: AggregateMember[];
	displayRows: AggregateMember[];
	activeOverflow: number;
	failed: AggregateMember[];
	failedCount: number;
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
	sessionManager?: {
		getBranch(): unknown[];
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

interface FrameInvalidator {
	id: string;
	invalidate: () => void;
}

interface PatchableToolExecutionPrototype {
	render(width: number): string[];
	[AGGREGATE_TOOL_EXECUTION_PATCH_KEY]?: AggregateToolExecutionPatchState;
}

interface AggregateToolExecutionPatchState {
	originalRender: (this: PatchableToolExecution, width: number) => string[];
	patchedRender: (this: PatchableToolExecution, width: number) => string[];
	projection?: AggregateProjection;
}

const FAILED_SUMMARY_MAX_LENGTH = 200;
const ACTIVE_ROW_LIMIT = 3;
const AGGREGATE_FRAME_CONTINUE = "  │ ";
const AGGREGATE_FRAME_END = "  └ ";
export const AGGREGATE_ASSISTANT_MARK = "✦";
export const AGGREGATE_DONE_SETTLE_DELAY_MS = 1_500;
export const DEFAULT_AGGREGATE_RENDER_PASSTHROUGH = ["Agent"] as const;

const AGGREGATE_TOOL_EXECUTION_PATCH_KEY = Symbol.for(
	"pi-tool-display-intent.aggregate-tool-execution.v1",
);
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

export function aggregateResultHasImage(result: unknown): boolean {
	const content = toRecord(result).content;
	return Array.isArray(content) && content.some((entry) => toRecord(entry).type === "image");
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

export function formatAggregateTarget(
	member: Pick<AggregateMember, "toolName" | "args">,
): string {
	const args = member.args;
	const path = shortenPath(getPath(args) ?? ".");
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
		case "bash":
			return `Bash(${normalizeTargetText(args.command, "command")})`;
		case "edit":
			return `Edit(${path})`;
		case "write":
			return `Write(${path})`;
		default:
			return member.toolName;
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
	return messageContent(value).some((entry) => {
		const content = toRecord(entry);
		return content.type === "text" && typeof content.text === "string" && Boolean(content.text.trim());
	});
}

function isInterimAssistantMessage(value: unknown): boolean {
	const reason = toRecord(value).stopReason;
	if (reason === "error" || reason === "aborted" || reason === "length" || reason === "stop") return false;
	if (reason === "toolUse") return true;
	if (toolCallsFromMessage(value).length > 0) return true;
	return messageContent(value).some((entry) => {
		const content = toRecord(entry);
		return content.type === "thinking" && typeof content.thinking === "string" && Boolean(content.thinking.trim());
	});
}

export function aggregateAssistantFrameId(message: unknown): string | undefined {
	const firstToolId = toolCallsFromMessage(message)[0]?.id;
	if (firstToolId) return `assistant-before:${firstToolId}`;
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
	return record.type === "message" ? record.message : undefined;
}

function entryId(entry: unknown, fallback: string): string {
	const id = toRecord(entry).id;
	return typeof id === "string" ? id : fallback;
}

function isAssistantTerminalFailure(message: unknown): boolean {
	const reason = toRecord(message).stopReason;
	return reason === "aborted" || reason === "error";
}

function assistantFailureSummary(message: unknown): string {
	const record = toRecord(message);
	if (record.stopReason === "aborted") return "Operation aborted.";
	return normalizeDisplaySummary(record.errorMessage, FAILED_SUMMARY_MAX_LENGTH) ?? "Assistant turn failed.";
}

let activeAggregateProjection: AggregateProjection | undefined;

export function getActiveAggregateProjection(): AggregateProjection | undefined {
	return activeAggregateProjection;
}

export function resolveAggregateRenderTheme(): AggregateRenderTheme {
	return activeAggregateProjection?.getRenderTheme() ?? publicThemeFallback();
}

export class AggregateProjection {
	private readonly groups: AggregateGroup[] = [];
	private readonly groupsById = new Map<string, AggregateGroup>();
	private readonly membersById = new Map<string, AggregateMember>();
	private readonly framedGroupById = new Map<string, string>();
	private readonly frameInvalidators: FrameInvalidator[] = [];
	private readonly invalidators = new Map<string, () => void>();
	private sourceOrder = 0;
	private completionOrder = 0;
	private liveGroupSequence = 0;
	private activeGroupId: string | undefined;
	private initialized = false;
	private renderTheme: AggregateRenderTheme | undefined;

	constructor(private readonly isPassthroughTool: (toolName: string) => boolean = () => false) {}

	isInitialized(): boolean {
		return this.initialized;
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

	getGroups(): readonly AggregateGroup[] {
		return this.groups;
	}

	getMember(toolCallId: string): AggregateMember | undefined {
		return this.membersById.get(toolCallId);
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
		return groupId ? [...(this.groupsById.get(groupId)?.framedItemIds ?? [])] : [];
	}

	isFrameStart(itemId: string): boolean {
		const edge = this.getFrameEdge(itemId);
		return edge === "start" || edge === "only";
	}

	getViewForGroup(itemId: string): AggregateActivityView | undefined {
		const groupId = this.framedGroupById.get(itemId) ?? this.membersById.get(itemId)?.groupId;
		if (!groupId) return undefined;
		const group = this.groupsById.get(groupId);
		if (!group?.leaderToolCallId) return undefined;
		return this.getView(group.leaderToolCallId);
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
		if (this.frameInvalidators.some((entry) => entry.id === itemId && entry.invalidate === invalidate)) return;
		this.frameInvalidators.push({ id: itemId, invalidate });
	}

	getConnectedRendererCount(): number {
		return this.invalidators.size;
	}

	startUserGroup(groupId?: string): string {
		this.collapseRetainedDone();
		const resolvedId = groupId || `live-user-${++this.liveGroupSequence}`;
		this.ensureGroup(resolvedId);
		this.activeGroupId = resolvedId;
		this.initialized = true;
		return resolvedId;
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
		const calls = toolCallsFromMessage(message);
		if (isInterimAssistantMessage(message) && messageHasVisibleText(message)) {
			const frameId = aggregateAssistantFrameId(message);
			if (frameId) this.trackFramedItem(frameId, this.activeGroupId, calls[0]?.id);
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
	}

	markStarted(toolCallId: string, toolName: string, args: unknown): void {
		const normalizedName = normalizeToolName(toolName);
		if (!normalizedName) return;
		const member = this.addOrUpdateMember(toolCallId, normalizedName, args, true);
		if (!member || member.state === "needsAttention") return;
		member.state = "running";
		member.retainedDone = false;
		member.completionOrder = undefined;
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
		options: { retainDone?: boolean } = {},
	): void {
		const member = this.membersById.get(toolCallId);
		if (!member) return;
		if (aggregateResultHasImage(result)) {
			this.markNeedsAttention(toolCallId);
			return;
		}
		if (isError) {
			this.markFailed(toolCallId, firstMeaningfulLine(result, "Tool failed."));
			return;
		}

		const firstSuccess = member.state !== "success";
		member.state = "success";
		member.errorSummary = undefined;
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

	markFailed(toolCallId: string, summary: string): void {
		const member = this.membersById.get(toolCallId);
		if (!member || member.state === "needsAttention") return;
		member.state = "failed";
		member.errorSummary = normalizeDisplaySummary(summary, FAILED_SUMMARY_MAX_LENGTH) ?? "Tool failed.";
		member.retainedDone = false;
		member.completionOrder = undefined;
		this.invalidateGroup(member.groupId, toolCallId);
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
		const visibleIds = collectVisibleToolCallIds(visibleMessages);
		this.groups.length = 0;
		this.groupsById.clear();
		this.membersById.clear();
		this.framedGroupById.clear();
		this.frameInvalidators.length = 0;
		this.sourceOrder = 0;
		this.completionOrder = 0;
		this.activeGroupId = undefined;

		let fallbackGroupIndex = 0;
		for (const entry of Array.isArray(branchEntries) ? branchEntries : []) {
			const message = entryMessage(entry);
			if (!message) continue;
			const role = messageRole(message);
			if (role === "user") {
				this.activeGroupId = entryId(entry, `restored-user-${++fallbackGroupIndex}`);
				this.ensureGroup(this.activeGroupId);
				continue;
			}
			if (role === "assistant") {
				this.ingestAssistantMessage(message);
				for (const call of toolCallsFromMessage(message)) {
					const member = this.membersById.get(call.id);
					if (!member) continue;
					const visible = visibleIds?.has(call.id) ?? true;
					member.visible = visible;
					if (!visible) this.untrackFramedItem(call.id);
				}
				continue;
			}
			if (role === "toolResult") {
				const record = toRecord(message);
				if (typeof record.toolCallId === "string") {
					this.markComplete(record.toolCallId, record, record.isError === true, { retainDone: false });
				}
			}
		}

		this.initialized = true;
		this.markUnsettledInterrupted();
		for (const group of this.groups) this.recomputeLeader(group.groupId);
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
		this.invalidateAll();
	}

	getView(toolCallId: string): AggregateActivityView | undefined {
		const member = this.membersById.get(toolCallId);
		if (!member || member.state === "needsAttention" || this.isPassthrough(member.toolName)) return undefined;
		const group = this.groupsById.get(member.groupId);
		if (!group || group.leaderToolCallId !== toolCallId) return undefined;

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
			leaderToolCallId: toolCallId,
			hasRunning: grouped.some((entry) => entry.state === "pending" || entry.state === "running"),
			active,
			displayRows,
			activeOverflow: Math.max(0, activeAll.length - ACTIVE_ROW_LIMIT),
			failed,
			failedCount: grouped.filter((entry) => entry.state === "failed").length,
			toolSummaries: [...summaries.values()],
		};
	}

	private ensureGroup(groupId: string): AggregateGroup {
		let group = this.groupsById.get(groupId);
		if (!group) {
			group = { groupId, members: [], framedItemIds: [] };
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
			if (becameVisible) this.recomputeLeader(existing.groupId);
			return existing;
		}

		const group = this.ensureActiveGroup();
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
		this.invalidateIds(group?.leaderToolCallId, changedId);
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
		for (const entry of this.frameInvalidators) {
			if (!requested.has(entry.id)) continue;
			try {
				entry.invalidate();
			} catch {
				// A stale transcript component may already be disposed.
			}
		}
	}

	private invalidateAll(): void {
		for (const invalidate of this.invalidators.values()) {
			try {
				invalidate();
			} catch {
				// Ignore stale render contexts after session replacement.
			}
		}
	}
}

function memberStatusChrome(
	member: Pick<AggregateMember, "state" | "errorSummary">,
	theme: AggregateRenderTheme,
): { marker: string; suffix: string } {
	if (member.state === "failed") {
		const detail = member.errorSummary ?? "Tool failed.";
		return {
			marker: theme.fg("error", "!"),
			suffix: theme.fg("error", `: ${detail}`),
		};
	}
	if (member.state === "success") {
		return {
			marker: theme.fg("success", "✓"),
			suffix: "",
		};
	}
	return {
		marker: theme.fg("warning", "◐"),
		suffix: "",
	};
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

export function renderAggregateMemberRow(
	member: Pick<AggregateMember, "toolName" | "args" | "state" | "errorSummary">,
	width: number,
	theme: AggregateRenderTheme,
	edge: AggregateFrameEdge = "only",
): string[] {
	const { marker, suffix } = memberStatusChrome(member, theme);
	return applyAggregateGroupFrame(
		[`${marker} ${formatColoredTarget(member, theme)}${suffix}`],
		width,
		theme,
		edge,
	);
}

export function renderAggregateActivity(
	view: AggregateActivityView,
	width: number,
	theme: AggregateRenderTheme,
): string[] {
	const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
	if (safeWidth === 0) return [];
	const hasFailure = view.failedCount > 0;
	const marker = hasFailure ? "!" : view.hasRunning ? "◐" : "✓";
	const markerColor = hasFailure ? "error" : view.hasRunning ? "warning" : "success";
	let header = `${theme.fg(markerColor, marker)} ${theme.fg("toolTitle", theme.bold?.("Tools") ?? "Tools")}`;
	if (hasFailure) header += theme.fg("error", ` · ${view.failedCount} failed`);
	for (const summary of view.toolSummaries) {
		header += theme.fg("muted", " · ");
		header += theme.fg(toolColor(summary.toolName), `${summary.toolName} ×${summary.count}`);
	}

	const lines = [truncateToWidth(header, safeWidth, "…")];
	for (const row of view.displayRows) {
		if (row.state === "success") {
			lines.push(
				truncateToWidth(
					`  ${theme.fg("success", "✓")} ${formatColoredTarget(row, theme)} ${theme.fg("success", "done")}`,
					safeWidth,
					"…",
				),
			);
			continue;
		}
		lines.push(
			truncateToWidth(
				`  ${theme.fg("warning", "◐")} ${formatColoredTarget(row, theme)}`,
				safeWidth,
				"…",
			),
		);
	}
	if (view.activeOverflow > 0) {
		lines.push(
			truncateToWidth(theme.fg("muted", `  … ${view.activeOverflow} more active`), safeWidth, "…"),
		);
	}
	return lines;
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

export function patchAggregateToolExecutions(projection: AggregateProjection): void {
	activeAggregateProjection = projection;
	const prototype = getToolExecutionPrototype();
	const existing = prototype[AGGREGATE_TOOL_EXECUTION_PATCH_KEY];
	if (existing) {
		if (prototype.render === existing.patchedRender || existing.projection !== undefined) {
			existing.projection = projection;
			return;
		}
		// A wrapper installed before us may restore its own original render after
		// our cleanup, leaving only stale Symbol state. Start a fresh layer over
		// the actual current renderer; the disabled old closure remains harmless
		// if a surviving outer wrapper still references it.
		delete prototype[AGGREGATE_TOOL_EXECUTION_PATCH_KEY];
	}

	const state = {} as AggregateToolExecutionPatchState;
	state.originalRender = prototype.render as AggregateToolExecutionPatchState["originalRender"];
	state.projection = projection;
	state.patchedRender = function renderAggregateToolExecution(width: number): string[] {
		const activeProjection = state.projection;
		const toolName = normalizeToolName(this.toolName);
		const toolCallId = typeof this.toolCallId === "string" ? this.toolCallId : undefined;
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
			return state.originalRender.call(this, width);
		}
		if (aggregateResultHasImage(this.result)) {
			activeProjection.markNeedsAttention(toolCallId);
			return state.originalRender.call(this, width);
		}
		if (!activeProjection.isInitialized()) return [];
		const member = activeProjection.getMember(toolCallId);
		if (member?.state === "needsAttention") return state.originalRender.call(this, width);
		if (!member) return [];
		const view = activeProjection.getView(toolCallId);
		if (this.expanded === true) {
			const detail = renderAggregateMemberRow(
				member,
				width,
				activeProjection.getRenderTheme(),
				activeProjection.getFrameEdge(toolCallId) ?? "only",
			);
			if (activeProjection.isFrameStart(toolCallId)) {
				const headerView = activeProjection.getViewForGroup(toolCallId);
				if (headerView) {
					return [...padAggregateBlock(renderAggregateActivity(headerView, width, activeProjection.getRenderTheme())), ...detail];
				}
			}
			return detail;
		}
		if (!view) return [];
		return padAggregateBlock(renderAggregateActivity(view, width, activeProjection.getRenderTheme()));
	};
	Object.defineProperty(prototype, AGGREGATE_TOOL_EXECUTION_PATCH_KEY, {
		configurable: true,
		value: state,
	});
	prototype.render = state.patchedRender;
}

export function restoreAggregateToolExecutions(): void {
	activeAggregateProjection = undefined;
	const prototype = getToolExecutionPrototype();
	const state = prototype[AGGREGATE_TOOL_EXECUTION_PATCH_KEY];
	if (!state) return;
	if (prototype.render === state.patchedRender) {
		prototype.render = state.originalRender;
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
	projection.rebuild(sessionManager.getBranch(), visibleMessages);
}

export function registerAggregateProjectionEvents(
	pi: ExtensionAPI,
	projection: AggregateProjection,
	options: { doneSettleDelayMs?: number } = {},
): void {
	const requestedDelay = options.doneSettleDelayMs ?? AGGREGATE_DONE_SETTLE_DELAY_MS;
	const doneSettleDelayMs = Number.isFinite(requestedDelay)
		? Math.max(0, Math.floor(requestedDelay))
		: AGGREGATE_DONE_SETTLE_DELAY_MS;
	let settleTimer: ReturnType<typeof setTimeout> | undefined;
	const clearSettleTimer = () => {
		if (settleTimer !== undefined) clearTimeout(settleTimer);
		settleTimer = undefined;
	};
	const rebuild = (ctx: SessionContextLike) => {
		clearSettleTimer();
		rebuildProjectionFromContext(projection, ctx);
	};

	patchAggregateToolExecutions(projection);
	onReloadShutdown(pi, () => {
		clearSettleTimer();
		restoreAggregateToolExecutions();
		registeredApis.delete(pi);
	});
	if (registeredApis.has(pi)) return;
	registeredApis.add(pi);

	pi.on("session_start", async (_event, ctx) => {
		patchAggregateToolExecutions(projection);
		rebuild(ctx);
	});
	pi.on("before_agent_start", async (_event, ctx) => {
		patchAggregateToolExecutions(projection);
		rebuild(ctx);
	});
	pi.on("session_compact", async (_event, ctx) => rebuild(ctx));
	pi.on("session_tree", async (_event, ctx) => rebuild(ctx));
	pi.on("message_start", async (event) => {
		if (messageRole(event.message) === "user") {
			clearSettleTimer();
			const timestamp = toRecord(event.message).timestamp;
			projection.startUserGroup(typeof timestamp === "number" ? `live-user-${timestamp}` : undefined);
		}
	});
	pi.on("message_update", async (event) => projection.ingestAssistantMessage(event.message));
	pi.on("message_end", async (event) => projection.ingestAssistantMessage(event.message));
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
		clearSettleTimer();
		settleTimer = setTimeout(() => {
			settleTimer = undefined;
			projection.collapseRetainedDone();
		}, doneSettleDelayMs);
		settleTimer.unref?.();
	});
}
