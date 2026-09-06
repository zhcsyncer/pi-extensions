import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { describe, expect, it, vi } from "vitest";
import { applyConsultSetting, registerConsultCommand } from "../src/command.ts";
import { DEFAULT_CONSULT_CONFIG } from "../src/config.ts";
import { NONE_VALUE, OFF_VALUE } from "../src/messages.ts";
import { ConsultTracker } from "../src/tracker.ts";

describe("consult settings", () => {
	it("defaults a new advisor to high effort", () => {
		const config = applyConsultSetting(DEFAULT_CONSULT_CONFIG, "panel0", "anthropic/claude-fable-5");
		expect(config.panel).toEqual([{ model: "anthropic/claude-fable-5", effort: "high" }]);
	});

	it("clears the panel when advisor 1 is none", () => {
		const config = applyConsultSetting(
			{ ...DEFAULT_CONSULT_CONFIG, panel: [{ model: "a/b" }, { model: "c/d" }], fanout: true },
			"panel0",
			NONE_VALUE,
		);
		expect(config.panel).toEqual([]);
		expect(config.fanout).toBe(false);
	});

	it("sets advisor 2 only after advisor 1 exists", () => {
		const empty = applyConsultSetting(DEFAULT_CONSULT_CONFIG, "panel1", "x/y");
		expect(empty.panel).toEqual([]);
		const withFirst = applyConsultSetting({ ...DEFAULT_CONSULT_CONFIG, panel: [{ model: "a/b" }] }, "panel1", "x/y");
		expect(withFirst.panel).toEqual([{ model: "a/b" }, { model: "x/y" }]);
	});

	it("clears effort with off and toggles gates", () => {
		const withEffort = applyConsultSetting(
			{ ...DEFAULT_CONSULT_CONFIG, panel: [{ model: "a/b", effort: "high" }] },
			"effort0",
			OFF_VALUE,
		);
		expect(withEffort.panel[0]).toEqual({ model: "a/b" });
		expect(applyConsultSetting(DEFAULT_CONSULT_CONFIG, "watchdog", "off").gates.watchdog).toBe(0);
		expect(applyConsultSetting(DEFAULT_CONSULT_CONFIG, "watchdog", "5").gates.watchdog).toBe(5);
		expect(applyConsultSetting(DEFAULT_CONSULT_CONFIG, "fanout", "on").fanout).toBe(true);
	});

	it("opens /consult status as a temporary dashboard without notifications", async () => {
		type Handler = (args: string, ctx: ExtensionContext) => Promise<void> | void;
		type TestComponent = {
			render: (width: number) => string[];
			invalidate: () => void;
			handleInput?: (data: string) => void;
		};
		type Factory = (
			tui: { requestRender: () => void },
			theme: { fg: (color: string, text: string) => string; bold: (text: string) => string },
			keybindings: unknown,
			done: () => void,
		) => TestComponent;

		let handler: Handler | undefined;
		const pi = {
			registerCommand: (_name: string, spec: { handler: Handler }) => {
				handler = spec.handler;
			},
		} as unknown as ExtensionAPI;
		const tracker = new ConsultTracker();
		tracker.runCount = 1;
		tracker.sessionCount = 2;
		registerConsultCommand(pi, {
			getConfig: () => ({
				...DEFAULT_CONSULT_CONFIG,
				panel: [{ model: "cursor/fable-5.1", effort: "high" }],
			}),
			getRaw: () => ({}),
			setConfig: () => {},
			tracker,
			agentDir: `/tmp/pi-consult-status-missing-${process.pid}`,
			onConfigChanged: () => {},
		});

		const notify = vi.fn();
		let rendered: string[] = [];
		const ctx = {
			hasUI: true,
			ui: {
				notify,
				custom: async (factory: Factory) =>
					new Promise<void>((resolve) => {
						const component = factory(
							{ requestRender: () => {} },
							{ fg: (_color, text) => text, bold: (text) => text },
							{},
							resolve,
						);
						rendered = component.render(100);
						component.handleInput?.("q");
					}),
			},
		} as unknown as ExtensionContext;
		if (!handler) throw new Error("consult command not registered");
		await handler("status", ctx);
		expect(rendered.join("\n")).toContain("pi-consult — status");
		expect(rendered.join("\n")).toContain("2/3 run, 6/8 session");
		expect(notify).not.toHaveBeenCalled();
	});
});
