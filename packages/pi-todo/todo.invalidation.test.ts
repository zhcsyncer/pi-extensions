import { createMockPi } from "./test-fixtures.js";
import { describe, expect, it } from "vitest";
import registerTodo from "./index.js";

// The exact phrase pi-core's ExtensionRunner throws from an invalidated proxy.
const STALE_CTX_MESSAGE =
	"This extension ctx is stale after session replacement or reload. " +
	"Do not use a captured pi or command ctx after ctx.newSession().";

// A ctx whose sessionManager getter throws — replayFromBranch reads
// ctx.sessionManager.getBranch() first, so this is where the stale proxy bites.
function throwingCtx(message: string) {
	return {
		hasUI: false,
		get sessionManager(): never {
			throw new Error(message);
		},
	};
}

function setup() {
	const { pi, captured } = createMockPi();
	registerTodo(pi);
	const tool = captured.tools.get("todo");
	if (!tool) throw new Error("todo tool not registered");
	return { captured, tool };
}

async function call(tool: ReturnType<typeof setup>["tool"], params: Record<string, unknown>) {
	return tool.execute?.("tc", params as never, undefined as never, undefined as never, {} as never);
}

describe.each(["session_compact", "session_tree"] as const)("%s — stale ctx handling", (event) => {
	it("keeps the runtime-local state on a stale ctx", async () => {
		const { captured, tool } = setup();
		await call(tool, { action: "create", subject: "keep me" });
		const handler = captured.events.get(event)?.[0];
		await expect(handler?.({} as never, throwingCtx(STALE_CTX_MESSAGE) as never)).resolves.toBeUndefined();
		const listed = await call(tool, { action: "list" });
		expect(listed?.content[0]).toMatchObject({ text: expect.stringContaining("keep me") });
	});

	it("propagates a non-stale replay error", async () => {
		const { captured } = setup();
		const handler = captured.events.get(event)?.[0];
		await expect(handler?.({} as never, throwingCtx("boom: real replay bug") as never)).rejects.toThrow("boom");
	});
});

describe("extension runtime isolation", () => {
	it("keeps Todo state separate across two extension instances in one process", async () => {
		const first = setup();
		const second = setup();
		await call(first.tool, { action: "create", subject: "first runtime" });

		const firstList = await call(first.tool, { action: "list" });
		const secondList = await call(second.tool, { action: "list" });
		expect(firstList?.content[0]).toMatchObject({ text: expect.stringContaining("first runtime") });
		expect(secondList?.content[0]).toMatchObject({ text: "No tasks" });
	});
});
