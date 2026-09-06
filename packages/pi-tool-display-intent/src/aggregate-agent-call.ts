import { formatAggregateArgumentPreview } from "./aggregate-argument-preview.js";

/** Final tool receipt only; never a second copy of the live child-agent lifecycle. */
export type AgentCallReceipt = "dispatched" | "queued" | "scheduled" | "completed" | "steered" | "stopped" | "failed" | "returned";

function field(value: unknown, key: string): unknown {
	if (!value || typeof value !== "object") return undefined;
	try { return Object.getOwnPropertyDescriptor(value, key)?.value; } catch { return undefined; }
}
function text(value: unknown): string | undefined {
	return typeof value === "string" && value.trim() ? value : undefined;
}

export function formatAggregateAgentTarget(args: unknown): string {
	const description = formatAggregateArgumentPreview({ description: field(args, "description") }, 48);
	const resume = text(field(args, "resume"));
	const kind = resume ? "resume" : formatAggregateArgumentPreview({ name: field(args, "subagent_type") }, 24);
	const target = description || (resume ? formatAggregateArgumentPreview({ id: resume }, 36) : "");
	const values = [...new Set([kind, target].filter(Boolean))];
	return values.length ? `Agent(${values.join(" · ")})` : "Agent";
}

export function readAgentCallReceipt(args: unknown, result: unknown): AgentCallReceipt {
	// Metadata is authoritative: defaults/frontmatter/resume can override the requested mode.
	const status = field(field(result, "details"), "status");
	switch (status) {
		case "background": return "dispatched";
		case "queued": return "queued";
		case "completed": return "completed";
		case "steered": return "steered";
		case "aborted":
		case "stopped": return "stopped";
		case "error": return "failed";
	}
	if (text(field(args, "schedule"))) return "scheduled";
	if (field(args, "run_in_background") === true && !text(field(args, "resume"))) return "dispatched";
	// Unknown receipts must not claim that the child task has finished.
	return "returned";
}

export function agentReceiptChrome(receipt: AgentCallReceipt): { marker: string; color: "success" | "warning" | "error" | "muted"; label?: string } {
	switch (receipt) {
		case "dispatched": return { marker: "↗", color: "muted", label: "dispatched" };
		case "queued":
		case "scheduled": return { marker: "◷", color: "warning", label: receipt };
		case "stopped": return { marker: "!", color: "warning", label: "stopped" };
		case "failed": return { marker: "!", color: "error", label: "failed" };
		case "steered": return { marker: "↗", color: "muted", label: "steered" };
		case "returned": return { marker: "↗", color: "muted", label: "returned" };
		case "completed": return { marker: "✓", color: "success" };
	}
}
