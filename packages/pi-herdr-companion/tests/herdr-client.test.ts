import type { ExecOptions, ExecResult } from "@earendil-works/pi-coding-agent";
import { describe, expect, it } from "vitest";
import {
	HerdrClient,
	HerdrCommandError,
	HerdrProtocolError,
	isMissingPaneError,
	type HerdrExecutor,
} from "../src/herdr-client.ts";

type Call = { command: string; args: string[]; options: ExecOptions };

function ok(stdout = '{"id":"test","result":{"type":"ok"}}'): ExecResult {
	return { stdout, stderr: "", code: 0, killed: false };
}

function pane(id = "w1:p2") {
	return {
		pane_id: id,
		terminal_id: "term-managed",
		tab_id: "w1:t1",
		workspace_id: "w1",
		cwd: "/work",
		label: "dev",
		focused: false,
		agent: "pi",
		agent_status: "idle",
		agent_session: { agent: "pi", kind: "id", source: "herdr:pi", value: "session-1" },
	};
}

function capture(respond: (args: string[]) => ExecResult | Promise<ExecResult>) {
	const calls: Call[] = [];
	const executor: HerdrExecutor = async (command, args, options) => {
		calls.push({ command, args: [...args], options: { ...options } });
		return respond(args);
	};
	return { client: new HerdrClient(executor), calls };
}

