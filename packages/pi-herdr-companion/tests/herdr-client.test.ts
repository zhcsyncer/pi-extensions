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
		tab_id: "w1:t1",
		workspace_id: "w1",
		cwd: "/work",
		label: "dev",
		focused: false,
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
		expect(result.paneId).toBe("w1:p2");
		expect(calls).toEqual([{
			command: "herdr",
			args: [
				"pane", "split", "--current", "--direction", "down", "--ratio", "0.35",
				"--cwd", "/work/a b", "--env", "PI_HERDR_COMPANION_BTW_PAYLOAD=/private/a b/payload.json", "--no-focus",
			],
			options: { timeout: 10_000 },
		}]);
	});

	it("parses list/get/wait JSON defensively while preserving plain read/run contracts", async () => {
		const { client, calls } = capture((args) => {
			const joined = args.slice(0, 2).join(" ");
			if (joined === "pane list") return ok(JSON.stringify({ result: { panes: [pane()] } }));
			if (joined === "pane get") return ok(JSON.stringify({ result: { pane: pane(args[2]) } }));
			if (joined === "pane wait-output") return ok(JSON.stringify({ result: { matched_line: "ready" } }));
			if (joined === "pane read") return ok("line one\nline two\n");
			if (joined === "pane run") return ok("");
			return ok();
		});
		expect(await client.listPanes()).toHaveLength(1);
		expect((await client.getPane("w1:p2")).paneId).toBe("w1:p2");
		expect(await client.waitOutput("w1:p2", { match: "ready", timeoutMs: 1234 })).toBe("ready");
		expect(await client.readPane("w1:p2", 80)).toBe("line one\nline two\n");
		await expect(client.runPane("w1:p2", "pnpm dev")).resolves.toBeUndefined();
		const wait = calls.find((call) => call.args[1] === "wait-output");
		expect(wait?.args).toContain("1234");
		expect(wait?.options.timeout).toBe(3234);
		expect(calls.every((call) => typeof call.options.timeout === "number" && call.options.timeout! > 0)).toBe(true);
	});

	it("builds agent-start argv with an explicit startup timeout and post-separator Pi args", async () => {
		const { client, calls } = capture(() => ok());
		await client.startAgent({
			name: "btw-parent-123",
			kind: "pi",
			paneId: "w1:p2",
			args: ["--no-session", "--model", "openai/gpt", "/btw --launch-draft"],
			timeoutMs: 40_000,
		});
		expect(calls[0]?.args).toEqual([
			"agent", "start", "btw-parent-123", "--kind", "pi", "--pane", "w1:p2",
			"--timeout", "40000", "--", "--no-session", "--model", "openai/gpt", "/btw --launch-draft",
		]);
		expect(calls[0]?.options.timeout).toBe(45_000);
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

	it("rejects malformed success JSON instead of trusting guessed pane IDs", async () => {
		for (const stdout of ["not-json", '{"result":{"pane":{"pane_id":7}}}', '{"result":{"panes":"wrong"}}']) {
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

	it("treats a killed command as failure even if its exit code is zero", async () => {
		const { client } = capture(() => ({ stdout: "", stderr: "timed out", code: 0, killed: true }));
		await expect(client.runPane("w1:p2", "watch")).rejects.toMatchObject({ killed: true });
	});
});
