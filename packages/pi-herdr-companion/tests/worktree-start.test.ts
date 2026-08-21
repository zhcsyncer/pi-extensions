import type { ExecOptions, ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import type { HerdrAgent, HerdrWorktreeCheckout, HerdrWorkspace } from "../src/herdr-client.ts";
import {
	NOT_READY_PREFIX,
	buildDistillInstruction,
	lastAssistantText,
	parseDispatchBrief,
	serializeSessionForDistill,
	sessionHasDistillableConversation,
} from "../src/worktree/brief.ts";
import { registerHerdrWorktreeCommand } from "../src/worktree/command.ts";
import {
	WORKING_CONFIRM_TIMEOUT_MS,
	agentNameFromBranch,
	launchWorktreeSession,
	uniqueAgentName,
} from "../src/worktree/launch.ts";
import { HERDR_WORKTREE_USAGE, parseHerdrWorktreeCommand } from "../src/worktree/router.ts";

function ok(stdout = ""): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false };
}

describe("/herdr-worktree start parser and brief", () => {
	it("accepts start with an optional branch and rejects extra tokens", () => {
		expect(parseHerdrWorktreeCommand("start")).toEqual({ kind: "start" });
		expect(parseHerdrWorktreeCommand("  start   feat/foo  ")).toEqual({ kind: "start", branch: "feat/foo" });
		expect(parseHerdrWorktreeCommand("start --keep-branch")).toEqual({ kind: "usage" });
		expect(parseHerdrWorktreeCommand("start feat/foo extra")).toEqual({ kind: "usage" });
		expect(HERDR_WORKTREE_USAGE).toContain("/herdr-worktree start");
		expect(HERDR_WORKTREE_USAGE).toContain("/herdr-worktree cleanup");
	});

	it("parses a ready brief, pinned branch, NOT_READY, and protected names", () => {
		expect(parseDispatchBrief("Branch: feat/foo\n目标：修清理\n1. 写测试")).toEqual({
			status: "ready",
			branch: "feat/foo",
			brief: "Branch: feat/foo\n目标：修清理\n1. 写测试",
		});
		expect(parseDispatchBrief("Branch: other\nkeep me", "feat/pinned")).toMatchObject({
			status: "ready",
			branch: "feat/pinned",
		});
		expect(parseDispatchBrief(`${NOT_READY_PREFIX} 还没收敛`)).toEqual({
			status: "not-ready",
			reason: "还没收敛",
		});
		expect(parseDispatchBrief("Branch: main\n目标：不要")).toMatchObject({ status: "invalid" });
		expect(parseDispatchBrief("没有分支头\n只有计划")).toMatchObject({ status: "invalid" });
		expect(sessionHasDistillableConversation([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "调查完了" }] } },
		])).toBe(true);
		expect(sessionHasDistillableConversation([])).toBe(false);
		expect(lastAssistantText([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "hi" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "计划正文" }] } },
		])).toBe("计划正文");
		expect(buildDistillInstruction("feat/foo")).toContain("Branch: feat/foo");
		expect(serializeSessionForDistill([
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "目标是修清理" }] } },
			{ type: "message", message: { role: "assistant", content: [{ type: "text", text: "可以做" }] } },
		])).toContain("User:\n目标是修清理");
	});

	it("slugs agent names to Herdr's live-name rules", () => {
		expect(agentNameFromBranch("feat/herdr-companion-cleanup-worktree")).toBe("feat-herdr-companion-cleanup-wor");
		expect(uniqueAgentName("feat-foo", ["feat-foo", "feat-foo-2"])).toBe("feat-foo-3");
	});
});

