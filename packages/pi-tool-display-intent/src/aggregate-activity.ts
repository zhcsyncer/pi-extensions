import type {
	ExtensionAPI,
	ToolRenderResultOptions,
} from "@earendil-works/pi-coding-agent";
import { generateUnifiedPatch } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, type Component } from "@earendil-works/pi-tui";
import { normalizeDisplaySummary } from "./display-summary.js";
import { shortenPath } from "./render-utils.js";

export const AGGREGATE_SAFE_TOOL_NAMES = [
	"read",
	"grep",
	"find",
	"ls",
	"bash",
	"edit",
	"write",
] as const;

export type AggregateSafeToolName = (typeof AGGREGATE_SAFE_TOOL_NAMES)[number];
export type AggregateMemberState =
	| "pending"
	| "running"
	| "success"
	| "failed"
	| "needsAttention";

export interface AggregateDiffStats {
	additions: number;
	deletions: number;
}

export const AGGREGATE_WRITE_DIFF_CUSTOM_TYPE = "pi-tool-display-intent.aggregate-write-diff.v1";

export interface AggregateMember {
	toolCallId: string;
	toolName: AggregateSafeToolName;
	groupId: string;
	sourceOrder: number;
	args: Record<string, unknown>;
	state: AggregateMemberState;
	errorSummary?: string;
	diffStats?: AggregateDiffStats;
	visible: boolean;
}

export interface AggregateGroup {
	groupId: string;
	leaderToolCallId?: string;
	members: AggregateMember[];
}

export interface AggregateActivityView {
	groupId: string;
	leaderToolCallId: string;
	active: AggregateMember[];
	activeOverflow: number;
	failed: AggregateMember[];
	successCounts: Array<{ toolName: AggregateSafeToolName; count: number }>;
	modifiedFiles: string[];
	diffStats?: AggregateDiffStats;
}

interface RenderTheme {
	fg(color: string, text: string): string;
	bold?(text: string): string;
}

interface ToolRenderContextLike {
	args?: unknown;
	toolCallId?: string;
	lastComponent?: unknown;
	invalidate?: () => void;
	isError?: boolean;
	[key: string]: unknown;
}

interface RuntimeToolDefinition {
	name?: string;
	renderCall?: (args: Record<string, unknown>, theme: RenderTheme, context: ToolRenderContextLike) => unknown;
	renderResult?: (
		result: AggregateToolResult,
		options: ToolRenderResultOptions,
		theme: RenderTheme,
		context: ToolRenderContextLike,
	) => unknown;
	renderShell?: unknown;
	[key: string]: unknown;
}

interface AggregateToolResult {
	content?: Array<{ type?: string; text?: string; data?: string; mimeType?: string }>;
	details?: unknown;
	isError?: boolean;
}

interface SessionContextLike {
	sessionManager?: {
		getBranch(): unknown[];
		buildSessionContext?(): { messages?: unknown[] };
	};
}

interface WritePreviousContent {
	fileExistedBeforeWrite: boolean;
	previousContent?: string;
}

const FAILED_SUMMARY_MAX_LENGTH = 200;
const ACTIVE_ROW_LIMIT = 3;

function toRecord(value: unknown): Record<string, unknown> {
	return value && typeof value === "object" && !Array.isArray(value)
		? (value as Record<string, unknown>)
		: {};
}

function isAggregateSafeToolName(value: unknown): value is AggregateSafeToolName {
	return typeof value === "string" && (AGGREGATE_SAFE_TOOL_NAMES as readonly string[]).includes(value);
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

function countPatchStats(patch: unknown): AggregateDiffStats | undefined {
	if (typeof patch !== "string" || !patch) return undefined;
	let additions = 0;
	let deletions = 0;
	for (const line of patch.replace(/\r/g, "").split("\n")) {
		if (line.startsWith("+++") || line.startsWith("---")) continue;
		if (line.startsWith("+")) additions += 1;
		else if (line.startsWith("-")) deletions += 1;
	}
	return additions > 0 || deletions > 0 ? { additions, deletions } : undefined;
}

function getPath(args: unknown): string | undefined {
	const record = toRecord(args);
	const value = record.path ?? record.file_path;
	return typeof value === "string" && value.trim() ? value : undefined;
}

function normalizeTargetText(value: unknown, fallback: string): string {
	return normalizeDisplaySummary(value, 400) ?? fallback;
}

export function formatAggregateTarget(member: Pick<AggregateMember, "toolName" | "args">): string {
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
	}
}

