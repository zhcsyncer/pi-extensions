import type { HerdrAgent, HerdrClient } from "../herdr-client.ts";
import { PROTECTED_BRANCHES } from "./brief.ts";

export const WORKING_CONFIRM_TIMEOUT_MS = 5_000;

export type LaunchClient = Pick<
	HerdrClient,
	"listWorktrees" | "createWorktree" | "listAgents" | "startAgent" | "promptAgentUntil"
>;

export interface LaunchDeps {
	client: LaunchClient;
	sourceWorkspaceId: string;
	branch: string;
	brief: string;
	label?: string;
	base?: string;
}

export type LaunchResult =
	| { status: "rejected"; message: string }
	| { status: "started"; workspaceId: string; agentName: string; branch: string }
	| { status: "incomplete"; message: string; workspaceId?: string; branch: string };

export function agentNameFromBranch(branch: string): string {
	const slug = branch.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
	const trimmed = slug.replace(/^[^a-z]+/, "") || "worktree";
	return trimmed.slice(0, 32);
}

export function uniqueAgentName(base: string, taken: Iterable<string>): string {
	const used = new Set(taken);
	if (!used.has(base)) return base;
	for (let index = 2; index < 100; index += 1) {
		const suffix = `-${index}`;
		const name = `${base.slice(0, Math.max(1, 32 - suffix.length))}${suffix}`;
		if (!used.has(name)) return name;
	}
	throw new Error("Could not allocate a unique Herdr agent name.");
}

function takenAgentNames(agents: readonly HerdrAgent[]): string[] {
	return agents.flatMap((agent) => agent.name ? [agent.name] : []);
}

export async function launchWorktreeSession(deps: LaunchDeps): Promise<LaunchResult> {
	if (PROTECTED_BRANCHES.has(deps.branch)) {
		return { status: "rejected", message: `Refusing to dispatch to ${deps.branch}.` };
	}

	const listed = await deps.client.listWorktrees({ workspaceId: deps.sourceWorkspaceId });
	const existing = listed.find((worktree) => worktree.branch === deps.branch && worktree.isLinkedWorktree);
	if (existing) {
		return {
			status: "rejected",
			message: `A linked worktree for ${deps.branch} already exists.`,
		};
	}

	const created = await deps.client.createWorktree({
		workspaceId: deps.sourceWorkspaceId,
		branch: deps.branch,
		...(deps.base ? { base: deps.base } : {}),
		label: deps.label ?? deps.branch,
		focus: true,
	});
	const workspaceId = created.workspace.workspaceId;
	if (!created.workspace.worktree?.isLinkedWorktree && !created.worktree.isLinkedWorktree) {
		return {
			status: "incomplete",
			message: "Herdr created a workspace that is not a linked worktree.",
			workspaceId,
			branch: deps.branch,
		};
	}

	try {
		const agents = await deps.client.listAgents();
		const agentName = uniqueAgentName(agentNameFromBranch(deps.branch), takenAgentNames(agents));
		await deps.client.startAgent({
			name: agentName,
			kind: "pi",
			paneId: created.rootPaneId,
			args: [],
		});
		await deps.client.promptAgentUntil(agentName, deps.brief, {
			until: "working",
			timeoutMs: WORKING_CONFIRM_TIMEOUT_MS,
		});
		return { status: "started", workspaceId, agentName, branch: deps.branch };
	} catch (error) {
		return {
			status: "incomplete",
			message: error instanceof Error ? error.message : String(error),
			workspaceId,
			branch: deps.branch,
		};
	}
}
