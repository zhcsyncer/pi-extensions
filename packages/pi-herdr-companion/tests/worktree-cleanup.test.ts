import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { HerdrWorkspace } from "../src/herdr-client.ts";
import { cleanupCurrentWorktree } from "../src/worktree/cleanup.ts";
import { registerHerdrWorktreeCommand } from "../src/worktree/command.ts";
import { HERDR_WORKTREE_USAGE, parseHerdrWorktreeCommand } from "../src/worktree/router.ts";

type Call = { command: string; args: string[]; options: ExecOptions };

const CHECKOUT = "/worktrees/repo/feat-cleanup";
const BRANCH = "feat/cleanup";

function ok(stdout = ""): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false };
}

function linkedWorkspace(overrides: Partial<HerdrWorkspace["worktree"]> = {}): HerdrWorkspace {
	return {
		workspaceId: "w1",
		label: "feat-cleanup",
		worktree: {
			checkoutPath: CHECKOUT,
			isLinkedWorktree: true,
			repoRoot: "/repo",
			...overrides,
		},
	};
}

function harness(options: {
	workspace?: HerdrWorkspace;
	workspaceId?: string;
	keepBranch?: boolean;
	confirm?: boolean;
	branch?: string;
	dirty?: string;
	git?: (args: string[]) => ExecResult | Promise<ExecResult>;
} = {}) {
	const ops: string[] = [];
	const calls: Call[] = [];
	const confirms: string[] = [];
	let removed = 0;
	const exec = async (command: string, args: string[], execOptions: ExecOptions) => {
		calls.push({ command, args: [...args], options: { ...execOptions } });
		ops.push([command, ...args].join(" "));
		if (command !== "git") return ok();
		if (options.git) return options.git(args);
		if (args[0] === "branch" && args[1] === "--show-current") return ok(`${options.branch ?? BRANCH}\n`);
		if (args[0] === "status") return ok(options.dirty ?? "");
		return ok();
	};
	const client = {
		async getWorkspace(workspaceId: string) {
			ops.push(`herdr workspace get ${workspaceId}`);
			return options.workspace ?? linkedWorkspace();
		},
		async removeWorktree(workspaceId: string) {
			removed += 1;
			ops.push(`herdr worktree remove --workspace ${workspaceId}`);
		},
	};
	return {
		ops,
		calls,
		confirms,
		get removed() { return removed; },
		run: () => cleanupCurrentWorktree({
			client,
			exec,
			runtime: { workspaceId: options.workspaceId ?? "w1" },
			keepBranch: options.keepBranch ?? false,
			ui: {
				async confirm(_title, message) {
					confirms.push(message);
					return options.confirm ?? true;
				},
			},
		}),
	};
}

describe("/herdr-worktree parser", () => {
	it("accepts only cleanup and cleanup --keep-branch", () => {
		expect(parseHerdrWorktreeCommand("cleanup")).toEqual({ kind: "cleanup", keepBranch: false });
		expect(parseHerdrWorktreeCommand("  cleanup   --keep-branch  ")).toEqual({ kind: "cleanup", keepBranch: true });
		expect(parseHerdrWorktreeCommand("")).toEqual({ kind: "usage" });
		expect(parseHerdrWorktreeCommand("create")).toEqual({ kind: "usage" });
		expect(parseHerdrWorktreeCommand("cleanup --force")).toEqual({ kind: "usage" });
		expect(parseHerdrWorktreeCommand("cleanup --keep-branch extra")).toEqual({ kind: "usage" });
		expect(HERDR_WORKTREE_USAGE).toContain("/herdr-worktree cleanup");
		expect(HERDR_WORKTREE_USAGE).toContain("--keep-branch");
		expect(HERDR_WORKTREE_USAGE).not.toContain("--force");
	});
});

