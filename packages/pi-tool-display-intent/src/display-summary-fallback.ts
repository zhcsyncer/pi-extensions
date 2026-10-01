import { getDisplaySummary, normalizeDisplaySummary } from "./display-summary.js";
import type { ToolIntentConfig, ToolIntentLanguage } from "./types.js";

const BUILT_IN_FALLBACKS: Record<string, { en: string; zhCN: string }> = {
	read: { en: "Read file", zhCN: "读取文件" },
	grep: { en: "Search file contents", zhCN: "搜索文件内容" },
	find: { en: "Find matching files", zhCN: "查找匹配文件" },
	ls: { en: "List directory contents", zhCN: "列出目录内容" },
	bash: { en: "Run command", zhCN: "执行命令" },
	codemode: { en: "Run script", zhCN: "运行脚本" },
	edit: { en: "Update file", zhCN: "更新文件" },
	write: { en: "Write file", zhCN: "写入文件" },
};

function useSimplifiedChinese(language: ToolIntentLanguage): boolean {
	return language === "zh-CN";
}

export function extractCodemodeCommentIntent(code: unknown): string | undefined {
	if (typeof code !== "string") return undefined;
	const lines = code.trim().split("\n");
	for (const rawLine of lines) {
		const line = rawLine.trim();
		if (!line) continue;
		if (line.startsWith("// @options:")) continue;
		const singleMatch = /^\/\/\s*(.*)$/.exec(line);
		if (singleMatch) {
			const text = singleMatch[1].trim();
			if (!text || text.startsWith("@")) continue;
			return text;
		}
		const blockMatch = /^\/\*\s*(.*?)\s*\*\/$/.exec(line);
		if (blockMatch) {
			const text = blockMatch[1].trim();
			if (!text || text.startsWith("@")) continue;
			return text;
		}
		break;
	}
	return undefined;
}

export function extractCodemodeToolCalls(code: unknown): string[] {
	if (typeof code !== "string") return [];
	const matches = new Set<string>();
	const pattern = /\btools\.([a-zA-Z0-9_]+)\b/g;
	let match: RegExpExecArray | null;
	while ((match = pattern.exec(code)) !== null) {
		const name = match[1];
		if (name && name !== "exit" && name !== "text" && name !== "image") {
			matches.add(name);
		}
	}
	return [...matches];
}

export function formatCodemodeTarget(args: Record<string, unknown>, maxLength = 60): string {
	const summary = getDisplaySummary(args, maxLength);
	if (summary) return summary;

	const comment = extractCodemodeCommentIntent(args?.code);
	if (comment) return comment.length > maxLength ? `${comment.slice(0, maxLength - 1)}…` : comment;

	const toolCalls = extractCodemodeToolCalls(args?.code);
	if (toolCalls.length > 0) {
		const joined = toolCalls.join(" · ");
		return joined.length > maxLength ? `${joined.slice(0, maxLength - 1)}…` : joined;
	}

	if (typeof args?.code === "string") {
		const lines = args.code.trim().split("\n");
		for (const rawLine of lines) {
			const line = rawLine.trim();
			if (
				!line ||
				line.startsWith("//") ||
				line.startsWith("/*") ||
				line.startsWith("*")
			) {
				continue;
			}
			const clean = line.replace(/\s+/g, " ");
			return clean.length > maxLength ? `${clean.slice(0, maxLength - 1)}…` : clean;
		}
	}

	return "";
}

export function buildDeterministicDisplaySummary(
	toolName: string | undefined,
	language: ToolIntentLanguage,
	maxLength: number,
): string {
	const normalizedToolName = toolName?.trim() || "tool";
	const known = BUILT_IN_FALLBACKS[normalizedToolName];
	const fallback = known
		? useSimplifiedChinese(language)
			? known.zhCN
			: known.en
		: useSimplifiedChinese(language)
			? `运行 ${normalizedToolName}`
			: `Run ${normalizedToolName}`;

	return normalizeDisplaySummary(fallback, maxLength) ?? fallback;
}

export interface ResolvedDisplaySummary {
	text: string;
	source: "model" | "fallback";
}

export function resolveDisplaySummaryForTool(
	args: unknown,
	toolName: string | undefined,
	config: ToolIntentConfig,
): ResolvedDisplaySummary | undefined {
	const modelSummary = getDisplaySummary(args, config.maxLength);
	if (modelSummary) {
		return { text: modelSummary, source: "model" };
	}

	if (toolName === "codemode" && args && typeof args === "object") {
		const commentIntent = extractCodemodeCommentIntent((args as Record<string, unknown>).code);
		if (commentIntent) {
			const normalized = normalizeDisplaySummary(commentIntent, config.maxLength);
			if (normalized) {
				return { text: normalized, source: "model" };
			}
		}
	}

	return {
		text: buildDeterministicDisplaySummary(toolName, config.language, config.maxLength),
		source: "fallback",
	};
}
