import { describe, expect, it } from "vitest";
import {
	SUBMIT_PLAN_TOOL,
	getPlanningTools,
	isPlanningToolAllowed,
	withoutManagedTools,
} from "../src/policy.ts";

describe("strict planning tool policy", () => {
	it("keeps known read-only tools and fails closed for everything else", () => {
		const active = ["read", "bash", "edit", "write", "grep", "web_search", "custom_mutator"];
		expect(getPlanningTools(active)).toEqual(["read", "grep", "web_search", SUBMIT_PLAN_TOOL]);
		expect(isPlanningToolAllowed("read")).toBe(true);
		expect(isPlanningToolAllowed("query-docs")).toBe(true);
		expect(isPlanningToolAllowed(SUBMIT_PLAN_TOOL)).toBe(true);
		for (const tool of ["bash", "edit", "write", "custom_mutator"]) {
			expect(isPlanningToolAllowed(tool)).toBe(false);
		}
	});

	it("restores the previous normal tools without leaking submit_plan", () => {
		const saved = ["read", "bash", "edit", SUBMIT_PLAN_TOOL, "read"];
		expect(withoutManagedTools(saved)).toEqual(["read", "bash", "edit"]);
	});
});
