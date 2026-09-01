import { describe, expect, it } from "vitest";
import { __resetInventoryCache, getInventoryMessage, stableStringify } from "../src/inventory.ts";
import type { ToolInfo } from "@earendil-works/pi-coding-agent";

function tool(name: string, parameters: unknown = { type: "object" }): ToolInfo {
	return { name, description: `${name} tool`, parameters } as ToolInfo;
}

describe("consult inventory", () => {
	it("stableStringify sorts object keys and matches JSON undefined rules", () => {
		expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
		expect(stableStringify({ a: undefined, b: 1 })).toBe('{"b":1}');
		expect(stableStringify([undefined, 1])).toBe("[null,1]");
	});

	it("caches by sorted tool-name signature", () => {
		__resetInventoryCache();
		const first = getInventoryMessage([tool("write"), tool("edit")]);
		const second = getInventoryMessage([tool("edit"), tool("write")]);
		expect(first).toBe(second);
		const third = getInventoryMessage([tool("edit"), tool("write"), tool("read")]);
		expect(third).not.toBe(first);
		__resetInventoryCache();
	});

	it("returns undefined for an empty registry", () => {
		expect(getInventoryMessage([])).toBeUndefined();
	});
});
