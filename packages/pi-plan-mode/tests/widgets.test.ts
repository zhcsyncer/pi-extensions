import { describe, expect, it } from "vitest";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
	compactPlanPath,
	renderModeWidget,
	renderPlanApprovedEvent,
	renderPlanLifecycleEvent,
	renderPlanWidget,
} from "../src/widgets.ts";

const theme = {
	fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

function plain(text: string): string {
	return text.replace(/\x1b\[[0-9;]*m/g, "");
}

const plan = {
	title: "OAuth migration",
	status: "approved" as const,
	revision: 2,
	planPath: "/home/test/.pi/agent/plans/oauth/revisions/r2.md",
	steps: [
		"Add OAuth configuration",
		"Implement callback validation",
		"Add session integration tests",
		"Document rollback behavior",
		"Run the full verification suite",
	],
	terminalRows: 10,
};

describe("Plan Mode widgets", () => {
	it("renders the Unicode read-only mode label and progressively drops the hint", () => {
		const wide = plain(renderModeWidget(80, theme).join("\n"));
		expect(wide).toContain("⏸ PLAN MODE · READ-ONLY");
		expect(wide).toContain("/plan off · Ctrl+Alt+P");

		const narrow = plain(renderModeWidget(24, theme).join("\n"));
		expect(narrow).toContain("⏸ PLAN MODE");
		expect(narrow).not.toContain("Ctrl+Alt+P");
	});

	it("keeps steps collapsed by default", () => {
		const rendered = plain(renderPlanWidget({ ...plan, expanded: false }, 100, theme).join("\n"));
		expect(rendered).toContain("APPROVED · r2");
		expect(rendered).toContain("5 steps");
		expect(rendered).toContain("Ctrl+Alt+O expand");
		expect(rendered).not.toContain(plan.planPath);
		expect(rendered).not.toContain("1. Add OAuth configuration");
	});

	it("caps expanded steps from terminal height and reports overflow", () => {
		const rendered = plain(renderPlanWidget({ ...plan, expanded: true }, 100, theme).join("\n"));
		expect(rendered).toContain(plan.planPath);
		expect(rendered).toContain("1. Add OAuth configuration");
		expect(rendered).toContain("3. Add session integration tests");
		expect(rendered).not.toContain("4. Document rollback behavior");
		expect(rendered).toContain("… +2 more");
		expect(rendered).toContain("Ctrl+Alt+O collapse");
	});

	it("renders implementing and completed work independently from document approval", () => {
		const implementing = plain(renderPlanWidget({
			...plan,
			workStatus: "implementing",
			approvedHash: `sha256:${"a".repeat(64)}`,
			expanded: false,
		}, 100, theme).join("\n"));
		expect(implementing).toContain("IMPLEMENTING · r2");
		const completed = plain(renderPlanWidget({
			...plan,
			workStatus: "completed",
			approvedHash: `sha256:${"a".repeat(64)}`,
			expanded: true,
		}, 100, theme).join("\n"));
		expect(completed).toContain("COMPLETED · r2");
		expect(completed).toContain("Document: APPROVED");
		expect(completed).toContain("Approved hash: sha256:");
	});

	it("renders compact and expandable lifecycle events", () => {
		const data = {
			kind: "completed" as const,
			title: plan.title,
			planId: "plan-1",
			revision: 2,
			planPath: plan.planPath,
			approvedHash: `sha256:${"a".repeat(64)}`,
			source: "agent" as const,
			summary: "Implemented OAuth",
			verification: ["pnpm test"],
		};
		expect(plain(renderPlanLifecycleEvent(data, 100, theme, false).join("\n")))
			.toBe("✓ PLAN COMPLETED · OAuth migration · r2");
		const expanded = plain(renderPlanLifecycleEvent(data, 100, theme, true).join("\n"));
		expect(expanded).toContain("Summary: Implemented OAuth");
		expect(expanded).toContain("Verified: pnpm test");
		expect(expanded).toContain("Plan ID: plan-1");
	});

	it("renders a compact width-safe approval event", () => {
		const wide = plain(renderPlanApprovedEvent({ title: plan.title, revision: 2, stepCount: 5 }, 100, theme).join("\n"));
		expect(wide).toBe("✓ PLAN APPROVED · OAuth migration · r2 · 5 steps");
		const narrow = plain(renderPlanApprovedEvent({ title: plan.title, revision: 2, stepCount: 5 }, 16, theme).join("\n"));
		expect(narrow).toContain("PLAN APPROVED");
		expect(narrow).not.toContain("OAuth migration");
	});

	it("never renders a line wider than the supplied viewport", () => {
		for (const width of [8, 16, 24, 40, 80]) {
			for (const line of renderModeWidget(width, theme)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			for (const line of renderPlanWidget({ ...plan, expanded: true }, width, theme)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			for (const line of renderPlanApprovedEvent({ title: plan.title, revision: 2, stepCount: 5 }, width, theme)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
			for (const line of renderPlanLifecycleEvent({ kind: "abandoned", title: plan.title, revision: 2 }, width, theme, true)) {
				expect(visibleWidth(line)).toBeLessThanOrEqual(width);
			}
		}
	});

	it("compacts only paths inside the supplied home directory", () => {
		expect(compactPlanPath("/home/test/.pi/agent/plans/p/r1.md", "/home/test")).toBe("~/.pi/agent/plans/p/r1.md");
		expect(compactPlanPath("/workspace/plans/p/r1.md", "/home/test")).toBe("/workspace/plans/p/r1.md");
	});
});
