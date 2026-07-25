import { homedir } from "node:os";
import path from "node:path";
import { type Theme } from "@earendil-works/pi-coding-agent";
import { truncateToWidth, visibleWidth } from "@earendil-works/pi-tui";
import type { PlanStatus } from "./types.ts";

const PLAN_PREFIX = "▌ PLAN  ";
const MODE_LABEL = "⏸ PLAN MODE · READ-ONLY";
const MODE_HINT = "/plan off · Ctrl+Alt+P";
const STEPS_HINT = "Ctrl+Alt+O";

export interface PlanWidgetData {
	title: string;
	status: PlanStatus;
	revision: number;
	planPath: string;
	steps: string[];
	expanded: boolean;
	terminalRows: number;
}

export interface PlanApprovedEventData {
	title?: string;
	revision?: number;
	stepCount?: number;
}

function clamp(value: number, minimum: number, maximum: number): number {
	return Math.min(maximum, Math.max(minimum, value));
}

function statusLabel(status: PlanStatus): string {
	return status === "changes_requested" ? "CHANGES REQUESTED" : status.toUpperCase();
}

function statusColor(status: PlanStatus): "success" | "warning" | "accent" {
	if (status === "approved") return "success";
	if (status === "changes_requested") return "warning";
	return "accent";
}

function alignRight(left: string, right: string, width: number, minimumGap = 2): string {
	if (width <= 0) return "";
	if (!right) return truncateToWidth(left, width);
	const rightWidth = visibleWidth(right);
	if (rightWidth >= width) return truncateToWidth(left, width);
	const leftWidth = visibleWidth(left);
	if (leftWidth + minimumGap + rightWidth <= width) {
		return `${left}${" ".repeat(width - leftWidth - rightWidth)}${right}`;
	}
	const availableLeft = width - rightWidth - minimumGap;
	if (availableLeft < 8) return truncateToWidth(left, width);
	const fittedLeft = truncateToWidth(left, availableLeft);
	return `${fittedLeft}${" ".repeat(width - visibleWidth(fittedLeft) - rightWidth)}${right}`;
}

function rightAligned(text: string, width: number): string {
	const fitted = truncateToWidth(text, width);
	return `${" ".repeat(Math.max(0, width - visibleWidth(fitted)))}${fitted}`;
}

export function compactPlanPath(planPath: string, home = homedir()): string {
	const normalizedHome = path.resolve(home);
	const normalizedPath = path.resolve(planPath);
	if (normalizedPath === normalizedHome) return "~";
	if (normalizedPath.startsWith(`${normalizedHome}${path.sep}`)) {
		return `~${normalizedPath.slice(normalizedHome.length)}`;
	}
	return planPath;
}

export function renderPlanWidget(data: PlanWidgetData, width: number, theme: Theme): string[] {
	if (width <= 0) return [];
	const title = `${theme.fg("accent", PLAN_PREFIX)}${theme.bold(data.title)}`;
	const state = theme.fg(statusColor(data.status), `${statusLabel(data.status)} · r${data.revision}`);
	const lines = [alignRight(title, state, width)];

	if (!data.expanded) {
		const count = theme.fg("muted", `${data.steps.length} ${data.steps.length === 1 ? "step" : "steps"}`);
		const hint = theme.fg("dim", `${STEPS_HINT} expand`);
		lines.push(alignRight(count, hint, width));
		return lines.map((line) => truncateToWidth(line, width));
	}

	const planPath = theme.fg("dim", compactPlanPath(data.planPath));
	lines.push(truncateToWidth(planPath, width));
	if (data.steps.length === 0) {
		lines.push(truncateToWidth(theme.fg("muted", "  No execution steps"), width));
	} else {
		const budget = clamp(Math.floor(data.terminalRows * 0.3), 3, 10);
		const visibleSteps = data.steps.slice(0, budget);
		for (const [index, step] of visibleSteps.entries()) {
			const prefix = theme.fg("accent", `  ${index + 1}. `);
			lines.push(truncateToWidth(`${prefix}${step}`, width));
		}
		const remaining = data.steps.length - visibleSteps.length;
		if (remaining > 0) lines.push(truncateToWidth(theme.fg("muted", `  … +${remaining} more`), width));
	}
	lines.push(rightAligned(theme.fg("dim", `${STEPS_HINT} collapse`), width));
	return lines.map((line) => truncateToWidth(line, width));
}

export function renderPlanApprovedEvent(data: PlanApprovedEventData, width: number, theme: Theme): string[] {
	if (width <= 0) return [];
	const status = theme.fg("success", "✓ PLAN APPROVED");
	const metadata: string[] = [];
	if (data.title?.trim()) metadata.push(data.title.trim());
	if (Number.isInteger(data.revision) && data.revision! > 0) metadata.push(`r${data.revision}`);
	if (Number.isInteger(data.stepCount) && data.stepCount! >= 0) {
		metadata.push(`${data.stepCount} ${data.stepCount === 1 ? "step" : "steps"}`);
	}
	if (metadata.length === 0) return [truncateToWidth(status, width)];
	const statusWidth = visibleWidth(status);
	if (width - statusWidth < 3) return [truncateToWidth(status, width)];
	const suffix = theme.fg("dim", ` · ${metadata.join(" · ")}`);
	return [`${status}${truncateToWidth(suffix, width - statusWidth)}`];
}

export function renderModeWidget(width: number, theme: Theme): string[] {
	if (width <= 0) return [];
	const label = theme.fg("warning", MODE_LABEL);
	const fullHint = theme.fg("dim", MODE_HINT);
	const commandOnly = theme.fg("dim", "/plan off");
	let line: string;
	if (visibleWidth(label) + 2 + visibleWidth(fullHint) <= width) {
		line = alignRight(label, fullHint, width);
	} else if (visibleWidth(label) + 2 + visibleWidth(commandOnly) <= width) {
		line = alignRight(label, commandOnly, width);
	} else {
		line = truncateToWidth(label, width);
	}
	return [truncateToWidth(line, width)];
}