describe("/herdr-worktree start launch", () => {
	function launchHarness(options: {
		existing?: HerdrWorktreeCheckout[];
		agents?: HerdrAgent[];
		failStart?: Error;
		failPrompt?: Error;
	} = {}) {
		const ops: string[] = [];
		const prompts: string[] = [];
		const client = {
			async listWorktrees() {
				ops.push("herdr worktree list");
				return options.existing ?? [];
			},
			async createWorktree(input: { branch: string; workspaceId?: string; focus?: boolean; base?: string }) {
				ops.push([
					"herdr worktree create",
					input.workspaceId ? `--workspace ${input.workspaceId}` : "",
					`--branch ${input.branch}`,
					input.base ? `--base ${input.base}` : "",
					input.focus ? "--focus" : "--no-focus",
				].filter(Boolean).join(" "));
				return {
					workspace: {
						workspaceId: "w9",
						worktree: { checkoutPath: "/worktrees/repo/feat-foo", isLinkedWorktree: true },
					} satisfies HerdrWorkspace,
					rootPaneId: "w9:p1",
					worktree: { path: "/worktrees/repo/feat-foo", branch: input.branch, isLinkedWorktree: true },
				};
			},
			async listAgents() {
				ops.push("herdr agent list");
				return options.agents ?? [];
			},
			async startAgent(input: { name: string; kind: string; paneId: string }) {
				ops.push(`herdr agent start ${input.name} --kind ${input.kind} --pane ${input.paneId}`);
				if (options.failStart) throw options.failStart;
			},
			async promptAgentUntil(target: string, prompt: string, wait: { until: string; timeoutMs: number }) {
				ops.push(`herdr agent prompt ${target} --wait --until ${wait.until} --timeout ${wait.timeoutMs}`);
				prompts.push(prompt);
				if (options.failPrompt) throw options.failPrompt;
				return { paneId: "w9:p1", name: target, status: "working" };
			},
		};
		return { ops, prompts, client };
	}

	it("refuses main and an already-open linked branch before creating", async () => {
		const existing = launchHarness({
			existing: [{ path: "/worktrees/repo/feat-foo", branch: "feat/foo", isLinkedWorktree: true, openWorkspaceId: "w2" }],
		});
		await expect(launchWorktreeSession({
			client: existing.client,
			sourceWorkspaceId: "w1",
			branch: "feat/foo",
			brief: "Branch: feat/foo\ndo it",
		})).resolves.toMatchObject({ status: "rejected", message: expect.stringContaining("already exists") });
		expect(existing.ops).toEqual(["herdr worktree list"]);

		await expect(launchWorktreeSession({
			client: launchHarness().client,
			sourceWorkspaceId: "w1",
			branch: "main",
			brief: "Branch: main\ndo it",
		})).resolves.toMatchObject({ status: "rejected", message: expect.stringContaining("main") });
	});

	it("creates a focused worktree, starts Pi, and waits only until working", async () => {
		const h = launchHarness();
		const brief = "Branch: feat/foo\n目标：做完\n1. 改代码";
		await expect(launchWorktreeSession({
			client: h.client,
			sourceWorkspaceId: "w1",
			branch: "feat/foo",
			brief,
		})).resolves.toEqual({
			status: "started",
			workspaceId: "w9",
			agentName: "feat-foo",
			branch: "feat/foo",
		});
		expect(h.ops).toEqual([
			"herdr worktree list",
			"herdr worktree create --workspace w1 --branch feat/foo --focus",
			"herdr agent list",
			"herdr agent start feat-foo --kind pi --pane w9:p1",
			`herdr agent prompt feat-foo --wait --until working --timeout ${WORKING_CONFIRM_TIMEOUT_MS}`,
		]);
		expect(h.prompts).toEqual([brief]);
		expect(h.ops.join("\n")).not.toContain("--keep-branch");
		expect(h.ops.join("\n")).not.toContain("--force");
		expect(h.ops.join("\n")).not.toContain("--until idle");
		expect(h.ops.join("\n")).not.toContain("workspace close");
	});

	it("keeps the created workspace id when start or prompt fails", async () => {
		const h = launchHarness({ failPrompt: new Error("agent_prompt_stalled") });
		await expect(launchWorktreeSession({
			client: h.client,
			sourceWorkspaceId: "w1",
			branch: "feat/foo",
			brief: "Branch: feat/foo\ndo it",
		})).resolves.toEqual({
			status: "incomplete",
			message: "agent_prompt_stalled",
			workspaceId: "w9",
			branch: "feat/foo",
		});
	});
});

