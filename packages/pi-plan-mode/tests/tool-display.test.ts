import type { Theme } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import { describe, expect, it } from "vitest";
import {
	parseReviewAnnotations,
	renderCompletePlanCall,
	renderCompletePlanResult,
	renderSubmitPlanCall,
	renderSubmitPlanResult,
} from "../src/tool-display.ts";

const theme = {
	fg: (_color: string, text: string) => `\x1b[36m${text}\x1b[39m`,
	bold: (text: string) => `\x1b[1m${text}\x1b[22m`,
} as unknown as Theme;

function plain(lines: string[]): string {
	return lines.join("\n").replace(/\x1b\[[0-9;]*m/g, "");
}

const args = {
	title: "Add cache invalidation",
	markdown: "# Goal\n\nA very long Plan body that must never be rendered.\n",
};

function submitHarness(expanded = false) {
	const state = {} as any;
	const callContext = { state, expanded } as any;
	const call = renderSubmitPlanCall(args, theme, callContext);
	return {
		state,
		call,
		result(result: any, isError = false) {
			return renderSubmitPlanResult(result, { expanded, isPartial: false }, theme, {
				state,
				args,
				isError,
				expanded,
			} as any);
		},
	};
}

describe("Plan tool display", () => {
	it("renders a compact width-safe reviewing line without Plan Markdown", () => {
		const harness = submitHarness();
		const rendered = plain(harness.call.render(40));
		expect(rendered).toContain("Reviewing Plan");
		expect(rendered).not.toContain("very long Plan body");
		for (const width of [8, 16, 24, 40]) {
			for (const line of harness.call.render(width)) expect(visibleWidth(line)).toBeLessThanOrEqual(width);
		}
	});

	it("summarizes requested changes and reveals persisted annotations when expanded", () => {
		const content = "The user reviewed plan p r2 and requested changes.\n\n1. Step 2: add rollback handling\n2. Verification: add an integration test";
		const collapsed = submitHarness(false);
		const collapsedResult = collapsed.result({
			content: [{ type: "text", text: content }],
			details: { kind: "changes_requested", planId: "p", revision: 2, planPath: "/plans/p/r2.md" },
		});
		expect(plain(collapsed.call.render(100))).toBe("● Plan changes requested · Add cache invalidation · r2");
		expect(plain(collapsedResult.render(100))).toContain("2 annotations");
		expect(plain(collapsedResult.render(100))).not.toContain("rollback handling");

		const expanded = submitHarness(true);
		const expandedResult = expanded.result({
			content: [{ type: "text", text: content }],
			details: { kind: "changes_requested", planId: "p", revision: 2, planPath: "/plans/p/r2.md" },
		});
		const audit = plain(expandedResult.render(100));
		expect(audit).toContain("Annotations");
		expect(audit).toContain("1. Step 2: add rollback handling");
		expect(audit).toContain("2. Verification: add an integration test");
		expect(audit).toContain("Plan ID: p");
		expect(audit).toContain("Plan: /plans/p/r2.md");
	});

	it("does not guess annotation counts for unstructured feedback", () => {
		const parsed = parseReviewAnnotations("Feedback header\n\nPlease handle rollback.\nAlso inspect retries.");
		expect(parsed).toEqual({ raw: "Please handle rollback.\nAlso inspect retries." });
		const harness = submitHarness(false);
		const result = harness.result({
			content: [{ type: "text", text: "Feedback header\n\nPlease handle rollback.\nAlso inspect retries." }],
			details: { kind: "changes_requested", revision: 1 },
		});
		expect(plain(result.render(100))).toContain("Review annotations available");
	});

	it("caps expanded annotation output by visual lines", () => {
		const annotations = Array.from({ length: 20 }, (_, index) => `${index + 1}. Annotation ${index + 1}`).join("\n");
		const harness = submitHarness(true);
		const result = harness.result({
			content: [{ type: "text", text: `Header\n\n${annotations}` }],
			details: { kind: "changes_requested", revision: 3 },
		});
		const rendered = plain(result.render(60));
		expect(rendered).toContain("… +8 more lines");
		expect(rendered).not.toContain("20. Annotation 20");
	});

	it("hides an approved submit node when collapsed and reveals audit metadata when expanded", () => {
		const collapsed = submitHarness(false);
		const collapsedResult = collapsed.result({
			content: [{ type: "text", text: "approved" }],
			details: {
				kind: "approved",
				planId: "p",
				revision: 2,
				planPath: "/plans/p/r2.md",
				approvedHash: `sha256:${"a".repeat(64)}`,
			},
		});
		expect(collapsed.call.render(100)).toEqual([]);
		expect(collapsedResult.render(100)).toEqual([]);

		const expanded = submitHarness(true);
		const expandedResult = expanded.result({
			content: [{ type: "text", text: "approved" }],
			details: {
				kind: "approved",
				planId: "p",
				revision: 2,
				planPath: "/plans/p/r2.md",
				approvedHash: `sha256:${"a".repeat(64)}`,
			},
		});
		expect(plain(expanded.call.render(100))).toContain("Submit Plan · Add cache invalidation · r2");
		expect(plain(expandedResult.render(100))).toContain("Approved hash: sha256:");
	});

	it("keeps cancelled and failed submissions visible", () => {
		const cancelled = submitHarness(false);
		cancelled.result({
			content: [{ type: "text", text: "Plan review was cancelled: interrupted" }],
			details: { kind: "cancelled", revision: 1 },
		});
		expect(plain(cancelled.call.render(100))).toContain("Plan review cancelled");

		const failed = submitHarness(false);
		failed.result({
			content: [{ type: "text", text: "Plan revision was not saved: disk full" }],
			details: { kind: "storage_error" },
		});
		expect(plain(failed.call.render(100))).toContain("Plan submission failed · disk full");
	});

	it("hides successful complete_plan nodes but keeps expanded completion audit", () => {
		const completeArgs = {
			planId: "p",
			revision: 2,
			summary: "Implemented cache invalidation",
			verification: ["pnpm test"],
		};
		const state = {} as any;
		const call = renderCompletePlanCall(completeArgs, theme, { state, expanded: false } as any);
		const result = renderCompletePlanResult({
			content: [{ type: "text", text: "complete" }],
			details: {
				kind: "completed",
				planId: "p",
				revision: 2,
				summary: completeArgs.summary,
				verification: completeArgs.verification,
				planPath: "/plans/p/r2.md",
			},
		}, { expanded: false, isPartial: false }, theme, { state, args: completeArgs, isError: false } as any);
		expect(call.render(100)).toEqual([]);
		expect(result.render(100)).toEqual([]);

		const expandedState = {} as any;
		const expandedCall = renderCompletePlanCall(completeArgs, theme, { state: expandedState, expanded: true } as any);
		const expandedResult = renderCompletePlanResult({
			content: [{ type: "text", text: "complete" }],
			details: {
				kind: "completed",
				planId: "p",
				revision: 2,
				summary: completeArgs.summary,
				verification: completeArgs.verification,
				planPath: "/plans/p/r2.md",
			},
		}, { expanded: true, isPartial: false }, theme, { state: expandedState, args: completeArgs, isError: false } as any);
		expect(plain(expandedCall.render(100))).toContain("Complete Plan · r2");
		expect(plain(expandedResult.render(100))).toContain("Verified: pnpm test");
	});
});
