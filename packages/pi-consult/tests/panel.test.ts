import { describe, expect, it } from "vitest";
import { resolvePanelMembers, selectPanel } from "../src/panel.ts";
import type { Api, Model } from "@earendil-works/pi-ai";

function model(provider: string, id: string): Model<Api> {
	return { provider, id, name: id } as Model<Api>;
}

describe("consult panel", () => {
	const panel = [
		{ model: "anthropic/claude-fable-5", effort: "high" as const },
		{ model: "openai-codex/gpt-5.6-sol", effort: "medium" as const },
	];

	it("uses only the first member unless on-demand fanout is enabled", () => {
		expect(selectPanel(panel, { fanout: false, trigger: "onDemand" })).toEqual([panel[0]]);
		expect(selectPanel(panel, { fanout: true, trigger: "watchdog" })).toEqual([panel[0]]);
		expect(selectPanel(panel, { fanout: true, trigger: "onDemand" })).toEqual(panel);
	});

	it("skips missing registry models", () => {
		const resolved = resolvePanelMembers(panel, (provider, id) => {
			if (provider === "anthropic" && id === "claude-fable-5") return model(provider, id);
			return undefined;
		});
		expect(resolved.map((member) => member.label)).toEqual(["anthropic/claude-fable-5"]);
	});
});
