import type { ExecResult, ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import extension from "../src/extension.ts";

const ENV_KEYS = [
	"HERDR_ENV",
	"HERDR_PANE_ID",
	"HERDR_TAB_ID",
	"HERDR_WORKSPACE_ID",
	"HERDR_SOCKET_PATH",
	"PI_HERDR_COMPANION_BTW_PAYLOAD",
] as const;
const original = Object.fromEntries(ENV_KEYS.map((key) => [key, process.env[key]]));

afterEach(() => {
	for (const key of ENV_KEYS) {
		const value = original[key];
		if (value === undefined) delete process.env[key];
		else process.env[key] = value;
	}
});

function fakePi() {
	const tools: string[] = [];
	const commands: string[] = [];
	const handlers = new Map<string, Array<(event: unknown, ctx: unknown) => unknown>>();
	const eventHandlers = new Map<string, Array<(data: unknown) => void>>();
	const pi = {
		on(name: string, handler: (event: unknown, ctx: unknown) => unknown) {
			const values = handlers.get(name) ?? [];
			values.push(handler);
			handlers.set(name, values);
		},
		registerTool(tool: { name: string }) { tools.push(tool.name); },
		registerCommand(name: string) { commands.push(name); },
		events: {
			on(name: string, handler: (data: unknown) => void) {
				const values = eventHandlers.get(name) ?? [];
				values.push(handler);
				eventHandlers.set(name, values);
			},
			emit(name: string, data: unknown) {
				for (const handler of eventHandlers.get(name) ?? []) handler(data);
			},
		},
		exec: async (): Promise<ExecResult> => ({ stdout: "", stderr: "", code: 0, killed: false }),
		getActiveTools: () => [],
		getThinkingLevel: () => "off",
		sendMessage() {},
		sendUserMessage() {},
		appendEntry() {},
	} as unknown as ExtensionAPI;
	return { pi, tools, commands, handlers };
}

describe.sequential("extension registration gates", () => {
	it("outside Herdr registers /btw recovery/help but no process or hidden tools", async () => {
		for (const key of ENV_KEYS) delete process.env[key];
		const h = fakePi();
		await extension(h.pi);
		expect(h.tools).toEqual([]);
		expect(h.commands).toContain("btw");
		const before = h.handlers.get("before_agent_start") ?? [];
		const result = await before[0]?.({ systemPrompt: "base" }, {});
		expect(result).toMatchObject({ systemPrompt: expect.stringContaining("inside: false") });
	});

	it("inside a complete Herdr caller registers exactly herdr_process and no /btw tool schema", async () => {
		Object.assign(process.env, {
			HERDR_ENV: "1",
			HERDR_PANE_ID: "w1:p1",
			HERDR_TAB_ID: "w1:t1",
			HERDR_WORKSPACE_ID: "w1",
			HERDR_SOCKET_PATH: "/tmp/herdr.sock",
		});
		delete process.env.PI_HERDR_COMPANION_BTW_PAYLOAD;
		const h = fakePi();
		await extension(h.pi);
		expect(h.tools).toEqual(["herdr_process"]);
		expect(h.commands).toContain("btw");
		expect(h.tools).not.toContain("btw");
		expect(h.tools).not.toContain("herdr_blocked");
	});
});