describe("/herdr-worktree cleanup guards", () => {
	it("hard-rejects main and master without asking or mutating", async () => {
		for (const branch of ["main", "master"]) {
			const h = harness({ branch, confirm: true });
			await expect(h.run()).resolves.toMatchObject({
				status: "rejected",
				message: `Refusing to remove a worktree checked out on ${branch}.`,
			});
			expect(h.confirms).toEqual([]);
			expect(h.removed).toBe(0);
			expect(h.ops.some((op) => op.includes("checkout") || op.includes("branch -D") || op.includes("worktree remove"))).toBe(false);
		}
	});

	it("hard-rejects the primary checkout before git or confirm", async () => {
		const h = harness({
			workspace: {
				workspaceId: "w1",
				worktree: { checkoutPath: "/repo", isLinkedWorktree: false },
			},
		});
		await expect(h.run()).resolves.toMatchObject({
			status: "rejected",
			message: expect.stringContaining("primary checkout"),
		});
		expect(h.confirms).toEqual([]);
		expect(h.calls).toEqual([]);
		expect(h.removed).toBe(0);
	});

	it("hard-rejects a workspace with no worktree provenance as primary", async () => {
		const h = harness({ workspace: { workspaceId: "w1" } });
		await expect(h.run()).resolves.toMatchObject({ status: "rejected" });
		expect(h.calls).toEqual([]);
		expect(h.removed).toBe(0);
	});

	it("hard-rejects a dirty tree without asking or mutating", async () => {
		const h = harness({ dirty: " M src/extension.ts\n" });
		await expect(h.run()).resolves.toMatchObject({
			status: "rejected",
			message: expect.stringContaining("dirty worktree"),
		});
		expect(h.confirms).toEqual([]);
		expect(h.removed).toBe(0);
		expect(h.ops.some((op) => op.includes("checkout") || op.includes("branch -D") || op.includes("worktree remove"))).toBe(false);
	});

	it("hard-rejects a detached HEAD unless --keep-branch is set", async () => {
		const h = harness({ branch: "" });
		await expect(h.run()).resolves.toMatchObject({
			status: "rejected",
			message: expect.stringContaining("HEAD is detached"),
		});
		expect(h.confirms).toEqual([]);
		expect(h.removed).toBe(0);
	});

	it("does not mutate when the user cancels confirm", async () => {
		const h = harness({ confirm: false });
		await expect(h.run()).resolves.toEqual({ status: "cancelled" });
		expect(h.confirms).toEqual([`Remove this worktree and delete local branch ${BRANCH}?`]);
		expect(h.removed).toBe(0);
		expect(h.ops).toEqual([
			"herdr workspace get w1",
			"git branch --show-current",
			"git status --porcelain",
		]);
	});
});

describe("/herdr-worktree cleanup mutations", () => {
	it("detaches, deletes the local branch, then asks Herdr to remove the worktree", async () => {
		const h = harness({ confirm: true });
		await expect(h.run()).resolves.toEqual({
			status: "removed",
			keepBranch: false,
			branch: BRANCH,
		});
		expect(h.confirms).toEqual([`Remove this worktree and delete local branch ${BRANCH}?`]);
		expect(h.ops).toEqual([
			"herdr workspace get w1",
			"git branch --show-current",
			"git status --porcelain",
			"git checkout --detach",
			`git branch -D -- ${BRANCH}`,
			"herdr worktree remove --workspace w1",
		]);
		expect(h.calls.filter((call) => call.command === "git").every((call) => call.options.cwd === CHECKOUT)).toBe(true);
		expect(h.ops.some((op) => op.includes("workspace close") || op.includes("--keep-branch") || op.includes("--force"))).toBe(false);
	});

	it("skips detach and branch deletion when --keep-branch is set", async () => {
		const h = harness({ keepBranch: true, confirm: true });
		await expect(h.run()).resolves.toEqual({
			status: "removed",
			keepBranch: true,
			branch: BRANCH,
		});
		expect(h.confirms).toEqual([`Remove this worktree and keep local branch ${BRANCH}?`]);
		expect(h.ops).toEqual([
			"herdr workspace get w1",
			"git branch --show-current",
			"git status --porcelain",
			"herdr worktree remove --workspace w1",
		]);
		expect(h.ops.some((op) => op.includes("checkout") || op.includes("branch -D"))).toBe(false);
	});

	it("can remove a clean detached linked worktree with --keep-branch", async () => {
		const h = harness({ keepBranch: true, branch: "", confirm: true });
		await expect(h.run()).resolves.toEqual({ status: "removed", keepBranch: true });
		expect(h.confirms).toEqual(["Remove this worktree? The current checkout has no local branch."]);
		expect(h.ops.at(-1)).toBe("herdr worktree remove --workspace w1");
		expect(h.ops.some((op) => op.includes("checkout") || op.includes("branch -D"))).toBe(false);
	});
});

describe("/herdr-worktree command", () => {
	it("prints usage for unimplemented subcommands and does not touch git or Herdr", async () => {
		const notifications: Array<{ message: string; type?: string }> = [];
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		registerHerdrWorktreeCommand({
			registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, definition);
			},
		} as unknown as ExtensionAPI, {
			runtime: { inside: true, workspaceId: "w1", paneId: "w1:p1", socketPath: "/tmp/herdr.sock" },
			client: {
				getWorkspace: async () => {
					throw new Error("workspace get should not run");
				},
				removeWorktree: async () => {
					throw new Error("worktree remove should not run");
				},
			},
			exec: async () => {
				throw new Error("git should not run");
			},
		});
		const command = commands.get("herdr-worktree");
		expect(command).toBeDefined();
		await command!.handler("open", {
			ui: {
				notify(message: string, type?: string) { notifications.push({ message, type }); },
				async confirm() { throw new Error("confirm should not run"); },
			},
		});
		expect(notifications).toEqual([{ message: HERDR_WORKTREE_USAGE, type: "info" }]);
	});
});
