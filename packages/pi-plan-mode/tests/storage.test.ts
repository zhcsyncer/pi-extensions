import { chmod, mkdtemp, readFile, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	approvePlan,
	cleanupReviewWorkspace,
	createTemporaryPlanRoot,
	extractPlanSteps,
	generatePlanId,
	getPlanPaths,
	hashPlanContent,
	isValidPlanId,
	readPlanMetadata,
	removeTemporaryPlanRoot,
	saveSubmittedPlan,
	updatePlanStatus,
	verifyApprovedPlan,
	writeReviewAnnotations,
} from "../src/storage.ts";

const cleanup = new Set<string>();

afterEach(async () => {
	await Promise.all([...cleanup].map((directory) => removeTemporaryPlanRoot(directory)));
	cleanup.clear();
});

async function root(): Promise<string> {
	const directory = await mkdtemp(path.join(tmpdir(), "pi-plan-storage-test-"));
	cleanup.add(directory);
	return directory;
}

describe("plan storage", () => {
	it("generates sortable traversal-safe plan ids", () => {
		const id = generatePlanId("Add OAuth / 登录", new Date("2026-07-23T14:05:06.000Z"), "fixed-random");
		expect(id).toMatch(/^20260723T140506-add-oauth-[a-f0-9]{8}$/);
		expect(isValidPlanId(id)).toBe(true);
		expect(isValidPlanId("../escape")).toBe(false);
	});

	it("extracts display-only top-level execution steps", () => {
		expect(extractPlanSteps(`# Plan\n\n## Execution steps\n\n1. **Change** [policy](./policy.ts) in \`policy_file.ts\`\n   - nested detail\n2) [ ] Run tests\n\n### Notes\n\n3. Still part of the section\n\n## Verification\n\n1. Not a step\n`)).toEqual([
			"Change policy in policy_file.ts",
			"Run tests",
			"Still part of the section",
		]);
		expect(extractPlanSteps(`# 计划\n\n## 执行步骤\n\n1. 修改策略\n2. 运行测试\n\n## 验证\n\n1. 不应提取\n`)).toEqual([
			"修改策略",
			"运行测试",
		]);
		expect(extractPlanSteps("# Plan\n\n## Goal\n\nNo steps.\n")).toEqual([]);
		expect(extractPlanSteps("# 计划\n\n## 实施步骤\n\n1. 不受支持的近似标题\n")).toEqual([]);
	});

	it("creates immutable revisions and points revdiff at the selected base", async () => {
		const directory = await root();
		const planId = generatePlanId("Storage test", new Date("2026-01-01T00:00:00.000Z"), "storage");
		const first = await saveSubmittedPlan({
			root: directory,
			planId,
			title: "Storage test",
			markdown: "# First\n\n## Execution steps\n\n1. First step\n",
			storage: "persistent",
			sessionId: "session-1",
			cwd: "/repo",
			now: new Date("2026-01-01T00:00:00.000Z"),
		});
		expect(first.hasPrevious).toBe(false);
		expect(first.revision).toMatchObject({ revision: 1, status: "draft", steps: ["First step"] });

		await writeReviewAnnotations(first.paths, "Change the title");
		await updatePlanStatus(directory, planId, "changes_requested");
		const second = await saveSubmittedPlan({
			root: directory,
			planId,
			title: "Storage test revised",
			markdown: "# Second\n\n## Execution steps\n\n1. Second step\n",
			storage: "persistent",
			sessionId: "session-1",
			cwd: "/repo",
			basedOn: 1,
			now: new Date("2026-01-01T00:01:00.000Z"),
		});

		expect(second.hasPrevious).toBe(true);
		expect(second.paths.previous).toBe(first.paths.plan);
		expect(await readFile(first.paths.plan, "utf8")).toContain("# First");
		expect(await readFile(second.paths.plan, "utf8")).toContain("# Second");
		expect(await readFile(second.paths.annotations, "utf8").catch(() => undefined)).toBeUndefined();
		const metadata = await readPlanMetadata(directory, planId);
		expect(metadata).toMatchObject({ currentRevision: 2, status: "draft", title: "Storage test revised" });
		expect(metadata?.revisions).toHaveLength(2);
		expect(metadata?.revisions[1]).toMatchObject({ basedOn: 1, path: "revisions/r2.md", steps: ["Second step"] });
		await expect(saveSubmittedPlan({
			root: directory,
			planId,
			title: "Wrong Session",
			markdown: "# Third\n",
			storage: "persistent",
			sessionId: "another-session",
			cwd: "/repo",
		})).rejects.toThrow("another Session");
	});

	it("binds approval to an exact immutable revision and detects tampering", async () => {
		const directory = await root();
		const planId = generatePlanId("Hash test", new Date("2026-01-02T00:00:00.000Z"), "hash");
		const submitted = await saveSubmittedPlan({
			root: directory,
			planId,
			title: "Hash test",
			markdown: "# Approved\n",
			storage: "persistent",
			sessionId: "session-2",
			cwd: "/repo",
		});
		const approved = await approvePlan(directory, planId, 1, submitted.submittedHash);
		expect(approved.approvedRevision).toBe(1);
		expect(approved.approvedHash).toBe(hashPlanContent("# Approved\n"));
		expect((await verifyApprovedPlan(directory, planId)).ok).toBe(true);
		await expect(updatePlanStatus(directory, planId, "draft")).rejects.toThrow("is immutable");

		await writeFile(submitted.paths.plan, "# Tampered\n", "utf8");
		const integrity = await verifyApprovedPlan(directory, planId);
		expect(integrity).toMatchObject({ ok: false, reason: "Plan content no longer matches the approved hash" });
	});

	it("refuses approval if content or current revision changes during review", async () => {
		const directory = await root();
		const planId = generatePlanId("Race test", new Date("2026-01-03T00:00:00.000Z"), "race");
		const first = await saveSubmittedPlan({
			root: directory,
			planId,
			title: "Race test",
			markdown: "# Reviewed\n",
			storage: "persistent",
			sessionId: "session-3",
			cwd: "/repo",
		});
		await writeFile(first.paths.plan, "# Changed while open\n", "utf8");
		await expect(approvePlan(directory, planId, 1, first.submittedHash)).rejects.toThrow("changed during review");

		const otherPlanId = generatePlanId("Revision race", new Date("2026-01-03T00:01:00.000Z"), "revision-race");
		const base = await saveSubmittedPlan({
			root: directory,
			planId: otherPlanId,
			title: "Revision race",
			markdown: "# r1\n",
			storage: "persistent",
			sessionId: "session-3",
			cwd: "/repo",
		});
		await saveSubmittedPlan({
			root: directory,
			planId: otherPlanId,
			title: "Revision race",
			markdown: "# r2\n",
			storage: "persistent",
			sessionId: "session-3",
			cwd: "/repo",
		});
		await expect(approvePlan(directory, otherPlanId, 1, base.submittedHash)).rejects.toThrow("revision changed");
	});

	it("uses private permissions for no-session roots and removes them on shutdown", async () => {
		const parent = await root();
		await chmod(parent, 0o700);
		const temporary = await createTemporaryPlanRoot(parent);
		cleanup.add(temporary);
		expect((await stat(temporary)).mode & 0o777).toBe(0o700);

		const planId = generatePlanId("Temporary", new Date("2026-01-04T00:00:00.000Z"), "temporary");
		const submitted = await saveSubmittedPlan({
			root: temporary,
			planId,
			title: "Temporary",
			markdown: "# Temp\n",
			storage: "temporary",
			sessionId: "memory-session",
			cwd: "/repo",
		});
		expect((await stat(submitted.paths.plan)).mode & 0o777).toBe(0o600);
		expect((await stat(submitted.paths.manifest)).mode & 0o777).toBe(0o600);
		await cleanupReviewWorkspace(temporary, planId);
		await removeTemporaryPlanRoot(temporary);
		cleanup.delete(temporary);
		await expect(stat(temporary)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("rejects invalid ids and revisions before constructing paths", () => {
		expect(() => getPlanPaths("/tmp/plans", "../../etc/passwd")).toThrow("Invalid plan id");
		const planId = generatePlanId("Path test", new Date("2026-01-05T00:00:00.000Z"), "path");
		expect(() => getPlanPaths("/tmp/plans", planId, 0)).toThrow("Invalid plan revision");
	});
});
