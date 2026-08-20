export const DISPATCHED_ENTRY_TYPE = "herdr-worktree-dispatched";
export const NOT_READY_PREFIX = "NOT_READY";
export const PROTECTED_BRANCHES = new Set(["main", "master"]);
export const DISTILL_MAX_CHARS = 48_000;
export const DISTILL_MAX_TOKENS = 4_096;

export function buildDistillInstruction(branch?: string): string {
	const branchLine = branch
		? `第一行必须是：Branch: ${branch}`
		: "第一行写：Branch: <建议的分支名>";
	return [
		"只从当前讨论抽出可执行的目标和计划。",
		"不要复述讨论过程，不要写被否决的方案，不要开始实现。",
		`若目标或计划还不够具体，只回复 ${NOT_READY_PREFIX} 和原因。`,
		branchLine,
		"从第二行起写目标和步骤。",
	].join("\n");
}

export type ParsedDispatchBrief =
	| { status: "not-ready"; reason: string }
	| { status: "ready"; branch: string; brief: string }
	| { status: "invalid"; message: string };

function isProtectedBranch(branch: string): boolean {
	return PROTECTED_BRANCHES.has(branch);
}

function validBranchName(branch: string): boolean {
	return Boolean(branch) && !branch.startsWith("-") && !/[\s\0\n\r]/.test(branch);
}

export function extractContentText(content: unknown): string {
	if (typeof content === "string") return content.trim();
	if (!Array.isArray(content)) return "";
	return content
		.filter((part): part is { type: string; text: string } =>
			Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text" &&
			typeof (part as { text?: unknown }).text === "string")
		.map((part) => part.text)
		.join("")
		.trim();
}

export function lastAssistantText(entries: readonly { type?: string; message?: { role?: string; content?: unknown } }[]): string {
	for (let index = entries.length - 1; index >= 0; index -= 1) {
		const entry = entries[index];
		if (entry?.type !== "message" || entry.message?.role !== "assistant") continue;
		const text = extractContentText(entry.message.content);
		if (text) return text;
	}
	return "";
}

export function sessionHasDistillableConversation(
	entries: readonly { type?: string; message?: { role?: string; content?: unknown } }[],
): boolean {
	return entries.some((entry) => {
		if (entry.type !== "message") return false;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") return false;
		return extractContentText(entry.message?.content).length > 0;
	});
}

export function serializeSessionForDistill(
	entries: readonly { type?: string; message?: { role?: string; content?: unknown } }[],
	maxChars = DISTILL_MAX_CHARS,
): string {
	const parts: string[] = [];
	for (const entry of entries) {
		if (entry.type !== "message") continue;
		const role = entry.message?.role;
		if (role !== "user" && role !== "assistant") continue;
		const text = extractContentText(entry.message?.content);
		if (!text) continue;
		parts.push(`${role === "user" ? "User" : "Assistant"}:\n${text}`);
	}
	const serialized = parts.join("\n\n");
	if (serialized.length <= maxChars) return serialized;
	return `[Earlier discussion omitted]\n${serialized.slice(serialized.length - maxChars)}`;
}

export function parseDispatchBrief(text: string, pinnedBranch?: string): ParsedDispatchBrief {
	const trimmed = text.trim();
	if (!trimmed) return { status: "invalid", message: "The dispatch plan is empty." };
	if (trimmed.startsWith(NOT_READY_PREFIX)) {
		const reason = trimmed.slice(NOT_READY_PREFIX.length).replace(/^[:：\s]+/, "").trim();
		return { status: "not-ready", reason: reason || "the current discussion is not ready to dispatch" };
	}

	const lines = trimmed.split(/\r?\n/);
	const header = /^Branch:\s*(\S+)\s*$/.exec(lines[0] ?? "");
	const parsedBranch = header?.[1];
	const body = header ? lines.slice(1).join("\n").trim() : trimmed;
	const branch = pinnedBranch ?? parsedBranch;
	if (!branch) return { status: "invalid", message: "The dispatch plan must start with Branch: <name>." };
	if (!validBranchName(branch)) return { status: "invalid", message: `Refusing to dispatch to invalid branch ${branch}.` };
	if (isProtectedBranch(branch)) {
		return { status: "invalid", message: `Refusing to dispatch to ${branch}.` };
	}
	if (!body) return { status: "invalid", message: "The dispatch plan has no executable goal or steps." };
	const brief = `Branch: ${branch}\n${body}`;
	return { status: "ready", branch, brief };
}

export function wrapDisplayLines(text: string, width: number): string[] {
	const columns = Math.max(1, width);
	const lines: string[] = [];
	for (const line of text.split("\n")) {
		if (line.length === 0) {
			lines.push("");
			continue;
		}
		for (let index = 0; index < line.length; index += columns) {
			lines.push(line.slice(index, index + columns));
		}
	}
	return lines.length > 0 ? lines : [""];
}
