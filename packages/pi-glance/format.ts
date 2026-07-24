import { homedir } from "node:os";
import { basename } from "node:path";
import { visibleWidth } from "@earendil-works/pi-tui";
import type { WorkspaceLabelMode } from "./types.js";
export { formatCost, formatPercent, formatTokens } from "./segment-display-primitives.js";

const SMART_NAME_MAX_SURFACE_WIDTH = 83;
const SMART_PARENT_MAX_SURFACE_WIDTH = 139;
const HOME_PATH = normalizePath(homedir());

export function shortenModel(modelId: string | undefined, customNames: Record<string, string> = {}): string {
	if (!modelId) return "no-model";
	for (const [pattern, name] of Object.entries(customNames)) {
		if (modelId.includes(pattern)) return name;
	}
	let id = modelId;
	id = id.replace(/^claude-/, "");
	id = id.replace(/^anthropic[/:]/, "");
	id = id.replace(/-20\d{6,8}$/, "");
	id = id.replace(/-latest$/, "");
	id = id.replace(/-/g, " ");
	id = id.replace(/\bsonnet\b/i, "Sonnet");
	id = id.replace(/\bopus\b/i, "Opus");
	id = id.replace(/\bhaiku\b/i, "Haiku");
	id = id.replace(/\bgpt\b/i, "GPT");
	id = id.replace(/\bglm\b/i, "GLM");
	return id.trim() || modelId;
}

export function displayDirectory(cwd: string): string {
	if (!cwd) return "?";
	return basename(cwd) || cwd;
}

function normalizePath(path: string): string {
	return path.replace(/\\/g, "/").replace(/\/+$/g, "") || path;
}

function splitPathParts(path: string): string[] {
	return path.split(/[\\/]+/).filter(Boolean);
}

function safeHomePath(cwd: string): string {
	const normalized = normalizePath(cwd);
	if (!normalized) return "?";
	if (HOME_PATH && normalized === HOME_PATH) return "~";
	if (HOME_PATH && normalized.startsWith(`${HOME_PATH}/`)) return `~/${normalized.slice(HOME_PATH.length + 1)}`;
	const parts = splitPathParts(normalized);
	if (parts.length === 0) return "root";
	if (parts.length === 1) return displayDirectory(normalized);
	return `…/${parts.slice(-Math.min(3, parts.length)).join("/")}`;
}

function truncatePlainToWidth(text: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(text) <= width) return text;
	if (width <= 1) return "…";
	let out = "";
	for (const char of text) {
		if (visibleWidth(`${out}${char}…`) > width) break;
		out += char;
	}
	return `${out}…`;
}

function fitSafePath(label: string, width: number): string {
	if (width <= 0) return "";
	if (visibleWidth(label) <= width) return label;
	const parts = label.split("/").filter(Boolean);
	const name = parts.at(-1) ?? label;
	if (visibleWidth(name) >= width) return truncatePlainToWidth(name, width);
	if (label.startsWith("~/") && parts.length > 2) {
		const compact = `~/${parts[1]}/…/${name}`;
		if (visibleWidth(compact) <= width) return compact;
	}
	const tail = `…/${name}`;
	if (visibleWidth(tail) <= width) return tail;
	return truncatePlainToWidth(name, width);
}

function parentPathLabel(safePath: string): string {
	const parts = splitPathParts(safePath);
	if (parts.length < 2) return safePath;
	return `…/${parts.slice(-2).join("/")}`;
}

export function formatWorkspaceLabel(cwd: string, name: string, mode: WorkspaceLabelMode, width: number, surfaceWidth = width): string {
	const fallback = name || displayDirectory(cwd) || "workspace";
	const budget = Math.max(1, width);
	if (mode === "name") return fitSafePath(fallback, budget);

	const safePath = safeHomePath(cwd);
	if (mode === "smart") {
		if (surfaceWidth <= SMART_NAME_MAX_SURFACE_WIDTH) return fitSafePath(fallback, budget);
		if (surfaceWidth <= SMART_PARENT_MAX_SURFACE_WIDTH) return fitSafePath(parentPathLabel(safePath), budget);
	}
	return fitSafePath(safePath, budget);
}

export function stripControls(text: string): string {
	return text
		.replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/g, "")
		.replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
		.replace(/[\r\n\t]/g, " ")
		.replace(/ +/g, " ")
		.trim();
}
