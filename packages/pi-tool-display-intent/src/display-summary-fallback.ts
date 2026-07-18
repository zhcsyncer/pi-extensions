import { getDisplaySummary, normalizeDisplaySummary } from "./display-summary.js";
import type { ToolIntentConfig, ToolIntentLanguage } from "./types.js";

const BUILT_IN_FALLBACKS: Record<string, { en: string; zhCN: string }> = {
	read: { en: "Read file", zhCN: "读取文件" },
	grep: { en: "Search file contents", zhCN: "搜索文件内容" },
	find: { en: "Find matching files", zhCN: "查找匹配文件" },
	ls: { en: "List directory contents", zhCN: "列出目录内容" },
	bash: { en: "Run command", zhCN: "执行命令" },
	edit: { en: "Update file", zhCN: "更新文件" },
	write: { en: "Write file", zhCN: "写入文件" },
};

function useSimplifiedChinese(language: ToolIntentLanguage): boolean {
	return language === "zh-CN";
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
	if (!config.enabled) {
		return undefined;
	}

	const modelSummary = getDisplaySummary(args, config.maxLength);
	if (modelSummary) {
		return { text: modelSummary, source: "model" };
	}

	return {
		text: buildDeterministicDisplaySummary(toolName, config.language, config.maxLength),
		source: "fallback",
	};
}
