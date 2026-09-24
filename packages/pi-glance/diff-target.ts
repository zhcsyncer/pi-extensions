import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { AutocompleteItem } from "@earendil-works/pi-tui";

export type DiffCommand =
	| { mode: "menu" }
	| { mode: "worktree" }
	| { mode: "branch"; base?: string }
	| { mode: "compare"; from?: string; to?: string };

const DIFF_COMMANDS: AutocompleteItem[] = [
	{ value: "worktree", label: "worktree", description: "Review uncommitted changes, including untracked files" },
	{ value: "branch", label: "branch [base]", description: "Review branch changes since the merge base (default: main)" },
	{ value: "compare", label: "compare [from] [to]", description: "Compare two revisions; search for missing endpoints" },
];

export function diffArgumentCompletions(prefix: string): AutocompleteItem[] | null {
	const word = prefix.trimStart();
	if (/\s/.test(word)) return null;
	const items = DIFF_COMMANDS.filter((item) => item.value.startsWith(word));
	return items.length ? items : null;
}

export function parseDiffCommand(args: string): DiffCommand {
	const [mode, ...refs] = args.trim().split(/\s+/);
	if (!mode) return { mode: "menu" };
	if (mode === "worktree" && refs.length === 0) return { mode };
	if (mode === "branch" && refs.length <= 1) return { mode, base: refs[0] };
	if (mode === "compare" && refs.length <= 2) return { mode, from: refs[0], to: refs[1] };
	throw new Error("Use /diff worktree, /diff branch [base], or /diff compare [from] [to]. Unknown command or extra arguments.");
}

export interface DiffRevision {
	readonly sha: string;
	readonly label: string;
}

export interface DiffRevisionCandidate {
	readonly ref: string;
	readonly name: string;
	readonly sha: string;
	readonly subject: string;
	readonly kind: "branch" | "remote" | "tag" | "commit";
}

export interface DiffTarget {
	readonly revisions: readonly string[];
	readonly includeUntracked: boolean;
	readonly description: string;
	readonly unborn?: boolean;
}

const execute = promisify(execFile);
class GitFailure extends Error {
	constructor(message: string, readonly exitCode?: number) { super(message); }
}

// Git names and commit subjects can contain terminal controls. Never render them verbatim.
export function diffDisplayText(text: string): string {
	return text.replace(/[\x00-\x1f\x7f-\x9f]/g, " ");
}

async function git(cwd: string, args: string[]): Promise<string> {
	try {
		const { stdout } = await execute("git", ["--no-pager", ...args], {
			cwd, encoding: "utf8", timeout: 10_000, maxBuffer: 4 * 1024 * 1024,
			env: { ...process.env, GIT_OPTIONAL_LOCKS: "0", GIT_TERMINAL_PROMPT: "0" },
		});
		return stdout.trimEnd();
	} catch (error) {
		const failure = error as { code?: number | string; killed?: boolean; message?: string; stderr?: string };
		if (failure.killed) throw new GitFailure("Git timed out while preparing the review. Try again when the repository is responsive.");
		if (failure.code === "ENOENT") throw new GitFailure("Git or the review directory was not found.");
		throw new GitFailure(`Git: ${diffDisplayText(failure.stderr?.trim() || failure.message || String(error))}`, typeof failure.code === "number" ? failure.code : undefined);
	}
}

export async function assertDiffWorktree(cwd: string): Promise<void> {
	let inside: string;
	try {
		inside = await git(cwd, ["rev-parse", "--is-inside-work-tree"]);
	} catch (error) {
		if (error instanceof GitFailure && error.exitCode === 128) throw new Error("/diff requires a Git working tree.");
		throw error;
	}
	if (inside !== "true") throw new Error("/diff requires a Git working tree (not a bare repository).");
}

