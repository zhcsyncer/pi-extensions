export type HerdrWorktreeRoute =
	| { kind: "cleanup"; keepBranch: boolean }
	| { kind: "usage" };

export const HERDR_WORKTREE_USAGE = `/herdr-worktree usage:
/herdr-worktree cleanup                 remove this linked worktree and delete the local branch
/herdr-worktree cleanup --keep-branch   remove this linked worktree and keep the local branch`;

export function parseHerdrWorktreeCommand(input: string): HerdrWorktreeRoute {
	const tokens = input.trim().split(/\s+/).filter(Boolean);
	if (tokens.length === 1 && tokens[0] === "cleanup") return { kind: "cleanup", keepBranch: false };
	if (tokens.length === 2 && tokens[0] === "cleanup" && tokens[1] === "--keep-branch") {
		return { kind: "cleanup", keepBranch: true };
	}
	return { kind: "usage" };
}
