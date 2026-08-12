import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import {
	access,
	mkdir,
	mkdtemp,
	readFile,
	readdir,
	rm,
	stat,
	utimes,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
	ProcessCommandTransport,
	quotePaneShellWord,
} from "../src/process/transport.ts";

const roots: string[] = [];
afterEach(async () => {
	await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function findExecutable(name: string): string | undefined {
	for (const directory of (process.env.PATH ?? "").split(delimiter)) {
		if (!directory) continue;
		const candidate = join(directory, name);
		if (existsSync(candidate)) return candidate;
	}
	return undefined;
}

async function run(program: string, args: string[], cwd: string): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(program, args, { cwd, stdio: ["ignore", "pipe", "pipe"] });
		let stdout = "";
		let stderr = "";
		child.stdout.setEncoding("utf8");
		child.stderr.setEncoding("utf8");
		child.stdout.on("data", (chunk: string) => { stdout += chunk; });
		child.stderr.on("data", (chunk: string) => { stderr += chunk; });
		child.once("error", reject);
		child.once("close", (code) => {
			if (code === 0) resolve({ stdout, stderr });
			else reject(new Error(`${program} exited ${code}: ${stderr}`));
		});
	});
}

async function fixture() {
	const root = await mkdtemp(join(tmpdir(), "companion-process-transport-"));
	roots.push(root);
	const scriptDirectory = join(root, "scripts with ' quote");
	const transport = new ProcessCommandTransport({
		scriptDirectory,
		bashExecutable: "/bin/bash",
	});
	return { root, scriptDirectory, transport };
}

const COMPLEX_BASH = [
	"value='single quote survives'",
	"printf '%s\\n' \"$value\" > result.txt",
	"cat <<'EOF' >> result.txt",
	"heredoc ' \"$HOME\"",
	"EOF",
].join("\n");

const EXPECTED_OUTPUT = "single quote survives\nheredoc ' \"$HOME\"\n";

describe.skipIf(process.platform === "win32")("process command transport", () => {
	it("quotes generated paths for common Unix pane shells", () => {
		expect(quotePaneShellWord("plain path")).toBe("'plain path'");
		expect(quotePaneShellWord("a'b")).toBe("'a'\"'\"'b'");
		expect(() => quotePaneShellWord("bad\0path")).toThrow(/NUL/);
	});

	it("keeps arbitrary Bash out of pane input, runs it non-interactively, and self-deletes", async () => {
		const { root, scriptDirectory, transport } = await fixture();
		const prepared = await transport.prepare(COMPLEX_BASH, "bash");
		expect(prepared.paneCommand).not.toContain("single quote survives");
		expect(prepared.paneCommand).not.toContain("heredoc");

		const files = await readdir(scriptDirectory);
		expect(files).toHaveLength(1);
		const scriptPath = join(scriptDirectory, files[0] as string);
		expect(await readFile(scriptPath, "utf8")).toContain(COMPLEX_BASH);
		if (process.platform !== "win32") {
			expect((await stat(scriptDirectory)).mode & 0o777).toBe(0o700);
			expect((await stat(scriptPath)).mode & 0o777).toBe(0o600);
		}

		await run("/bin/bash", ["-c", prepared.paneCommand], root);
		expect(await readFile(join(root, "result.txt"), "utf8")).toBe(EXPECTED_OUTPUT);
		await expect(access(scriptPath)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("uses the same fixed invocation successfully from Fish when Fish is available", async () => {
		const fish = findExecutable("fish");
		if (!fish) return;
		const { root, transport } = await fixture();
		const prepared = await transport.prepare(COMPLEX_BASH, "bash");
		await run(fish, ["-c", prepared.paneCommand], root);
		expect(await readFile(join(root, "result.txt"), "utf8")).toBe(EXPECTED_OUTPUT);
	});

	it("leaves intentional pane-shell commands untouched and creates no artifact", async () => {
		const { scriptDirectory, transport } = await fixture();
		const prepared = await transport.prepare("set -gx MODE fish", "pane");
		expect(prepared.paneCommand).toBe("set -gx MODE fish");
		await prepared.cleanup();
		await expect(access(scriptDirectory)).rejects.toMatchObject({ code: "ENOENT" });
	});

	it("can clean a script that never reached Bash", async () => {
		const { scriptDirectory, transport } = await fixture();
		const prepared = await transport.prepare("printf ready", "bash");
		const [name] = await readdir(scriptDirectory);
		await prepared.cleanup();
		await expect(access(join(scriptDirectory, name as string))).rejects.toMatchObject({ code: "ENOENT" });
		await expect(prepared.cleanup()).resolves.toBeUndefined();
	});

	it("removes only age-expired generated scripts before preparing another", async () => {
		const root = await mkdtemp(join(tmpdir(), "companion-process-transport-"));
		roots.push(root);
		const scriptDirectory = join(root, "scripts");
		await mkdir(scriptDirectory, { mode: 0o700 });
		const stale = join(scriptDirectory, "process-00000000-0000-4000-8000-000000000000.sh");
		const unrelated = join(scriptDirectory, "keep.sh");
		await writeFile(stale, "stale");
		await writeFile(unrelated, "keep");
		await utimes(stale, new Date(0), new Date(0));

		const transport = new ProcessCommandTransport({
			scriptDirectory,
			bashExecutable: "/bin/bash",
			staleScriptMs: 1_000,
			now: () => 2_000,
		});
		const prepared = await transport.prepare("printf ready", "bash");
		await expect(access(stale)).rejects.toMatchObject({ code: "ENOENT" });
		await expect(access(unrelated)).resolves.toBeUndefined();
		await prepared.cleanup();
	});
});

describe("process command transport platform guard", () => {
	it.skipIf(process.platform !== "win32")("rejects Bash mode before creating an artifact on Windows", async () => {
		const root = await mkdtemp(join(tmpdir(), "companion-process-transport-"));
		roots.push(root);
		const scriptDirectory = join(root, "scripts");
		const transport = new ProcessCommandTransport({ scriptDirectory, bashExecutable: "bash" });
		await expect(transport.prepare("echo ready", "bash")).rejects.toThrow(/not supported on Windows/);
		await expect(access(scriptDirectory)).rejects.toMatchObject({ code: "ENOENT" });
	});
});