function messageRole(value: unknown): string | undefined {
	const role = toRecord(value).role;
	return typeof role === "string" ? role : undefined;
}

function messageContent(value: unknown): unknown[] {
	const content = toRecord(value).content;
	return Array.isArray(content) ? content : [];
}

function toolCallsFromMessage(value: unknown): Array<{
	id: string;
	name: AggregateSafeToolName;
	args: Record<string, unknown>;
}> {
	return messageContent(value).flatMap((entry) => {
		const content = toRecord(entry);
		if (content.type !== "toolCall" || typeof content.id !== "string" || !isAggregateSafeToolName(content.name)) {
			return [];
		}
		return [{ id: content.id, name: content.name, args: toRecord(content.arguments) }];
	});
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

function persistedWriteDiffFromEntry(entry: unknown): {
	toolCallId: string;
	stats: AggregateDiffStats;
} | undefined {
	const record = toRecord(entry);
	if (record.type !== "custom" || record.customType !== AGGREGATE_WRITE_DIFF_CUSTOM_TYPE) return undefined;
	const data = toRecord(record.data);
	const toolCallId = data.toolCallId;
	const additions = data.additions;
	const deletions = data.deletions;
	if (
		typeof toolCallId !== "string" ||
		!toolCallId ||
		typeof additions !== "number" ||
		!Number.isSafeInteger(additions) ||
		additions < 0 ||
		typeof deletions !== "number" ||
		!Number.isSafeInteger(deletions) ||
		deletions < 0 ||
		(additions === 0 && deletions === 0)
	) {
		return undefined;
	}
	return { toolCallId, stats: { additions, deletions } };
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

export class AggregateProjection {
	private readonly groups: AggregateGroup[] = [];
	private readonly groupsById = new Map<string, AggregateGroup>();
	private readonly membersById = new Map<string, AggregateMember>();
	private readonly invalidators = new Map<string, () => void>();
	private readonly writePreviousById = new Map<string, WritePreviousContent>();
	private readonly persistedWriteDiffStatsById = new Map<string, AggregateDiffStats>();
	private sourceOrder = 0;
	private liveGroupSequence = 0;
	private activeGroupId: string | undefined;
	private initialized = false;

	constructor(private readonly isEligible: (toolName: AggregateSafeToolName) => boolean) {}

	isInitialized(): boolean {
		return this.initialized;
	}

	getGroups(): readonly AggregateGroup[] {
		return this.groups;
	}

	getMember(toolCallId: string): AggregateMember | undefined {
		return this.membersById.get(toolCallId);
	}

	getConnectedRendererCount(): number {
		return this.invalidators.size;
	}

	startUserGroup(groupId?: string): string {
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
		if (!isAggregateSafeToolName(toolName) || !this.isEligible(toolName)) return;

		// Public message/tool events are the membership source of truth. A renderer
		// may attach before session_start during /reload, or remain alive briefly
		// after /tree/compaction removed its row. It must never invent membership or
		// retain a callback after its row leaves the rendered current branch.
		const member = this.membersById.get(toolCallId);
		if (!member || !member.visible) return;
		if (invalidate) this.invalidators.set(toolCallId, invalidate);
		member.args = { ...member.args, ...toRecord(args) };
	}

	ingestAssistantMessage(message: unknown): void {
		if (messageRole(message) !== "assistant") return;
		for (const call of toolCallsFromMessage(message)) {
			if (!this.isEligible(call.name)) continue;
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
		if (!isAggregateSafeToolName(toolName) || !this.isEligible(toolName)) return;
		const member = this.addOrUpdateMember(toolCallId, toolName, args, true);
		if (!member || member.state === "needsAttention") return;
		member.state = "running";
		this.invalidateGroup(member.groupId, toolCallId);
	}

	markUpdated(toolCallId: string, args: unknown): void {
		const member = this.membersById.get(toolCallId);
		if (!member) return;
		member.args = { ...member.args, ...toRecord(args) };
		if (member.state === "pending") member.state = "running";
		this.invalidateGroup(member.groupId, toolCallId);
	}

	recordWritePrevious(toolCallId: string, previous: WritePreviousContent): void {
		this.writePreviousById.set(toolCallId, { ...previous });
	}

	getWriteDiffStatsForPersistence(toolCallId: string): AggregateDiffStats | undefined {
		const member = this.membersById.get(toolCallId);
		return member?.toolName === "write" && member.state === "success" && member.diffStats
			? { ...member.diffStats }
			: undefined;
	}

	recordPersistedWriteDiffStats(toolCallId: string, stats: AggregateDiffStats): void {
		const persisted = { ...stats };
		this.persistedWriteDiffStatsById.set(toolCallId, persisted);
		const member = this.membersById.get(toolCallId);
		if (member?.toolName === "write" && member.state === "success") {
			member.diffStats = { ...persisted };
		}
	}

	markComplete(toolCallId: string, result: unknown, isError: boolean): void {
		const member = this.membersById.get(toolCallId);
		if (!member) return;
		if (aggregateResultHasImage(result)) {
			member.state = "needsAttention";
			member.errorSummary = undefined;
			member.diffStats = undefined;
			this.recomputeLeader(member.groupId);
			this.invalidateGroup(member.groupId, toolCallId);
			return;
		}
		if (isError) {
			this.markFailed(toolCallId, firstMeaningfulLine(result, "Tool failed."));
			return;
		}

		member.state = "success";
		member.errorSummary = undefined;
		member.diffStats = this.resolveDiffStats(member, result);
		this.writePreviousById.delete(toolCallId);
		this.invalidateGroup(member.groupId, toolCallId);
	}

	markNeedsAttention(toolCallId: string): void {
		const member = this.membersById.get(toolCallId);
		if (!member || member.state === "needsAttention") return;
		member.state = "needsAttention";
		member.errorSummary = undefined;
		member.diffStats = undefined;
		this.recomputeLeader(member.groupId);
		this.invalidateGroup(member.groupId, toolCallId);
	}

	markFailed(toolCallId: string, summary: string): void {
		const member = this.membersById.get(toolCallId);
		if (!member || member.state === "needsAttention") return;
		member.state = "failed";
		member.errorSummary = normalizeDisplaySummary(summary, FAILED_SUMMARY_MAX_LENGTH) ?? "Tool failed.";
		member.diffStats = undefined;
		this.writePreviousById.delete(toolCallId);
		this.invalidateGroup(member.groupId, toolCallId);
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
		this.writePreviousById.clear();
		this.persistedWriteDiffStatsById.clear();
		this.sourceOrder = 0;
		this.activeGroupId = undefined;

		let fallbackGroupIndex = 0;
		for (const entry of Array.isArray(branchEntries) ? branchEntries : []) {
			const persistedWriteDiff = persistedWriteDiffFromEntry(entry);
			if (persistedWriteDiff) {
				this.recordPersistedWriteDiffStats(persistedWriteDiff.toolCallId, persistedWriteDiff.stats);
				continue;
			}
			const message = entryMessage(entry);
			if (!message) continue;
			const role = messageRole(message);
			if (role === "user") {
				this.activeGroupId = entryId(entry, `restored-user-${++fallbackGroupIndex}`);
				this.ensureGroup(this.activeGroupId);
				continue;
			}
			if (role === "assistant") {
				for (const call of toolCallsFromMessage(message)) {
					if (!this.isEligible(call.name)) continue;
					this.addOrUpdateMember(call.id, call.name, call.args, visibleIds?.has(call.id) ?? true);
				}
				if (isAssistantTerminalFailure(message)) {
					const summary = assistantFailureSummary(message);
					for (const call of toolCallsFromMessage(message)) {
						if (this.membersById.has(call.id)) this.markFailed(call.id, summary);
					}
				}
				continue;
			}
			if (role === "toolResult") {
				const record = toRecord(message);
				if (typeof record.toolCallId === "string") {
					this.markComplete(record.toolCallId, record, record.isError === true);
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
		if (!member || member.state === "needsAttention") return undefined;
		const group = this.groupsById.get(member.groupId);
		if (!group || group.leaderToolCallId !== toolCallId) return undefined;

		const grouped = group.members.filter((entry) => entry.state !== "needsAttention");
		const activeAll = grouped
			.filter((entry) => entry.state === "pending" || entry.state === "running")
			.sort((left, right) => left.sourceOrder - right.sourceOrder);
		const failed = grouped
			.filter((entry) => entry.state === "failed")
			.sort((left, right) => left.sourceOrder - right.sourceOrder);
		const successes = grouped
			.filter((entry) => entry.state === "success")
			.sort((left, right) => left.sourceOrder - right.sourceOrder);
		const successCounts = new Map<AggregateSafeToolName, number>();
		const modifiedFiles = new Set<string>();
		let additions = 0;
		let deletions = 0;
		let hasDiffStats = false;
		for (const success of successes) {
			successCounts.set(success.toolName, (successCounts.get(success.toolName) ?? 0) + 1);
			if (success.toolName === "edit" || success.toolName === "write") {
				const path = getPath(success.args);
				if (path) modifiedFiles.add(shortenPath(path));
				if (success.diffStats) {
					additions += success.diffStats.additions;
					deletions += success.diffStats.deletions;
					hasDiffStats = true;
				}
			}
		}

		return {
			groupId: group.groupId,
			leaderToolCallId: toolCallId,
			active: activeAll.slice(0, ACTIVE_ROW_LIMIT),
			activeOverflow: Math.max(0, activeAll.length - ACTIVE_ROW_LIMIT),
			failed,
			successCounts: [...successCounts].map(([toolName, count]) => ({ toolName, count })),
			modifiedFiles: [...modifiedFiles],
			diffStats: hasDiffStats ? { additions, deletions } : undefined,
		};
	}

	private ensureGroup(groupId: string): AggregateGroup {
		let group = this.groupsById.get(groupId);
		if (!group) {
			group = { groupId, members: [] };
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
		toolName: AggregateSafeToolName,
		args: unknown,
		visible: boolean,
	): AggregateMember | undefined {
		if (!this.isEligible(toolName)) return undefined;
		const existing = this.membersById.get(toolCallId);
		if (existing) {
			existing.args = { ...existing.args, ...toRecord(args) };
			const becameVisible = !existing.visible && visible;
			existing.visible ||= visible;
			if (becameVisible) this.recomputeLeader(existing.groupId);
			return existing;
		}

		const group = this.ensureActiveGroup();
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
		if (visible) group.leaderToolCallId = toolCallId;
		this.invalidateIds(previousLeader, group.leaderToolCallId);
		return member;
	}

	private recomputeLeader(groupId: string): void {
		const group = this.groupsById.get(groupId);
		if (!group) return;
		const previousLeader = group.leaderToolCallId;
		group.leaderToolCallId = [...group.members]
			.reverse()
			.find((member) => member.visible && member.state !== "needsAttention")
			?.toolCallId;
		this.invalidateIds(previousLeader, group.leaderToolCallId);
	}

	private resolveDiffStats(member: AggregateMember, result: unknown): AggregateDiffStats | undefined {
		if (member.toolName === "edit") {
			const details = toRecord(toRecord(result).details);
			return countPatchStats(details.patch);
		}
		if (member.toolName !== "write") return undefined;
		const previous = this.writePreviousById.get(member.toolCallId);
		const nextContent = member.args.content;
		if (previous && typeof nextContent === "string") {
			if (previous.fileExistedBeforeWrite && previous.previousContent === undefined) return undefined;
			const path = getPath(member.args) ?? "file";
			const patch = generateUnifiedPatch(path, previous.previousContent ?? "", nextContent, 0);
			return countPatchStats(patch);
		}
		const persisted = this.persistedWriteDiffStatsById.get(member.toolCallId);
		return persisted ? { ...persisted } : undefined;
	}

	private invalidateGroup(groupId: string, changedId?: string): void {
		const group = this.groupsById.get(groupId);
		this.invalidateIds(group?.leaderToolCallId, changedId);
	}

	private invalidateIds(...ids: Array<string | undefined>): void {
		for (const id of new Set(ids.filter((entry): entry is string => Boolean(entry)))) {
			try {
				this.invalidators.get(id)?.();
			} catch {
				// Rendering must remain fail-open if a stale component rejects invalidation.
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

export class AggregateActivityComponent implements Component {
	constructor(
		private readonly toolCallId: string,
		private readonly projection: AggregateProjection,
		private theme: RenderTheme,
	) {}

	setTheme(theme: RenderTheme): void {
		this.theme = theme;
	}

	render(width: number): string[] {
		const safeWidth = Number.isFinite(width) ? Math.max(0, Math.floor(width)) : 0;
		if (safeWidth === 0) return [];
		const view = this.projection.getView(this.toolCallId);
		if (!view) return [];

		const hasActive = view.active.length > 0 || view.activeOverflow > 0;
		const hasFailure = view.failed.length > 0;
		const marker = hasFailure ? "!" : hasActive ? "◐" : "✓";
		const markerColor = hasFailure ? "error" : hasActive ? "warning" : "success";
		let header = `${this.theme.fg(markerColor, marker)} ${this.theme.fg("toolTitle", this.theme.bold?.("Activity") ?? "Activity")}`;
		for (const count of view.successCounts) {
			header += this.theme.fg("muted", ` · ${count.toolName} ×${count.count}`);
		}
		if (view.modifiedFiles.length > 0) {
			header += this.theme.fg("muted", ` · ${view.modifiedFiles.length} ${view.modifiedFiles.length === 1 ? "file" : "files"}`);
		}
		if (view.diffStats) {
			header += this.theme.fg("muted", ` · +${view.diffStats.additions} −${view.diffStats.deletions}`);
		}
		if (hasFailure) {
			header += this.theme.fg("error", ` · ${view.failed.length} failed`);
		}

		const lines = [truncateToWidth(header, safeWidth, "…")];
		for (const active of view.active) {
			lines.push(truncateToWidth(`  ${formatAggregateTarget(active)}`, safeWidth, "…"));
		}
		if (view.activeOverflow > 0) {
			lines.push(truncateToWidth(`  … ${view.activeOverflow} more running`, safeWidth, "…"));
		}
		for (const failed of view.failed) {
			lines.push(
				truncateToWidth(
					`  ${formatAggregateTarget(failed)}: ${failed.errorSummary ?? "Tool failed."}`,
					safeWidth,
					"…",
				),
			);
		}
		return lines;
	}

	invalidate(): void {
		// Projection state is read on every render.
	}
}

class ZeroRowComponent implements Component {
	render(): string[] {
		return [];
	}

	invalidate(): void {
		// Stateless.
	}
}

function renderAggregateCall(
	projection: AggregateProjection,
	toolName: string,
	args: Record<string, unknown>,
	theme: RenderTheme,
	context: ToolRenderContextLike,
): Component {
	if (!context?.toolCallId) return new ZeroRowComponent();
	projection.connectRenderer(context.toolCallId, toolName, args, context.invalidate);
	const existing = context.lastComponent;
	if (existing instanceof AggregateActivityComponent) {
		existing.setTheme(theme);
		return existing;
	}
	return new AggregateActivityComponent(context.toolCallId, projection, theme);
}

export function applyAggregateRendering<T extends RuntimeToolDefinition>(
	tool: T,
	projection: AggregateProjection,
): T {
	const originalRenderCall = tool.renderCall;
	const originalRenderResult = tool.renderResult;
	const toolName = typeof tool.name === "string" ? tool.name : "tool";
	return {
		...tool,
		renderShell: "self",
		renderCall(args: Record<string, unknown>, theme: RenderTheme, context: ToolRenderContextLike) {
			if (!context?.toolCallId) {
				return typeof originalRenderCall === "function"
					? originalRenderCall.call(tool, args, theme, context)
					: new ZeroRowComponent();
			}
			projection.connectRenderer(context.toolCallId, toolName, args, context.invalidate);
			if (projection.getMember(context.toolCallId)?.state === "needsAttention" && typeof originalRenderCall === "function") {
				return originalRenderCall.call(tool, args, theme, { ...context, lastComponent: undefined });
			}
			return renderAggregateCall(projection, toolName, args, theme, context);
		},
		renderResult(
			result: AggregateToolResult,
			options: ToolRenderResultOptions,
			theme: RenderTheme,
			context: ToolRenderContextLike,
		) {
			if (context?.toolCallId && aggregateResultHasImage(result)) {
				projection.markNeedsAttention(context.toolCallId);
			}
			if (
				context?.toolCallId &&
				projection.getMember(context.toolCallId)?.state === "needsAttention" &&
				typeof originalRenderResult === "function"
			) {
				return originalRenderResult.call(tool, result, options, theme, { ...context, lastComponent: undefined });
			}
			return new ZeroRowComponent();
		},
	} as T;
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
): void {
	const persistedWriteDiffIds = new Set<string>();
	pi.on("session_start", async (_event, ctx) => rebuildProjectionFromContext(projection, ctx));
	pi.on("before_agent_start", async (_event, ctx) => rebuildProjectionFromContext(projection, ctx));
	pi.on("session_compact", async (_event, ctx) => rebuildProjectionFromContext(projection, ctx));
	pi.on("session_tree", async (_event, ctx) => rebuildProjectionFromContext(projection, ctx));
	pi.on("message_start", async (event) => {
		if (messageRole(event.message) === "user") {
			const timestamp = toRecord(event.message).timestamp;
			projection.startUserGroup(typeof timestamp === "number" ? `live-user-${timestamp}` : undefined);
		}
	});
	pi.on("message_update", async (event) => projection.ingestAssistantMessage(event.message));
	pi.on("message_end", async (event) => projection.ingestAssistantMessage(event.message));
	pi.on("tool_execution_start", async (event) => {
		projection.markStarted(event.toolCallId, event.toolName, event.args);
	});
	pi.on("tool_execution_update", async (event) => {
		projection.markUpdated(event.toolCallId, event.args);
	});
	pi.on("tool_execution_end", async (event) => {
		projection.markComplete(event.toolCallId, event.result, event.isError === true);
		const stats = projection.getWriteDiffStatsForPersistence(event.toolCallId);
		if (!stats || persistedWriteDiffIds.has(event.toolCallId) || typeof pi.appendEntry !== "function") return;
		try {
			pi.appendEntry(AGGREGATE_WRITE_DIFF_CUSTOM_TYPE, {
				toolCallId: event.toolCallId,
				additions: stats.additions,
				deletions: stats.deletions,
			});
			persistedWriteDiffIds.add(event.toolCallId);
			projection.recordPersistedWriteDiffStats(event.toolCallId, stats);
		} catch {
			// Rendering remains correct for the live row; a later rebuild omits stats
			// rather than mutating the original tool call/result or inventing values.
		}
	});
	pi.on("agent_settled", async () => projection.markUnsettledInterrupted());
}
