import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

const execute = promisify(execFile);

export async function createDiffFixture(): Promise<{
	cwd: string;
	git: (...args: string[]) => Promise<string>;
	commit: (subject: string, file?: string) => Promise<string>;
	cleanup: () => Promise<void>;
}> {
	const cwd = await mkdtemp(join(tmpdir(), "glance-diff-test-"));
	const git = async (...args: string[]) => {
		const { stdout } = await execute("git", ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args], {
			cwd, encoding: "utf8", timeout: 10_000,
			env: { ...process.env, GIT_AUTHOR_NAME: "Diff Test", GIT_AUTHOR_EMAIL: "diff@example.invalid", GIT_COMMITTER_NAME: "Diff Test", GIT_COMMITTER_EMAIL: "diff@example.invalid" },
		});
		return stdout.trim();
	};
	await git("init", "-b", "main");
	return {
		cwd, git,
		commit: async (subject, file = "tracked.txt") => {
			await writeFile(join(cwd, file), `${subject}\n`);
			await git("add", "--", file);
			await git("commit", "-m", subject);
			return git("rev-parse", "HEAD");
		},
		cleanup: () => rm(cwd, { recursive: true, force: true }),
	};
}
