import { vi } from "vitest";

export interface GitExecSpec {
	branch?: string;
	commit?: string;
	user?: string;
	userError?: Error;
}

/** Matches the real ExecResult shape from @earendil-works/pi-coding-agent
 *  (dist/core/exec.d.ts:18-23) so tests reading the real .code / .killed
 *  fields work against this stub. */
export interface ExecResult {
	stdout: string;
	stderr: string;
	code: number;
	killed: boolean;
}

export function stubGitExec(spec: GitExecSpec = {}) {
	return vi.fn(async (cmd: string, args: string[], _opts?: unknown): Promise<ExecResult> => {
		if (cmd !== "git") return { stdout: "", stderr: "", code: 0, killed: false };
		const joined = args.join(" ");
		if (joined === "rev-parse --abbrev-ref HEAD") {
			return { stdout: `${spec.branch ?? ""}\n`, stderr: "", code: 0, killed: false };
		}
		if (joined === "rev-parse --short HEAD") {
			return { stdout: `${spec.commit ?? ""}\n`, stderr: "", code: 0, killed: false };
		}
		if (joined === "config user.name") {
			if (spec.userError) throw spec.userError;
			return { stdout: `${spec.user ?? ""}\n`, stderr: "", code: 0, killed: false };
		}
		return { stdout: "", stderr: "", code: 0, killed: false };
	});
}
