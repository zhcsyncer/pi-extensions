export type HerdrWorktreeRoute =
	| { kind: "cleanup"; keepBranch: boolean }
	| { kind: "start"; branch?: string }
	| { kind: "usage" };

export const HERDR_WORKTREE_USAGE = `/herdr-worktree usage:
/herdr-worktree start [branch]          distill a dispatch plan, then create a linked worktree and start Pi
/herdr-worktree cleanup                 remove this linked worktree and delete the local branch
/herdr-worktree cleanup --keep-branch   remove this linked worktree and keep the local branch`;

export function parseHerdrWorktreeCommand(input: string): HerdrWorktreeRoute {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 1 && tokens[0] === "cleanup") return { kind: "cleanup", keepBranch: false };
	if (tokens.length === 2 && tokens[0] === "cleanup" && tokens[1] === "--keep-branch") {
		return { kind: "cleanup", keepBranch: true };
	}
	if (tokens.length === 1 && tokens[0] === "start") return { kind: "start" };
	if (tokens.length === 2 && tokens[0] === "start" && tokens[1] && !tokens[1].startsWith("-")) {
		return { kind: "start", branch: tokens[1] };
	}
	return { kind: "usage" };
}