describe("/herdr-worktree start command", () => {
	function commandHarness(options: {
		idle?: boolean;
		entries?: Array<{ type?: string; message?: { role?: string; content?: unknown } }>;
		editor?: string | undefined;
		workspaceId?: string;
		draft?: string;
	} = {}) {
		const notifications: Array<{ message: string; type?: string }> = [];
		const appended: unknown[] = [];
		const distillCalls: unknown[] = [];
		const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
		const created: string[] = [];
		const launch = {
			listWorktrees: async () => [],
			async createWorktree(input: { branch: string }) {
				created.push(input.branch);
				return {
					workspace: { workspaceId: "w9", worktree: { checkoutPath: "/wt", isLinkedWorktree: true } },
					rootPaneId: "w9:p1",
					worktree: { path: "/wt", branch: input.branch, isLinkedWorktree: true },
				};
			},
			listAgents: async () => [],
			startAgent: async () => undefined,
			promptAgentUntil: async () => ({ paneId: "w9:p1", name: "feat-foo", status: "working" }),
			getWorkspace: async () => {
				throw new Error("workspace get should not run");
			},
			removeWorktree: async () => {
				throw new Error("remove should not run");
			},
		};

		const pi = {
			on() {},
			registerCommand(name: string, definition: { handler: (args: string, ctx: unknown) => Promise<void> }) {
				commands.set(name, definition);
			},
			registerMessageRenderer() {},
			registerEntryRenderer() {},
			sendMessage() {
				throw new Error("session turn should not run");
			},
			appendEntry(type: string, data: unknown) { appended.push({ type, data }); },
		} as unknown as ExtensionAPI;

		const draft = options.draft ?? "Branch: feat/foo\n目标：做\n1. 写";
		registerHerdrWorktreeCommand(pi, {
			runtime: { inside: true, workspaceId: options.workspaceId ?? "w1", paneId: "w1:p1", socketPath: "/tmp/herdr.sock" },
			client: launch,
			exec: async (_command: string, _args: string[], _execOptions: ExecOptions) => ok(),
			completeModel: async (model, context) => {
				distillCalls.push({ model, systemPrompt: context.systemPrompt, user: context.messages[0]?.content[0]?.text });
				return { content: [{ type: "text", text: draft }] };
			},
		});

		const entries = options.entries ?? [
			{ type: "message", message: { role: "user", content: [{ type: "text", text: "需求已经明确了" }] } },
		];
		const ctx = {
			isIdle: () => options.idle ?? true,
			model: { provider: "test", id: "model" },
			modelRegistry: {
				async getApiKeyAndHeaders() {
					return { ok: true, apiKey: "test-key" };
				},
			},
			sessionManager: { getEntries: () => entries },
			ui: {
				notify(message: string, type?: string) { notifications.push({ message, type }); },
				async confirm() { return false; },
				async editor(_title: string, prefill?: string) {
					return options.editor === undefined && !("editor" in options) ? prefill : options.editor;
				},
			},
		};
		return { commands, notifications, appended, distillCalls, entries, ctx, created };
	}

	it("prints usage for unimplemented subcommands", async () => {
		const h = commandHarness();
		await h.commands.get("herdr-worktree")!.handler("open", h.ctx);
		expect(h.notifications).toEqual([{ message: HERDR_WORKTREE_USAGE, type: "info" }]);
		expect(h.distillCalls).toEqual([]);
	});

	it("rejects start when there is no conversation or the session is busy", async () => {
		const empty = commandHarness({ entries: [] });
		await empty.commands.get("herdr-worktree")!.handler("start", empty.ctx);
		expect(empty.notifications[0]?.message).toMatch(/no conversation/);
		expect(empty.distillCalls).toEqual([]);

		const busy = commandHarness({ idle: false });
		await busy.commands.get("herdr-worktree")!.handler("start feat/foo", busy.ctx);
		expect(busy.notifications[0]?.message).toMatch(/idle/);
		expect(busy.distillCalls).toEqual([]);
	});

	it("distills outside the session turn and does not launch on NOT_READY or cancel", async () => {
		const notReady = commandHarness({ draft: `${NOT_READY_PREFIX} 还没写清目标` });
		await notReady.commands.get("herdr-worktree")!.handler("start feat/foo", notReady.ctx);
		expect(notReady.distillCalls).toHaveLength(1);
		expect((notReady.distillCalls[0] as { systemPrompt: string }).systemPrompt).toBe(buildDistillInstruction("feat/foo"));
		expect(notReady.notifications.some((item) => item.message.includes("not ready"))).toBe(true);
		expect(notReady.created).toEqual([]);
		expect(notReady.appended).toEqual([]);

		const cancelled = commandHarness({ editor: undefined });
		await cancelled.commands.get("herdr-worktree")!.handler("start feat/foo", cancelled.ctx);
		expect(cancelled.notifications.some((item) => item.message.includes("cancelled"))).toBe(true);
		expect(cancelled.created).toEqual([]);
		expect(cancelled.appended).toEqual([]);
	});

	it("launches with the edited brief after review and only then writes transcript", async () => {
		const edited = "Branch: feat/foo\n目标：只做这一件\n1. 改 companion";
		const h = commandHarness({ editor: edited });
		await h.commands.get("herdr-worktree")!.handler("start feat/foo", h.ctx);
		expect(h.created).toEqual(["feat/foo"]);
		expect(h.appended).toEqual([{
			type: "herdr-worktree-dispatched",
			data: { branch: "feat/foo", workspaceId: "w9", brief: edited },
		}]);
	});
});
