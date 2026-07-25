import { describe, expect, it } from "vitest";
import { buildRevdiffArguments, classifyRevdiffResult } from "../src/review.ts";
import type { PlanPaths } from "../src/types.ts";

const paths: PlanPaths = {
	root: "/plans",
	planDir: "/plans/test",
	manifest: "/plans/test/manifest.json",
	revisionsDir: "/plans/test/revisions",
	plan: "/plans/test/revisions/r2.md",
	reviewDir: "/plans/test/.review",
	previous: "/plans/test/revisions/r1.md",
	annotations: "/plans/test/.review/annotations.md",
};

describe("revdiff adapter", () => {
	it("reviews the first submission as one file", () => {
		expect(buildRevdiffArguments({ paths, hasPrevious: false, cwd: "/repo" })).toEqual([
			"--only",
			paths.plan,
			`--output=${paths.annotations}`,
		]);
	});

	it("reviews later immutable revisions as previous-to-current diffs", () => {
		expect(buildRevdiffArguments({ paths, hasPrevious: true, cwd: "/repo" })).toEqual([
			"--compare-old",
			paths.previous,
			"--compare-new",
			paths.plan,
			"--word-diff",
			`--output=${paths.annotations}`,
		]);
	});

	it("distinguishes clean review, requested changes, cancellation, and errors", () => {
		expect(classifyRevdiffResult({ status: 0, signal: null }, "")).toEqual({ kind: "clean" });
		expect(classifyRevdiffResult({ status: 10, signal: null }, "line 4: revise")).toEqual({
			kind: "changes_requested",
			annotations: "line 4: revise",
		});
		expect(classifyRevdiffResult({ status: null, signal: "SIGINT" }, "")).toMatchObject({ kind: "cancelled" });
		expect(classifyRevdiffResult({ status: 2, signal: null }, "")).toEqual({ kind: "error", message: "revdiff exited with code 2" });
		expect(classifyRevdiffResult({ status: 10, signal: null }, "")).toMatchObject({ kind: "error" });
	});
});
