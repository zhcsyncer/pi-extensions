import { describe, expect, it } from "vitest";
import {
	closePlanWork,
	createImplementingWork,
	isCompletableWork,
	migrateStoredPlanSessionState,
	parseStoredPlanSessionState,
} from "../src/lifecycle.ts";
import type { LegacyPlanSessionState, PlanMetadata } from "../src/types.ts";

const planId = "20260723T140506-lifecycle-a1b2c3d4";
const approvedHash = `sha256:${"a".repeat(64)}`;

function metadata(status: "draft" | "approved"): PlanMetadata {
	return {
		version: 2,
		planId,
		title: "Lifecycle",
		status,
		storage: "persistent",
		sessionId: "session-1",
		cwd: "/repo",
		createdAt: "2026-07-23T14:05:06.000Z",
		updatedAt: "2026-07-23T14:05:06.000Z",
		currentRevision: 1,
		...(status === "approved" ? { approvedRevision: 1, approvedHash } : {}),
		revisions: [{
			revision: 1,
			status,
			path: "revisions/r1.md",
			hash: approvedHash,
			createdAt: "2026-07-23T14:05:06.000Z",
			steps: ["Implement it"],
			...(status === "approved" ? { approvedAt: "2026-07-23T14:05:06.000Z" } : {}),
		}],
	};
}

const legacy: LegacyPlanSessionState = {
	version: 2,
	mode: "normal",
	planId,
	revision: 1,
	normalTools: ["read", "edit"],
};

describe("Plan work lifecycle", () => {
	it("parses V3 branch state and rejects malformed references", () => {
		const parsed = parseStoredPlanSessionState({
			version: 3,
			mode: "normal",
			normalTools: ["read", "read", "edit"],
			work: {
				planId,
				revision: 1,
				approvedHash,
				status: "implementing",
				startedAt: "2026-07-23T14:05:06.000Z",
			},
		});
		expect(parsed).toMatchObject({
			version: 3,
			normalTools: ["read", "edit"],
			work: { planId, revision: 1, status: "implementing" },
		});
		expect(parseStoredPlanSessionState({
			version: 3,
			mode: "normal",
			normalTools: [],
			work: { planId: "../escape", revision: 1, approvedHash, status: "implementing" },
		})).toBeUndefined();
	});

	it("migrates legacy draft pointers to planning and approved pointers to unknown work", () => {
		const draft = migrateStoredPlanSessionState(legacy, metadata("draft"));
		expect(draft).toMatchObject({ version: 3, planning: { planId, revision: 1 } });
		expect(draft.work).toBeUndefined();
		const approved = migrateStoredPlanSessionState(legacy, metadata("approved"));
		expect(approved).toMatchObject({
			version: 3,
			work: { planId, revision: 1, approvedHash, status: "unknown" },
		});
		expect(approved.planning).toBeUndefined();
	});

	it("binds implementing and closed states to an exact approved revision", () => {
		const implementing = createImplementingWork(
			{ planId, revision: 2 },
			approvedHash,
			new Date("2026-07-23T15:00:00.000Z"),
		);
		expect(implementing).toMatchObject({
			planId,
			revision: 2,
			approvedHash,
			status: "implementing",
			startedAt: "2026-07-23T15:00:00.000Z",
		});
		expect(isCompletableWork(implementing)).toBe(true);
		const completed = closePlanWork(implementing, "completed", new Date("2026-07-23T16:00:00.000Z"));
		expect(completed).toMatchObject({ status: "completed", completedAt: "2026-07-23T16:00:00.000Z" });
		expect(isCompletableWork(completed)).toBe(false);
		expect(() => closePlanWork(completed, "abandoned")).toThrow("already completed");
	});
});
