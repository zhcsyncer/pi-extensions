import { describe, expect, it } from "vitest";
import { DEFAULT_CONSULT_CONFIG } from "../src/config.ts";
import { CONSULT_TOOL_NAME } from "../src/messages.ts";
import { isConsultBlocked, reconcileConsultTool } from "../src/reconcile.ts";
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";

describe("consult reconcile", () => {
	it("blocks when the panel is empty", () => {
		expect(isConsultBlocked(DEFAULT_CONSULT_CONFIG, "anthropic/claude-sonnet-4")).toBe(true);
	});

	it("blocks disabledForModels using slash or colon keys", () => {
		const config = {
			...DEFAULT_CONSULT_CONFIG,
			panel: [{ model: "anthropic/claude-fable-5" }],
			disabledForModels: ["anthropic:claude-sonnet-4"],
		};
		expect(isConsultBlocked(config, "anthropic/claude-sonnet-4")).toBe(true);
		expect(isConsultBlocked(config, "openai/gpt-5")).toBe(false);
	});

	it("strips or restores the active tool exactly once", () => {
		let active = ["read", CONSULT_TOOL_NAME, "edit"];
		const pi = {
			getActiveTools: () => active,
			setActiveTools: (next: string[]) => {
				active = next;
			},
		} as unknown as ExtensionAPI;
		const ctx = { hasUI: false } as ExtensionContext;

		reconcileConsultTool(pi, ctx, { blocked: true });
		expect(active).toEqual(["read", "edit"]);
		reconcileConsultTool(pi, ctx, { blocked: true });
		expect(active).toEqual(["read", "edit"]);
		reconcileConsultTool(pi, ctx, { blocked: false });
		expect(active).toEqual(["read", "edit", CONSULT_TOOL_NAME]);
	});
});