async function tryResolveCommit(cwd: string, ref: string): Promise<string | undefined> {
	try {
		const sha = await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`]);
		if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("Git returned an invalid commit ID.");
		return sha;
	} catch (error) {
		if (error instanceof GitFailure && error.exitCode === 128) return undefined;
		throw error;
	}
}

export async function resolveDiffRevision(cwd: string, ref: string, label = ref): Promise<DiffRevision> {
	if (!ref || /\s|\0/.test(ref)) throw new Error("Enter one ref or commit SHA without whitespace.");
	const sha = await tryResolveCommit(cwd, ref);
	if (!sha) throw new Error(ref === "HEAD" ? "HEAD has no valid commit yet; use /diff worktree for uncommitted changes." : `Not a commit or valid ref: ${diffDisplayText(ref)}`);
	return { sha, label: diffDisplayText(label) };
}

export async function listDiffRevisions(cwd: string): Promise<DiffRevisionCandidate[]> {
	try {
		const refs = await git(cwd, ["for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)%00%(subject)", "refs/heads", "refs/remotes", "refs/tags"]);
		const candidates: DiffRevisionCandidate[] = refs ? refs.split("\n").map((line) => {
			const [ref = "", sha = "", subject = ""] = line.split("\0");
			const kind = ref.startsWith("refs/heads/") ? "branch" : ref.startsWith("refs/remotes/") ? "remote" : "tag";
			return { ref, sha, kind, name: ref.replace(/^refs\/(heads|remotes|tags)\//, ""), subject: diffDisplayText(subject) };
		}) : [];
		// No HEAD is normal in an unborn worktree; refs/tags may still be available.
		const head = await tryResolveCommit(cwd, "HEAD");
		if (head) {
			const commits = await git(cwd, ["log", "-50", "--format=%H%x00%s", head, "--"]);
			for (const line of commits.split("\n")) {
				const [sha = "", subject = ""] = line.split("\0");
				candidates.push({ ref: sha, sha, name: sha.slice(0, 12), subject: diffDisplayText(subject), kind: "commit" });
			}
		}
		return candidates;
	} catch (error) {
		throw new Error(`Could not load Git revisions: ${error instanceof Error ? error.message : String(error)}`);
	}
}

function revisionLabel(revision: DiffRevision): string {
	return `${revision.label} (${revision.sha.slice(0, 12)})`;
}

export async function workingTreeDiffTarget(cwd: string): Promise<DiffTarget> {
	return {
		revisions: [], includeUntracked: true,
		description: "Working tree: staged + unstaged + untracked changes",
		unborn: !(await tryResolveCommit(cwd, "HEAD")),
	};
}

export interface BranchDiffBase {
	readonly base: DiffRevision;
	readonly head: DiffRevision;
	readonly mergeBase: string;
}

export async function prepareBranchDiff(cwd: string, ref?: string): Promise<BranchDiffBase> {
	let base: DiffRevision;
	if (ref !== undefined) base = await resolveDiffRevision(cwd, ref);
	else {
		const origin = await tryResolveCommit(cwd, "refs/remotes/origin/main");
		const local = origin ? undefined : await tryResolveCommit(cwd, "refs/heads/main");
		if (!origin && !local) throw new Error("No origin/main or local main commit found. Supply a base with /diff branch <base>; no fetch is performed.");
		base = { sha: (origin ?? local)!, label: origin ? "origin/main" : "main" };
	}
	const head = await resolveDiffRevision(cwd, "HEAD");
	let mergeBase: string;
	try {
		mergeBase = await git(cwd, ["merge-base", base.sha, head.sha]);
	} catch (error) {
		if (error instanceof GitFailure && error.exitCode === 1) throw new Error(`No common ancestor between ${base.label} and HEAD. Use /diff compare for endpoint comparison.`);
		throw error;
	}
	return { base, head, mergeBase };
}

export function branchDiffTarget(branch: BranchDiffBase, includeWorkingTree: boolean): DiffTarget {
	const from = `merge base with ${revisionLabel(branch.base)}: ${branch.mergeBase.slice(0, 12)}`;
	return {
		revisions: includeWorkingTree ? [branch.mergeBase] : [branch.mergeBase, branch.head.sha],
		includeUntracked: includeWorkingTree,
		description: includeWorkingTree
			? `${from} → current working tree (includes staged, unstaged and untracked)`
			: `${from} → ${revisionLabel(branch.head)} (committed only)`,
	};
}

export function compareDiffTarget(from: DiffRevision, to: DiffRevision): DiffTarget {
	return {
		revisions: [from.sha, to.sha], includeUntracked: false,
		description: `${revisionLabel(from)} → ${revisionLabel(to)} (committed endpoints; no working tree)`,
	};
}