describe("HerdrClient argv and response contracts", () => {
	it("uses argv, --current, no-focus, ratio, cwd, and private env without shell interpolation", async () => {
		const { client, calls } = capture(() => ok(JSON.stringify({ result: { pane: pane() } })));
		const result = await client.splitPane({
			target: "current",
			direction: "down",
			ratio: 0.35,
			cwd: "/work/a b",
			focus: false,
			environment: { PI_HERDR_COMPANION_BTW_PAYLOAD: "/private/a b/payload.json" },
		});
		expect(result).toMatchObject({
			paneId: "w1:p2",
			terminalId: "term-managed",
			workspaceId: "w1",
			tabId: "w1:t1",
			agent: "pi",
			agentStatus: "idle",
			agentSession: { agent: "pi", kind: "id", value: "session-1" },
		});
		expect(calls).toEqual([{
			command: "herdr",
			args: [
				"pane", "split", "--current", "--direction", "down", "--ratio", "0.35",
				"--cwd", "/work/a b", "--env", "PI_HERDR_COMPANION_BTW_PAYLOAD=/private/a b/payload.json", "--no-focus",
			],
			options: { timeout: 10_000 },
		}]);
	});

	it("parses list/get/process-info/agent-get/wait JSON while preserving plain read/run", async () => {
		const { client, calls } = capture((args) => {
			const joined = args.slice(0, 2).join(" ");
			if (joined === "pane list") return ok(JSON.stringify({ result: { panes: [pane()] } }));
			if (joined === "pane get") return ok(JSON.stringify({ result: { pane: pane(args[2]) } }));
			if (joined === "pane process-info") return ok(JSON.stringify({ result: { process_info: {
				pane_id: args[3],
				shell_pid: 100,
				foreground_process_group_id: 200,
				foreground_processes: [{ pid: 200, name: "node", argv: ["node", "server.js"], cmdline: "node server.js", cwd: "/work" }],
			} } }));
			if (joined === "agent get") return ok(JSON.stringify({ result: { agent: { pane_id: "w2:p9", name: "btw-one", agent: "pi", agent_status: "working" } } }));
			if (joined === "pane wait-output") return ok(JSON.stringify({ result: { matched_line: "ready" } }));
			if (joined === "pane read") return ok("line one\nline two\n");
			if (joined === "pane run") return ok("");
			return ok();
		});
		expect(await client.listPanes()).toHaveLength(1);
		expect((await client.getPane("w1:p2")).paneId).toBe("w1:p2");
		expect(await client.getPaneProcessInfo("w1:p2")).toEqual({
			paneId: "w1:p2",
			shellPid: 100,
			foregroundProcessGroupId: 200,
			foregroundProcesses: [{ pid: 200, name: "node", argv: ["node", "server.js"], cmdline: "node server.js", cwd: "/work" }],
		});
		expect(await client.getAgent("btw-one")).toMatchObject({ paneId: "w2:p9", name: "btw-one" });
		expect(await client.waitOutput("w1:p2", { match: "ready", timeoutMs: 1234 })).toBe("ready");
		expect(await client.readPane("w1:p2", 80)).toBe("line one\nline two\n");
		await expect(client.runPane("w1:p2", "pnpm dev")).resolves.toBeUndefined();
		const wait = calls.find((call) => call.args[1] === "wait-output");
		expect(wait?.args).toContain("1234");
		expect(wait?.options.timeout).toBe(3234);
		expect(calls.every((call) => typeof call.options.timeout === "number" && call.options.timeout! > 0)).toBe(true);
	});

	it("merges an empty recent scrollback with a visible viewport marker using bounded reads", async () => {
		const { client, calls } = capture((args) => {
			const source = args[args.indexOf("--source") + 1];
			return ok(source === "recent-unwrapped" ? "" : "$ pnpm dev\nREADY\n");
		});
		await expect(client.readPane("w1:p2", 50_000)).resolves.toBe("$ pnpm dev\nREADY\n");
		const reads = calls.filter((call) => call.args[1] === "read");
		expect(reads.map((call) => call.args[call.args.indexOf("--source") + 1]))
			.toEqual(["recent-unwrapped", "visible"]);
		expect(reads.map((call) => call.args[call.args.indexOf("--lines") + 1]))
			.toEqual(["2000", "2000"]);
		expect(reads.map((call) => call.options.timeout)).toEqual([5_000, 5_000]);
	});

	it("removes the largest exact line overlap between scrollback and viewport", async () => {
		const { client } = capture((args) => {
			const source = args[args.indexOf("--source") + 1];
			return ok(source === "recent-unwrapped"
				? "older\nshared one\nshared two\n"
				: "shared one\nshared two\nnewest\n");
		});
		await expect(client.readPane("w1:p2", 80)).resolves.toBe(
			"older\nshared one\nshared two\nnewest\n",
		);
	});

	it.each(["recent-unwrapped", "visible"] as const)(
		"falls back to the successful source when %s fails non-fatally",
		async (failedSource) => {
			const { client } = capture((args) => {
				const source = args[args.indexOf("--source") + 1];
				return source === failedSource
					? { stdout: "", stderr: "source temporarily unavailable", code: 1, killed: false }
					: ok("available output\n");
			});
			await expect(client.readPane("w1:p2", 80)).resolves.toBe("available output\n");
		},
	);

	it("throws when both pane read sources fail", async () => {
		const { client, calls } = capture(() => ({
			stdout: "",
			stderr: "source unavailable",
			code: 1,
			killed: false,
		}));
		await expect(client.readPane("w1:p2", 80)).rejects.toBeInstanceOf(HerdrCommandError);
		expect(calls).toHaveLength(2);
	});

	it("never masks a missing pane with output from the other source", async () => {
		const { client, calls } = capture((args) => {
			const source = args[args.indexOf("--source") + 1];
			return source === "recent-unwrapped"
				? ok("older output\n")
				: {
					stdout: "",
					stderr: JSON.stringify({ error: { code: "pane_not_found", message: "closed" } }),
					code: 1,
					killed: false,
				};
		});
		await expect(client.readPane("w1:p2", 80)).rejects.toMatchObject({ missingPane: true });
		expect(calls).toHaveLength(2);
	});

	it("builds agent-start argv with an explicit startup timeout and post-separator Pi args", async () => {
		const { client, calls } = capture(() => ok());
		await client.startAgent({
			name: "btw-parent-123",
			kind: "pi",
			paneId: "w1:p2",
			args: ["--no-session", "--model", "openai/gpt"],
			timeoutMs: 40_000,
		});
		expect(calls[0]?.args).toEqual([
			"agent", "start", "btw-parent-123", "--kind", "pi", "--pane", "w1:p2",
			"--timeout", "40000", "--", "--no-session", "--model", "openai/gpt",
		]);
		expect(calls[0]?.options.timeout).toBe(45_000);
	});

	it("builds typed agent rename and non-waiting prompt argv without exposing prompt text in errors", async () => {
		const { client, calls } = capture((args) => ok(JSON.stringify({ result: { agent: {
			pane_id: "w1:p1",
			name: args[1] === "rename" ? args[3] : "worker-one",
			agent: "pi",
			agent_status: "working",
		} } })));
		await expect(client.renameAgent("w1:p1", "parent-one")).resolves.toMatchObject({
			paneId: "w1:p1",
			name: "parent-one",
		});
		await expect(client.promptAgent("worker-one", "[secret task prompt]")).resolves.toMatchObject({
			paneId: "w1:p1",
			name: "worker-one",
		});
		expect(calls).toEqual([
			{ command: "herdr", args: ["agent", "rename", "w1:p1", "parent-one"], options: { timeout: 5_000 } },
			{ command: "herdr", args: ["agent", "prompt", "worker-one", "[secret task prompt]"], options: { timeout: 5_000 } },
		]);
		expect(calls[1]?.args).not.toContain("--wait");
	});

	it("propagates AbortSignal and gives every mutating primitive a finite timeout", async () => {
		const controller = new AbortController();
		const { client, calls } = capture((args) =>
			args[1] === "rename"
				? ok(JSON.stringify({ result: { pane: pane() } }))
				: ok());
		await client.renamePane("w1:p2", "dev", controller.signal);
		await client.closePane("w1:p2", controller.signal);
		await client.focusAgent("w1:p1", controller.signal);
		expect(calls.every((call) => call.options.signal === controller.signal)).toBe(true);
		expect(calls.map((call) => call.options.timeout)).toEqual([5000, 5000, 5000]);
	});

	it("does not invoke the executor when the signal was already aborted", async () => {
		const controller = new AbortController();
		controller.abort(new Error("cancelled before split"));
		const { client, calls } = capture(() => ok(JSON.stringify({ result: { pane: pane() } })));
		await expect(client.splitPane({
			target: "current",
			direction: "down",
			cwd: "/work",
			focus: false,
		}, controller.signal)).rejects.toThrow(/cancelled before split/);
		expect(calls).toEqual([]);
	});

	it("rejects malformed success JSON instead of trusting guessed pane IDs", async () => {
		for (const stdout of [
			"not-json",
			'{"result":{"pane":{"pane_id":7}}}',
			'{"result":{"pane":{"pane_id":"w1:p2","terminal_id":7}}}',
			'{"result":{"pane":{"pane_id":"w1:p2","agent_session":"wrong"}}}',
			'{"result":{"panes":"wrong"}}',
		]) {
			const { client } = capture(() => ok(stdout));
			if (stdout.includes("panes")) await expect(client.listPanes()).rejects.toBeInstanceOf(HerdrProtocolError);
			else await expect(client.getPane("w1:p2")).rejects.toBeInstanceOf(HerdrProtocolError);
		}
	});

	it("normalizes JSON CLI errors and recognizes only explicit missing-pane failures", async () => {
		const result: ExecResult = {
			stdout: "",
			stderr: JSON.stringify({ error: { code: "pane_not_found", message: "pane w1:p9 not found" } }),
			code: 1,
			killed: false,
		};
		const { client } = capture(() => result);
		const error = await client.getPane("w1:p9").catch((caught) => caught as unknown);
		expect(error).toBeInstanceOf(HerdrCommandError);
		expect((error as HerdrCommandError).herdrCode).toBe("pane_not_found");
		expect(isMissingPaneError(error)).toBe(true);
		expect(isMissingPaneError(new Error("socket unavailable"))).toBe(false);
	});

	it("redacts pane commands, wait patterns, child args, and 64KiB diagnostics from errors", () => {
		const secret = "SECRET-token-never-log";
		const huge = `${secret}${"x".repeat(64 * 1024)}`;
		for (const args of [
			["pane", "run", "w1:p2", `echo ${secret}`],
			["pane", "wait-output", "w1:p2", "--regex", secret],
			["agent", "start", "btw", "--", "--system-prompt", secret],
			["agent", "prompt", "worker", secret],
		]) {
			const error = new HerdrCommandError(args, { stdout: "", stderr: huge, code: 1, killed: false });
			expect(String(error)).not.toContain(secret);
			expect(String(error)).not.toContain("--system-prompt");
			const serialized = JSON.stringify({ ...error, message: error.message, stack: error.stack });
			expect(serialized).not.toContain(secret);
			expect(Buffer.byteLength(serialized, "utf8")).toBeLessThan(50 * 1024);
		}
	});

	it("treats a killed command as failure even if its exit code is zero", async () => {
		const { client } = capture(() => ({ stdout: "", stderr: "timed out", code: 0, killed: true }));
		await expect(client.runPane("w1:p2", "watch")).rejects.toMatchObject({ killed: true });
	});
});
